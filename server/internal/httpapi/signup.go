// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/password"
)

// Who may create an account (migration 0029; decisions.md Feature
// decisions, "Server password"). Administrators pick a mode in Server
// settings, Sign-Up:
//
//   - open: anyone who reaches the page;
//   - password: the server password is needed (logging in never is);
//   - closed: no new accounts.
//
// The server password stays readable for administrators (they share it)
// and can be changed, generated or rotated at any time, or rotated
// automatically every N hours. After a scheduled rotation the previous
// one still works for an hour; a manual change or Rotate Now ends it at
// once (the leak case).
//
// Guessing it is slowed per address (signupLockout) and made pointless by
// rotation; and every address may create at most three accounts an hour
// in any mode (API.signupIP).

const (
	signupGrace        = time.Hour
	signupSweepEvery   = time.Minute
	signupMaxRotateHrs = 8760
)

// Generated passwords: 12 characters in groups of four, from an alphabet
// without look-alikes (no 0/O, 1/I/L, U), about 58 bits.
const signupAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

var generatedPattern = regexp.MustCompile(`^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$`)

func generateSignupPassword() (string, error) {
	var b strings.Builder
	max := big.NewInt(int64(len(signupAlphabet)))
	for i := 0; i < 12; i++ {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b.WriteByte(signupAlphabet[n.Int64()])
	}
	return b.String(), nil
}

// signupPasswordMatches compares in constant time. A generated password
// is also accepted typed in lowercase or without the dashes, as people
// read them out; a chosen one must match exactly.
func signupPasswordMatches(given, stored string) bool {
	if stored == "" {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(given), []byte(stored)) == 1 {
		return true
	}
	if !generatedPattern.MatchString(stored) {
		return false
	}
	norm := func(s string) string {
		return strings.Map(func(r rune) rune {
			if r == '-' || r == ' ' {
				return -1
			}
			return r
		}, strings.ToUpper(s))
	}
	return subtle.ConstantTimeCompare([]byte(norm(given)), []byte(norm(stored))) == 1
}

// ------------------------------------------------------------- lockout

// signupLockout slows guessing of the server password per address: five
// wrong guesses, then a wait of 1, 5, 15 and then 60 minutes, each wrong
// guess after a wait moving one step up. A right guess, or a day without
// wrong ones, clears it. In memory, like the rate limiters.
type signupLockout struct {
	mu   sync.Mutex
	byIP map[string]*lockState
}

type lockState struct {
	fails int
	level int
	until time.Time
	last  time.Time
}

var lockSteps = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour}

const (
	lockFreeTries = 5
	lockForget    = 24 * time.Hour
	lockMaxKeys   = 100_000
)

func newSignupLockout() *signupLockout {
	return &signupLockout{byIP: map[string]*lockState{}}
}

// wait is how long the address must still wait; 0 means it may try.
func (l *signupLockout) wait(ip string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.byIP[ip]
	if s == nil || !now.Before(s.until) {
		return 0
	}
	return s.until.Sub(now)
}

// fail records a wrong guess and returns the wait it starts, if any.
func (l *signupLockout) fail(ip string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.byIP[ip]
	if s == nil || now.Sub(s.last) > lockForget {
		if len(l.byIP) >= lockMaxKeys {
			l.evictLocked(now)
		}
		s = &lockState{level: -1}
		l.byIP[ip] = s
	}
	s.last = now
	s.fails++
	if s.level < 0 && s.fails < lockFreeTries {
		return 0
	}
	if s.level < len(lockSteps)-1 {
		s.level++
	}
	s.until = now.Add(lockSteps[s.level])
	return lockSteps[s.level]
}

func (l *signupLockout) clear(ip string) {
	l.mu.Lock()
	delete(l.byIP, ip)
	l.mu.Unlock()
}

func (l *signupLockout) evictLocked(now time.Time) {
	for k, s := range l.byIP {
		if now.Sub(s.last) > lockForget || !now.Before(s.until) {
			delete(l.byIP, k)
		}
	}
	// Still full (an attacker rotating addresses): start over rather than
	// grow without bound.
	if len(l.byIP) >= lockMaxKeys {
		l.byIP = map[string]*lockState{}
	}
}

// --------------------------------------------------- reading the state

type signupState struct {
	Mode        string
	Password    string
	Prev        string
	PrevUntil   *time.Time
	RotateHours *int
	RotatedAt   *time.Time
}

func loadSignup(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (signupState, error) {
	var s signupState
	var pw, prev *string
	err := q.QueryRow(ctx,
		`SELECT signup_mode, signup_password, signup_password_prev, signup_prev_until,
		        signup_rotate_hours, signup_rotated_at
		   FROM server_settings`).
		Scan(&s.Mode, &pw, &prev, &s.PrevUntil, &s.RotateHours, &s.RotatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return signupState{Mode: "open"}, nil
	}
	if pw != nil {
		s.Password = *pw
	}
	if prev != nil {
		s.Prev = *prev
	}
	return s, err
}

// signupAllowed decides whether a sign-up may go ahead, before the
// account is made. false means a reply was written. Not used for the
// first account on an empty server, which the setup code governs.
func (a *API) signupAllowed(w http.ResponseWriter, r *http.Request, given string) bool {
	st, err := loadSignup(r.Context(), a.pool)
	if err != nil {
		slog.Error("reading sign-up settings", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create account")
		return false
	}
	switch st.Mode {
	case "closed":
		writeError(w, http.StatusForbidden, "this server isn't accepting new accounts")
		return false
	case "password":
		ip := a.clientIP(r)
		now := time.Now()
		if d := a.signupLock.wait(ip, now); d > 0 {
			lockedOut(w, d)
			return false
		}
		ok := signupPasswordMatches(given, st.Password) ||
			(st.PrevUntil != nil && now.Before(*st.PrevUntil) && signupPasswordMatches(given, st.Prev))
		if !ok {
			d := a.signupLock.fail(ip, now)
			slog.Warn("wrong server password at sign-up", "ip", ip, "locked_for", d.String())
			if d > 0 {
				lockedOut(w, d)
			} else {
				writeError(w, http.StatusForbidden, "wrong server password")
			}
			return false
		}
		a.signupLock.clear(ip)
	}
	return true
}

// lockedOut answers a locked address, saying how long to wait.
func lockedOut(w http.ResponseWriter, d time.Duration) {
	mins := int((d + time.Minute - 1) / time.Minute)
	unit := "minutes"
	if mins == 1 {
		unit = "minute"
	}
	w.Header().Set("Retry-After", strconv.Itoa(int(d.Seconds())+1))
	writeError(w, http.StatusTooManyRequests,
		"too many wrong server passwords: try again in "+strconv.Itoa(mins)+" "+unit)
}

// signupMode is what the sign-up form needs to know (GET /api/v1/setup).
func (a *API) signupMode(ctx context.Context) string {
	st, err := loadSignup(ctx, a.pool)
	if err != nil {
		slog.Error("reading sign-up settings", "err", err)
		return "open"
	}
	return st.Mode
}

// ------------------------------------------------- administrator calls

type signupSettings struct {
	Mode        string     `json:"mode"`
	Password    string     `json:"password"`
	RotateHours int        `json:"rotate_hours"` // 0: never
	NextRotate  *time.Time `json:"next_rotation"`
	PrevUntil   *time.Time `json:"previous_valid_until"`
}

func toSettings(st signupState) signupSettings {
	out := signupSettings{Mode: st.Mode, Password: st.Password}
	if st.RotateHours != nil {
		out.RotateHours = *st.RotateHours
		if st.Mode == "password" && st.RotatedAt != nil {
			t := st.RotatedAt.Add(time.Duration(*st.RotateHours) * time.Hour)
			out.NextRotate = &t
		}
	}
	if st.PrevUntil != nil && time.Now().Before(*st.PrevUntil) {
		out.PrevUntil = st.PrevUntil
	}
	return out
}

func (a *API) writeSignupSettings(w http.ResponseWriter, r *http.Request) {
	st, err := loadSignup(r.Context(), a.pool)
	if err != nil {
		slog.Error("reading sign-up settings", "err", err)
		writeError(w, http.StatusInternalServerError, "could not read sign-up settings")
		return
	}
	writeJSON(w, http.StatusOK, toSettings(st))
}

func (a *API) getSignupSettings(w http.ResponseWriter, r *http.Request) {
	a.writeSignupSettings(w, r)
}

// putSignupSettings sets the mode and the rotation period. Switching to
// password mode without a password generates one; either change restarts
// the rotation clock.
func (a *API) putSignupSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mode        *string `json:"mode"`
		RotateHours *int    `json:"rotate_hours"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Mode != nil && *req.Mode != "open" && *req.Mode != "password" && *req.Mode != "closed" {
		writeError(w, http.StatusBadRequest, "mode must be open, password or closed")
		return
	}
	if req.RotateHours != nil && (*req.RotateHours < 0 || *req.RotateHours > signupMaxRotateHrs) {
		writeError(w, http.StatusBadRequest, "rotation must be 0 (never) to 8760 hours")
		return
	}
	ctx := r.Context()
	actor := sessionFrom(ctx).UserID
	err := a.inTx(ctx, func(tx pgx.Tx) error {
		st, err := loadSignup(ctx, tx)
		if err != nil {
			return err
		}
		if req.Mode != nil && *req.Mode != st.Mode {
			if *req.Mode == "password" && st.Password == "" {
				pw, err := generateSignupPassword()
				if err != nil {
					return err
				}
				if _, err := tx.Exec(ctx,
					`UPDATE server_settings SET signup_password = $1, signup_password_prev = NULL,
					        signup_prev_until = NULL`, pw); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx,
				`UPDATE server_settings SET signup_mode = $1, signup_rotated_at = now()`, *req.Mode); err != nil {
				return err
			}
			if err := logSignup(ctx, tx, actor, "set_signup_mode", *req.Mode); err != nil {
				return err
			}
		}
		if req.RotateHours != nil {
			var hours *int
			if *req.RotateHours > 0 {
				hours = req.RotateHours
			}
			old := 0
			if st.RotateHours != nil {
				old = *st.RotateHours
			}
			if old != *req.RotateHours {
				if _, err := tx.Exec(ctx,
					`UPDATE server_settings SET signup_rotate_hours = $1, signup_rotated_at = now()`, hours); err != nil {
					return err
				}
				detail := "never"
				if hours != nil {
					detail = rotateText(*hours)
				}
				if err := logSignup(ctx, tx, actor, "set_signup_rotation", detail); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		slog.Error("saving sign-up settings", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save sign-up settings")
		return
	}
	a.writeSignupSettings(w, r)
}

// setSignupPassword sets a chosen password ({"password": "..."}) or a
// generated one ({"generate": true}, also what Rotate Now sends). The
// old one stops working at once.
func (a *API) setSignupPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
		Generate bool   `json:"generate"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	pw := strings.TrimSpace(req.Password)
	action := "change_signup_password"
	if req.Generate {
		var err error
		if pw, err = generateSignupPassword(); err != nil {
			slog.Error("generating server password", "err", err)
			writeError(w, http.StatusInternalServerError, "could not set the server password")
			return
		}
		action = "rotate_signup_password"
	} else if msg := password.Problem(pw, ""); msg != "" {
		writeError(w, http.StatusBadRequest, strings.Replace(msg, "password", "server password", 1))
		return
	}
	ctx := r.Context()
	err := a.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`UPDATE server_settings SET signup_password = $1, signup_password_prev = NULL,
			        signup_prev_until = NULL, signup_rotated_at = now()`, pw); err != nil {
			return err
		}
		return logSignup(ctx, tx, sessionFrom(ctx).UserID, action, "")
	})
	if err != nil {
		slog.Error("setting server password", "err", err)
		writeError(w, http.StatusInternalServerError, "could not set the server password")
		return
	}
	a.writeSignupSettings(w, r)
}

func logSignup(ctx context.Context, tx pgx.Tx, actor, action, detail string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO moderation_log (actor_id, action, detail) VALUES ($1, $2, $3)`, actor, action, detail)
	return err
}

func rotateText(h int) string {
	switch {
	case h%24 == 0 && h/24 == 1:
		return "every day"
	case h%24 == 0:
		return "every " + strconv.Itoa(h/24) + " days"
	case h == 1:
		return "every hour"
	default:
		return "every " + strconv.Itoa(h) + " hours"
	}
}

func (a *API) inTx(ctx context.Context, f func(pgx.Tx) error) error {
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := f(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ------------------------------------------------------------ rotation

// StartSignupRotation rotates the server password when its period is up.
// The previous one stays valid for signupGrace. Not in the moderation
// log: a schedule would only fill it.
func (a *API) StartSignupRotation(ctx context.Context) {
	go func() {
		t := time.NewTicker(signupSweepEvery)
		defer t.Stop()
		for {
			a.rotateIfDue(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

func (a *API) rotateIfDue(ctx context.Context) {
	pw, err := generateSignupPassword()
	if err != nil {
		slog.Error("generating server password", "err", err)
		return
	}
	tag, err := a.pool.Exec(ctx,
		`UPDATE server_settings
		    SET signup_password_prev = signup_password,
		        signup_prev_until = now() + make_interval(secs => $2),
		        signup_password = $1,
		        signup_rotated_at = now()
		  WHERE signup_mode = 'password' AND signup_rotate_hours IS NOT NULL
		    AND COALESCE(signup_rotated_at, '-infinity') + make_interval(hours => signup_rotate_hours) <= now()`,
		pw, signupGrace.Seconds())
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("rotating server password", "err", err)
		}
		return
	}
	if tag.RowsAffected() > 0 {
		slog.Info("server password rotated on schedule")
	}
}
