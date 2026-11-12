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
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/keystore"
)

// Custom status (migration 0039; decisions.md Feature decisions, "User
// avatars and profiles", stage 2b). An optional emoji plus up to 60
// characters, set in Settings, Profile or from "Set Status" on your own
// profile card, shown on the card and under names in voice channels.
// Everyone signed in sees everyone's, and changes reach every socket at
// once (status_changed), like avatars.
//
// "Clear after" (1 hour, 4 hours, Today) is worked out by the browser,
// which knows the person's time zone, and sent as a time; the server
// clears the status then (StartStatusSweep) and tells everyone.
//
// Sealed under the account's keystore key like the bio. Moderators
// (delete_messages, only over lower ranks) can clear one, logged as
// clear_status (profiles.go, clearProfileField).

const (
	statusMaxChars = 60
	// An emoji can be several code points (skin tone, flags, families
	// joined by zero-width joiners); this leaves room for those and
	// nothing like a second line of text.
	statusEmojiMaxRunes = 16
	statusEmojiMaxBytes = 64
	// "Today" ends at the person's local midnight, under 24 hours away
	// (25 on a daylight-saving change); this leaves room for clocks a
	// little off.
	statusMaxClearAfter = 48 * time.Hour
	statusSweepInterval = time.Minute
)

func statusSealContext(userID string) []byte {
	return []byte("openvoxa/status/v1\x00" + userID)
}

// userStatus is what everyone sees.
type userStatus struct {
	Emoji string `json:"emoji"`
	Text  string `json:"text"`
}

type statusChangedEvent struct {
	Type   string      `json:"type"`
	UserID string      `json:"user_id"`
	Status *userStatus `json:"status"` // null: cleared
}

func (a *API) emitStatus(userID string, s *userStatus) {
	a.emitAll(statusChangedEvent{Type: "status_changed", UserID: userID, Status: s})
}

// dropsFromText reports characters never kept in a status or bio: control
// characters and the direction overrides and isolates that can make text
// display misleadingly.
func dropsFromText(r rune) bool {
	return unicode.IsControl(r) ||
		(r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069)
}

// normaliseStatusText: one line, whitespace runs to one space, dropped
// characters removed, trimmed. Returns it, or an error message for a 400.
func normaliseStatusText(s string) (string, string) {
	if !utf8.ValidString(s) {
		return "", "the status is not valid text"
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			b.WriteRune(' ')
		case dropsFromText(r):
		default:
			b.WriteRune(r)
		}
	}
	s = strings.Join(strings.Fields(b.String()), " ")
	if n := utf8.RuneCountInString(s); n > statusMaxChars {
		return "", fmt.Sprintf("the status is %d characters long; it can be at most %d", n, statusMaxChars)
	}
	return s, ""
}

// checkStatusEmoji accepts one emoji (as the picker gives it), or "".
// It can't tell every emoji from other symbols, but it keeps out letters
// and spaces, so the emoji can't carry extra text.
func checkStatusEmoji(s string) (string, string) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", ""
	}
	const bad = "the status emoji is not a single emoji"
	if !utf8.ValidString(s) || len(s) > statusEmojiMaxBytes || utf8.RuneCountInString(s) > statusEmojiMaxRunes {
		return "", bad
	}
	keycap := strings.ContainsRune(s, 0x20e3) // 1️⃣, #️⃣, *️⃣
	for _, r := range s {
		if unicode.IsSpace(r) || dropsFromText(r) || unicode.IsLetter(r) || (r < 0x80 && !keycap) {
			return "", bad
		}
	}
	return s, ""
}

// openStatus unseals a stored status; nil for none, or when the
// account's key is already gone.
func (a *API) openStatus(userID string, sealed []byte) (*userStatus, error) {
	if len(sealed) == 0 {
		return nil, nil
	}
	plain, err := a.keys.Open(userID, sealed, statusSealContext(userID))
	if errors.Is(err, keystore.ErrNoKey) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s userStatus
	if err := json.Unmarshal(plain, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// listStatuses: anyone signed in. {"users": {"<user id>": {emoji, text}}}
// for every account with a status that hasn't run out.
func (a *API) listStatuses(w http.ResponseWriter, r *http.Request) {
	const fail = "could not list the statuses"
	rows, err := a.pool.Query(r.Context(),
		`SELECT p.user_id::text, p.status FROM user_profiles p
		   JOIN users u ON u.id = p.user_id
		  WHERE p.status IS NOT NULL AND u.deleted_at IS NULL
		    AND (p.status_expires_at IS NULL OR p.status_expires_at > now())`)
	if err != nil {
		slog.Error("listing statuses", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer rows.Close()
	users := map[string]*userStatus{}
	for rows.Next() {
		var id string
		var sealed []byte
		if err := rows.Scan(&id, &sealed); err != nil {
			slog.Error("reading statuses", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
		s, err := a.openStatus(id, sealed)
		if err != nil {
			// One unreadable status shouldn't hide everyone else's.
			slog.Error("opening sealed status", "err", err, "user_id", id)
			continue
		}
		if s != nil {
			users[id] = s
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("reading statuses", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

// ownStatus is the caller's own status, with when it clears.
type ownStatus struct {
	Emoji   string     `json:"emoji"`
	Text    string     `json:"text"`
	ClearAt *time.Time `json:"clear_at"` // null: never
}

// loadOwnStatus reads the caller's status for getOwnProfile; nil if none
// or run out.
func (a *API) loadOwnStatus(userID string, sealed []byte, expires *time.Time) (*ownStatus, error) {
	if expires != nil && !expires.After(time.Now()) {
		return nil, nil
	}
	s, err := a.openStatus(userID, sealed)
	if err != nil || s == nil {
		return nil, err
	}
	return &ownStatus{Emoji: s.Emoji, Text: s.Text, ClearAt: expires}, nil
}

// setOwnStatus handles the status part of PATCH /api/v1/me/profile:
// raw is the "status" field, JSON null (or an empty status) to clear it.
// Returns false after writing an error.
func (a *API) setOwnStatus(w http.ResponseWriter, r *http.Request, userID string, raw json.RawMessage) bool {
	const fail = "could not save your status"
	var req ownStatus
	if string(raw) != "null" {
		if err := json.Unmarshal(raw, &req); err != nil {
			writeError(w, http.StatusBadRequest, "the status is not valid")
			return false
		}
	}
	text, msg := normaliseStatusText(req.Text)
	if msg == "" {
		req.Emoji, msg = checkStatusEmoji(req.Emoji)
	}
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return false
	}
	var (
		sealed  []byte // NULL: no status
		expires *time.Time
		shown   *userStatus
	)
	if text != "" || req.Emoji != "" {
		if req.ClearAt != nil {
			if d := time.Until(*req.ClearAt); d <= 0 || d > statusMaxClearAfter {
				writeError(w, http.StatusBadRequest, "the time to clear the status must be within the next two days")
				return false
			}
			expires = req.ClearAt
		}
		shown = &userStatus{Emoji: req.Emoji, Text: text}
		plain, _ := json.Marshal(shown)
		var err error
		if sealed, err = a.keys.Seal(userID, plain, statusSealContext(userID)); err != nil {
			slog.Error("sealing status", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return false
		}
	}
	if _, err := a.pool.Exec(r.Context(),
		`INSERT INTO user_profiles (user_id, status, status_expires_at) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE
		   SET status = EXCLUDED.status, status_expires_at = EXCLUDED.status_expires_at, updated_at = now()`,
		userID, sealed, expires); err != nil {
		slog.Error("saving status", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return false
	}
	a.emitStatus(userID, shown)
	return true
}

// StartStatusSweep clears statuses whose "Clear after" has passed and
// tells everyone.
func (a *API) StartStatusSweep(ctx context.Context) {
	go func() {
		t := time.NewTicker(statusSweepInterval)
		defer t.Stop()
		for {
			a.sweepStatuses(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

func (a *API) sweepStatuses(ctx context.Context) {
	rows, err := a.pool.Query(ctx,
		`UPDATE user_profiles SET status = NULL, status_expires_at = NULL, updated_at = now()
		  WHERE status_expires_at <= now() RETURNING user_id::text`)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("sweeping statuses", "err", err)
		}
		return
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		slog.Error("sweeping statuses", "err", err)
		return
	}
	for _, id := range ids {
		a.emitStatus(id, nil)
	}
}
