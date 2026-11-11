// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/keystore"
	"github.com/openvoxa/openvoxa/server/internal/perm"
)

// Profiles (migration 0038; decisions.md Feature decisions, "User
// avatars and profiles", stage 2). Clicking a name opens a profile card:
// avatar (avatars.go), name, groups, bio, "Joined <date>" and when the
// account was last online. Everything on it is visible to everyone
// signed in to this server.
//
// The bio is sealed under the account's keystore key like the avatar, so
// deleting the account shreds it in database backups too. Moderators
// (delete_messages, only over lower ranks, like bans) can clear one,
// which goes in the moderation log.
//
// Last seen is "online now" while the account has any socket open, else
// the UTC date it last had one. Only the date is stored: a time, even a
// rounded one, would show when someone sleeps or works. Turning the
// setting off stops it being recorded and erases the stored date, and
// also hides everyone else's from you (it works both ways, so nobody can
// watch others while hiding themselves).

const (
	bioMaxChars = 300
	bioMaxLines = 8
)

// bioSealContext binds a sealed bio to its account.
func bioSealContext(userID string) []byte {
	return []byte("openvoxa/bio/v1\x00" + userID)
}

var manyNewlines = regexp.MustCompile(`\n{3,}`)

// normaliseBio tidies a bio for storage: CRLF to LF, tabs to spaces,
// other control and direction-override characters (which can make text
// display misleadingly) dropped, at most one blank line in a row, spaces
// trimmed. Returns the bio, or an error message for a 400.
func normaliseBio(s string) (string, string) {
	if !utf8.ValidString(s) {
		return "", "the bio is not valid text"
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\n':
			b.WriteRune(r)
		case r == '\t':
			b.WriteRune(' ')
		case unicode.IsControl(r),
			r >= 0x202a && r <= 0x202e, // embeddings and overrides
			r >= 0x2066 && r <= 0x2069: // isolates
		default:
			b.WriteRune(r)
		}
	}
	lines := strings.Split(b.String(), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " ")
	}
	s = strings.TrimSpace(manyNewlines.ReplaceAllString(strings.Join(lines, "\n"), "\n\n"))
	if n := utf8.RuneCountInString(s); n > bioMaxChars {
		return "", fmt.Sprintf("the bio is %d characters long; it can be at most %d", n, bioMaxChars)
	}
	if n := strings.Count(s, "\n") + 1; n > bioMaxLines {
		return "", fmt.Sprintf("the bio has %d lines; it can have at most %d", n, bioMaxLines)
	}
	return s, ""
}

// openBio unseals a stored bio; "" for none, or when the account's key is
// already gone.
func (a *API) openBio(userID string, sealed []byte) (string, error) {
	if len(sealed) == 0 {
		return "", nil
	}
	plain, err := a.keys.Open(userID, sealed, bioSealContext(userID))
	if errors.Is(err, keystore.ErrNoKey) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

type profileGroup struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type profileResponse struct {
	UserID   string          `json:"user_id"`
	Username string          `json:"username"`
	Joined   string          `json:"joined"` // YYYY-MM-DD (UTC)
	Groups   json.RawMessage `json:"groups"` // [{id, name}], most senior first; Everyone left out
	Bio      string          `json:"bio"`
	// Last seen, only when both the viewer and the subject show theirs:
	// Online, else LastSeenOn (YYYY-MM-DD, UTC), which may still be null
	// for an account that hasn't connected since profiles were added.
	LastSeenShown bool    `json:"last_seen_shown"`
	Online        bool    `json:"online"`
	LastSeenOn    *string `json:"last_seen_on"`
}

// getProfile: anyone signed in. What the profile card shows.
func (a *API) getProfile(w http.ResponseWriter, r *http.Request) {
	viewer := sessionFrom(r.Context())
	subjectID := r.PathValue("id")
	const fail = "could not load the profile"
	var (
		p                     profileResponse
		sealed                []byte
		theyShow, viewerShows bool
	)
	err := a.pool.QueryRow(r.Context(),
		`SELECT u.id, u.username, to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
		        COALESCE((SELECT json_agg(json_build_object('id', g.id, 'name', g.name)
		                            ORDER BY g.position DESC, g.name)
		                    FROM user_perm_groups ug
		                    JOIN perm_groups g ON g.id = ug.group_id
		                   WHERE ug.user_id = u.id AND NOT g.is_everyone), '[]'::json),
		        p.bio, COALESCE(p.show_last_seen, true), to_char(p.last_seen_on, 'YYYY-MM-DD'),
		        COALESCE((SELECT show_last_seen FROM user_profiles WHERE user_id = $2), true)
		   FROM users u
		   LEFT JOIN user_profiles p ON p.user_id = u.id
		  WHERE u.id = $1 AND u.deleted_at IS NULL`, subjectID, viewer.UserID,
	).Scan(&p.UserID, &p.Username, &p.Joined, &p.Groups, &sealed, &theyShow, &p.LastSeenOn, &viewerShows)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		slog.Error("loading profile", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if p.Bio, err = a.openBio(subjectID, sealed); err != nil {
		slog.Error("opening sealed bio", "err", err, "user_id", subjectID)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if theyShow && viewerShows {
		p.LastSeenShown = true
		p.Online = a.hub.Online(subjectID)
	} else {
		p.LastSeenOn = nil
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, p)
}

type ownProfile struct {
	Bio          string `json:"bio"`
	ShowLastSeen bool   `json:"show_last_seen"`
}

// getOwnProfile: the caller's own editable profile fields.
func (a *API) getOwnProfile(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	const fail = "could not load your profile"
	p := ownProfile{ShowLastSeen: true}
	var sealed []byte
	err := a.pool.QueryRow(r.Context(),
		`SELECT bio, show_last_seen FROM user_profiles WHERE user_id = $1`, session.UserID,
	).Scan(&sealed, &p.ShowLastSeen)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		slog.Error("loading own profile", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if p.Bio, err = a.openBio(session.UserID, sealed); err != nil {
		slog.Error("opening sealed bio", "err", err, "user_id", session.UserID)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, p)
}

type patchProfileRequest struct {
	Bio          *string `json:"bio"`
	ShowLastSeen *bool   `json:"show_last_seen"`
}

// patchOwnProfile changes any of the caller's own fields; absent ones are
// left alone. Returns the profile as now stored (the bio tidied).
func (a *API) patchOwnProfile(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())
	const fail = "could not save your profile"
	var req patchProfileRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Bio != nil {
		bio, msg := normaliseBio(*req.Bio)
		if msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		var sealed []byte // NULL: no bio
		if bio != "" {
			var err error
			if sealed, err = a.keys.Seal(session.UserID, []byte(bio), bioSealContext(session.UserID)); err != nil {
				slog.Error("sealing bio", "err", err)
				writeError(w, http.StatusInternalServerError, fail)
				return
			}
		}
		if _, err := a.pool.Exec(r.Context(),
			`INSERT INTO user_profiles (user_id, bio) VALUES ($1, $2)
			 ON CONFLICT (user_id) DO UPDATE SET bio = EXCLUDED.bio, updated_at = now()`,
			session.UserID, sealed); err != nil {
			slog.Error("saving bio", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
	}
	if req.ShowLastSeen != nil {
		// Off erases the stored date; on records today (the caller is
		// online right now).
		if _, err := a.pool.Exec(r.Context(),
			`INSERT INTO user_profiles (user_id, show_last_seen, last_seen_on)
			 VALUES ($1, $2, CASE WHEN $2 THEN (now() AT TIME ZONE 'UTC')::date END)
			 ON CONFLICT (user_id) DO UPDATE
			   SET show_last_seen = EXCLUDED.show_last_seen,
			       last_seen_on = EXCLUDED.last_seen_on, updated_at = now()`,
			session.UserID, *req.ShowLastSeen); err != nil {
			slog.Error("saving last seen setting", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
	}
	a.getOwnProfile(w, r)
}

// clearBio: moderators (delete_messages; the route checks) clear someone
// else's bio, logged. Only over lower ranks, as for avatars and bans.
func (a *API) clearBio(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")
	const fail = "could not clear the bio"
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting bio clear", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())

	if subjectID != actor.UserID {
		rank, err := subjectRank(r.Context(), tx, subjectID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			writeError(w, http.StatusNotFound, "user not found")
			return
		case err != nil:
			slog.Error("loading subject for bio clear", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
		if !perm.Outranks(actor.Rank, rank) {
			writeError(w, http.StatusForbidden, "you cannot clear the bio of someone at or above your own rank")
			return
		}
	}
	tag, err := tx.Exec(r.Context(),
		`UPDATE user_profiles SET bio = NULL, updated_at = now() WHERE user_id = $1 AND bio IS NOT NULL`, subjectID)
	if err != nil {
		slog.Error("clearing bio", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if tag.RowsAffected() == 0 {
		// None to clear (or already cleared by its owner or another moderator).
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if subjectID != actor.UserID {
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO moderation_log (actor_id, action, subject_id) VALUES ($1, 'clear_bio', $2)`,
			actor.UserID, subjectID); err != nil {
			slog.Error("recording moderation action", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing bio clear", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	slog.Info("bio cleared", "user_id", subjectID, "by", actor.UserID)
	w.WriteHeader(http.StatusNoContent)
}

// touchLastSeen records today (UTC) as the account's last-seen date,
// unless it has turned last seen off. Called when an events socket opens
// and closes; writes only when the date changes. Uses its own context:
// at disconnect the request's is already cancelled.
func (a *API) touchLastSeen(userID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := a.pool.Exec(ctx,
		`INSERT INTO user_profiles (user_id, last_seen_on) VALUES ($1, (now() AT TIME ZONE 'UTC')::date)
		 ON CONFLICT (user_id) DO UPDATE SET last_seen_on = EXCLUDED.last_seen_on
		  WHERE user_profiles.show_last_seen
		    AND user_profiles.last_seen_on IS DISTINCT FROM EXCLUDED.last_seen_on`,
		userID); err != nil {
		// Also when the account was deleted while connected (no user row).
		slog.Warn("recording last seen", "err", err, "user_id", userID)
	}
}
