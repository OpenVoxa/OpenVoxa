// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

// Two-factor sign-in: an authenticator app code (TOTP) after the
// password, or one of ten single-use backup codes. decisions.md, Feature
// decisions, "Planned", two-factor, and Implementation notes, server.
//
// Sign-in with two-factor on is two requests. The password (login in
// auth.go) earns a short-lived ticket held in memory here, not a
// session; the code (loginTwoFactor) turns the ticket into a session.
//
// Server settings, Security, can require two-factor for staff or for
// everyone. Accounts it covers that have none are held at the setup
// screen: requireAuth answers every request outside setup with 403 and
// code "two_factor_setup_required" (twoFactorGate), so this holds
// whatever the client does.

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/openvoxa/openvoxa/server/internal/perm"
	"github.com/openvoxa/openvoxa/server/internal/totp"
)

const (
	backupCodeCount = 10
	// No 0/o, 1/l/i: they get misread when copied off paper.
	backupAlphabet = "23456789abcdefghjkmnpqrstuvwxyz"
	// How long the password half of a sign-in waits for its code, and
	// how many wrong codes it takes before starting again.
	pendingLoginTTL      = 5 * time.Minute
	pendingLoginAttempts = 5
	// The issuer shown in authenticator apps.
	totpIssuer = "OpenVoxa"
)

func totpSealContext(userID string) []byte {
	return []byte("openvoxa/totp/v1\x00" + userID)
}

func backupSealContext(userID string) []byte {
	return []byte("openvoxa/totp-backup/v1\x00" + userID)
}

// ---- Pending sign-ins (password done, code not yet) ----

type pendingLogin struct {
	userID, username, deviceName string
	expires                      time.Time
	attempts                     int
}

type pendingLogins struct {
	mu      sync.Mutex
	entries map[string]*pendingLogin
}

func newPendingLogins() *pendingLogins {
	return &pendingLogins{entries: make(map[string]*pendingLogin)}
}

func (p *pendingLogins) issue(userID, username, deviceName string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	ticket := hex.EncodeToString(raw)
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for k, e := range p.entries {
		if now.After(e.expires) {
			delete(p.entries, k)
		}
	}
	p.entries[ticket] = &pendingLogin{userID: userID, username: username,
		deviceName: deviceName, expires: now.Add(pendingLoginTTL)}
	return ticket, nil
}

// get returns a copy of a live ticket.
func (p *pendingLogins) get(ticket string) (pendingLogin, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.entries[ticket]
	if !ok || time.Now().After(e.expires) {
		delete(p.entries, ticket)
		return pendingLogin{}, false
	}
	return *e, true
}

// fail counts a wrong code; the ticket ends after pendingLoginAttempts.
func (p *pendingLogins) fail(ticket string) (ended bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.entries[ticket]
	if !ok {
		return true
	}
	e.attempts++
	if e.attempts >= pendingLoginAttempts {
		delete(p.entries, ticket)
		return true
	}
	return false
}

func (p *pendingLogins) drop(ticket string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.entries, ticket)
}

// ---- Backup codes ----

func newBackupCodes() ([]string, error) {
	codes := make([]string, backupCodeCount)
	max := big.NewInt(int64(len(backupAlphabet)))
	for i := range codes {
		var b strings.Builder
		for j := 0; j < 8; j++ {
			if j == 4 {
				b.WriteByte('-')
			}
			n, err := rand.Int(rand.Reader, max)
			if err != nil {
				return nil, err
			}
			b.WriteByte(backupAlphabet[n.Int64()])
		}
		codes[i] = b.String()
	}
	return codes, nil
}

// normalizeBackup is a backup code as stored: lowercase, no dash.
func normalizeBackup(code string) string {
	return strings.ToLower(totp.Normalize(code))
}

func (a *API) sealBackupCodes(userID string, codes []string) ([]byte, error) {
	norm := make([]string, len(codes))
	for i, c := range codes {
		norm[i] = normalizeBackup(c)
	}
	plain, err := json.Marshal(norm)
	if err != nil {
		return nil, err
	}
	return a.keys.Seal(userID, plain, backupSealContext(userID))
}

// ---- Checking a code ----

var errNoTwoFactor = errors.New("two-factor is not on for this account")

// checkSecondFactor checks an authenticator code or, failing that, a
// backup code, inside tx (it locks the account's row). A used code is
// spent: the authenticator step is remembered, a backup code removed.
func (a *API) checkSecondFactor(ctx context.Context, tx pgx.Tx, userID, code string) (ok bool, err error) {
	var sealed, backup []byte
	var enabled bool
	var lastStep int64
	err = tx.QueryRow(ctx,
		`SELECT totp_secret, totp_enabled_at IS NOT NULL, totp_last_step, totp_backup
		   FROM users WHERE id = $1 FOR UPDATE`, userID,
	).Scan(&sealed, &enabled, &lastStep, &backup)
	if err != nil {
		return false, err
	}
	if !enabled {
		return false, errNoTwoFactor
	}

	if norm := totp.Normalize(code); len(norm) == totp.Digits {
		secret, err := a.keys.Open(userID, sealed, totpSealContext(userID))
		if err != nil {
			return false, err
		}
		step, ok := totp.Check(secret, norm, time.Now(), lastStep)
		if !ok {
			return false, nil
		}
		_, err = tx.Exec(ctx, `UPDATE users SET totp_last_step = $2 WHERE id = $1`, userID, step)
		return err == nil, err
	}

	if backup == nil {
		return false, nil
	}
	plain, err := a.keys.Open(userID, backup, backupSealContext(userID))
	if err != nil {
		return false, err
	}
	var codes []string
	if err := json.Unmarshal(plain, &codes); err != nil {
		return false, err
	}
	want := normalizeBackup(code)
	match := -1
	for i, c := range codes {
		// Every entry is compared, so timing says nothing about which.
		if subtle.ConstantTimeCompare([]byte(c), []byte(want)) == 1 {
			match = i
		}
	}
	if match < 0 {
		return false, nil
	}
	codes = append(codes[:match], codes[match+1:]...)
	resealed, err := a.sealBackupCodes(userID, codes)
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `UPDATE users SET totp_backup = $2 WHERE id = $1`, userID, resealed)
	return err == nil, err
}

// ---- Who must have it ----

// twoFactorSetupNeeded: the server requires two-factor for this account
// (by policy and its switches) and it has none.
func (a *API) twoFactorSetupNeeded(ctx context.Context, userID string) (bool, error) {
	var enabled bool
	var policy string
	var perms []string
	err := a.pool.QueryRow(ctx,
		`SELECT u.totp_enabled_at IS NOT NULL,
		        (SELECT two_factor_required FROM server_settings),
		        `+userPermsSQL+`
		   FROM users u WHERE u.id = $1`, userID,
	).Scan(&enabled, &policy, &perms, new(int))
	if err != nil {
		return false, err
	}
	return !enabled && policyCovers(policy, perm.NewSet(perms)), nil
}

func policyCovers(policy string, perms perm.Set) bool {
	return policy == "everyone" || (policy == "staff" && perms.Staff())
}

// twoFactorSetupPaths are what an account held at the setup screen may
// still use: enough to load the app, unlock storage, set up, or leave.
func twoFactorSetupAllowed(r *http.Request) bool {
	p := r.URL.Path
	return (r.Method == http.MethodGet && p == "/api/v1/me") ||
		p == "/api/v1/me/unlock-secret" ||
		strings.HasPrefix(p, "/api/v1/me/device-secrets") ||
		p == "/api/v1/auth/logout" ||
		strings.HasPrefix(p, "/api/v1/me/two-factor")
}

type codedError struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func writeTwoFactorSetupRequired(w http.ResponseWriter) {
	writeJSON(w, http.StatusForbidden, codedError{
		Error: "this server requires two-factor sign-in: set it up to continue",
		Code:  "two_factor_setup_required",
	})
}

// ---- Sign-in, second half ----

type loginTwoFactorRequest struct {
	Ticket string `json:"ticket"`
	Code   string `json:"code"`
}

// loginTwoFactor finishes a sign-in whose password was right.
func (a *API) loginTwoFactor(w http.ResponseWriter, r *http.Request) {
	var req loginTwoFactorRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	p, ok := a.pendingLogins.get(req.Ticket)
	if !ok {
		writeError(w, http.StatusUnauthorized, "sign-in timed out: enter your password again")
		return
	}
	// Per account, across tickets: a fresh password sign-in does not
	// earn more guesses.
	if !a.twoFactorUser.Allow(p.userID) {
		writeTooManyRequests(w, a.twoFactorUser.RetryAfter(p.userID))
		return
	}

	ok, err := a.withSecondFactor(r.Context(), p.userID, req.Code)
	switch {
	case err != nil:
		slog.Error("checking two-factor code", "err", err)
		writeError(w, http.StatusInternalServerError, "could not log in")
		return
	case !ok:
		if a.pendingLogins.fail(req.Ticket) {
			writeError(w, http.StatusUnauthorized, "too many wrong codes: enter your password again")
			return
		}
		writeError(w, http.StatusUnauthorized, "that code isn't right")
		return
	}
	a.pendingLogins.drop(req.Ticket)
	a.twoFactorUser.Reset(p.userID)
	a.issueSession(w, r, p.userID, p.username, p.deviceName)
}

// withSecondFactor runs checkSecondFactor in its own transaction.
func (a *API) withSecondFactor(ctx context.Context, userID, code string) (bool, error) {
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	ok, err := a.checkSecondFactor(ctx, tx, userID, code)
	if err != nil || !ok {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// ---- Settings, Account ----

type twoFactorStatus struct {
	Enabled bool `json:"enabled"`
	// Backup codes not yet used.
	BackupCodesLeft int `json:"backup_codes_left"`
	// The server requires it for this account (so it can't be turned off).
	Required bool `json:"required"`
}

func (a *API) getTwoFactor(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	var out twoFactorStatus
	var backup []byte
	var policy string
	if err := a.pool.QueryRow(r.Context(),
		`SELECT totp_enabled_at IS NOT NULL, totp_backup,
		        (SELECT two_factor_required FROM server_settings)
		   FROM users WHERE id = $1`, s.UserID,
	).Scan(&out.Enabled, &backup, &policy); err != nil {
		slog.Error("loading two-factor status", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load two-factor status")
		return
	}
	out.Required = policyCovers(policy, s.Perms)
	if out.Enabled && backup != nil {
		if plain, err := a.keys.Open(s.UserID, backup, backupSealContext(s.UserID)); err == nil {
			var codes []string
			if json.Unmarshal(plain, &codes) == nil {
				out.BackupCodesLeft = len(codes)
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type twoFactorSetup struct {
	// Base32, for typing into an app by hand.
	Secret string `json:"secret"`
	// otpauth:// address, for the QR code.
	URI string `json:"uri"`
}

// startTwoFactorSetup makes a new secret and keeps it pending until a
// code from it confirms the app has it (enableTwoFactor).
func (a *API) startTwoFactorSetup(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	secret, err := totp.NewSecret()
	if err != nil {
		slog.Error("making two-factor secret", "err", err)
		writeError(w, http.StatusInternalServerError, "could not start two-factor setup")
		return
	}
	sealed, err := a.keys.Seal(s.UserID, secret, totpSealContext(s.UserID))
	if err != nil {
		slog.Error("sealing two-factor secret", "err", err)
		writeError(w, http.StatusInternalServerError, "could not start two-factor setup")
		return
	}
	tag, err := a.pool.Exec(r.Context(),
		`UPDATE users SET totp_pending = $2 WHERE id = $1 AND totp_enabled_at IS NULL`,
		s.UserID, sealed)
	if err != nil {
		slog.Error("saving two-factor secret", "err", err)
		writeError(w, http.StatusInternalServerError, "could not start two-factor setup")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "two-factor is already on")
		return
	}
	account := s.Username
	if host := r.Host; host != "" {
		account += "@" + host
	}
	writeJSON(w, http.StatusOK, twoFactorSetup{
		Secret: totp.Encode(secret),
		URI:    totp.URI(secret, totpIssuer, account),
	})
}

type codeRequest struct {
	Code string `json:"code"`
}

type backupCodesResponse struct {
	BackupCodes []string `json:"backup_codes"`
}

// enableTwoFactor turns two-factor on once a code from the pending
// secret is right, and hands out the backup codes (shown once).
func (a *API) enableTwoFactor(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	var req codeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !a.twoFactorUser.Allow(s.UserID) {
		writeTooManyRequests(w, a.twoFactorUser.RetryAfter(s.UserID))
		return
	}
	const fail = "could not turn on two-factor"

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting two-factor enable", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())

	var pending []byte
	var enabled bool
	if err := tx.QueryRow(r.Context(),
		`SELECT totp_pending, totp_enabled_at IS NOT NULL FROM users WHERE id = $1 FOR UPDATE`,
		s.UserID).Scan(&pending, &enabled); err != nil {
		slog.Error("loading pending two-factor secret", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if enabled {
		writeError(w, http.StatusConflict, "two-factor is already on")
		return
	}
	if pending == nil {
		writeError(w, http.StatusConflict, "start the setup again")
		return
	}
	secret, err := a.keys.Open(s.UserID, pending, totpSealContext(s.UserID))
	if err != nil {
		slog.Error("opening pending two-factor secret", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	step, ok := totp.Check(secret, req.Code, time.Now(), 0)
	if !ok {
		writeError(w, http.StatusBadRequest,
			"that code isn't right: check the app shows OpenVoxa and your phone's clock is set automatically")
		return
	}
	codes, err := newBackupCodes()
	if err != nil {
		slog.Error("making backup codes", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	backup, err := a.sealBackupCodes(s.UserID, codes)
	if err != nil {
		slog.Error("sealing backup codes", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE users SET totp_secret = totp_pending, totp_pending = NULL,
		        totp_enabled_at = now(), totp_last_step = $2, totp_backup = $3
		  WHERE id = $1`, s.UserID, step, backup); err != nil {
		slog.Error("turning on two-factor", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing two-factor enable", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	a.twoFactorUser.Reset(s.UserID)
	slog.Info("two-factor turned on", "user_id", s.UserID)
	writeJSON(w, http.StatusOK, backupCodesResponse{BackupCodes: codes})
}

// renewBackupCodes replaces every backup code; needs a current code.
func (a *API) renewBackupCodes(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	var req codeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	a.withCodeChecked(w, r, s.UserID, req.Code, "could not make new backup codes",
		func(ctx context.Context, tx pgx.Tx) (any, error) {
			codes, err := newBackupCodes()
			if err != nil {
				return nil, err
			}
			backup, err := a.sealBackupCodes(s.UserID, codes)
			if err != nil {
				return nil, err
			}
			_, err = tx.Exec(ctx, `UPDATE users SET totp_backup = $2 WHERE id = $1`, s.UserID, backup)
			return backupCodesResponse{BackupCodes: codes}, err
		})
}

// disableTwoFactor turns it off; needs a current code, and is refused
// while the server requires it for this account.
func (a *API) disableTwoFactor(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	var req codeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	var policy string
	if err := a.pool.QueryRow(r.Context(),
		`SELECT two_factor_required FROM server_settings`).Scan(&policy); err != nil {
		slog.Error("loading two-factor policy", "err", err)
		writeError(w, http.StatusInternalServerError, "could not turn off two-factor")
		return
	}
	if policyCovers(policy, s.Perms) {
		writeError(w, http.StatusForbidden, "this server requires two-factor for your account")
		return
	}
	a.withCodeChecked(w, r, s.UserID, req.Code, "could not turn off two-factor",
		func(ctx context.Context, tx pgx.Tx) (any, error) {
			_, err := tx.Exec(ctx, clearTwoFactorSQL, s.UserID)
			if err == nil {
				slog.Info("two-factor turned off", "user_id", s.UserID)
			}
			return nil, err
		})
}

const clearTwoFactorSQL = `UPDATE users SET totp_secret = NULL, totp_pending = NULL,
        totp_enabled_at = NULL, totp_last_step = 0, totp_backup = NULL WHERE id = $1`

// withCodeChecked checks a code, then runs fn in the same transaction.
// fn's result is the response (nil: 204).
func (a *API) withCodeChecked(w http.ResponseWriter, r *http.Request, userID, code, fail string,
	fn func(context.Context, pgx.Tx) (any, error)) {
	if !a.twoFactorUser.Allow(userID) {
		writeTooManyRequests(w, a.twoFactorUser.RetryAfter(userID))
		return
	}
	ctx := r.Context()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		slog.Error("starting two-factor change", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(ctx)
	ok, err := a.checkSecondFactor(ctx, tx, userID, code)
	switch {
	case errors.Is(err, errNoTwoFactor):
		writeError(w, http.StatusConflict, "two-factor is off")
		return
	case err != nil:
		slog.Error("checking two-factor code", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	case !ok:
		writeError(w, http.StatusBadRequest, "that code isn't right")
		return
	}
	out, err := fn(ctx, tx)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		slog.Error("changing two-factor", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	a.twoFactorUser.Reset(userID)
	if out == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Administrators ----

// resetTwoFactor removes someone else's two-factor (lost phone and
// backup codes). Administrators only, on accounts below their rank; the
// host command reset-two-factor covers the rest. Logged.
func (a *API) resetTwoFactor(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	subjectID := r.PathValue("id")
	const fail = "could not remove two-factor"
	if subjectID == actor.UserID {
		writeError(w, http.StatusBadRequest, "turn off your own two-factor in Settings, Account")
		return
	}
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting two-factor reset", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())

	rank, err := subjectRank(r.Context(), tx, subjectID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "user not found")
		return
	case err != nil:
		slog.Error("loading subject for two-factor reset", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if !perm.Outranks(actor.Rank, rank) {
		writeError(w, http.StatusForbidden,
			"you can't remove two-factor from someone at or above your own rank")
		return
	}
	tag, err := tx.Exec(r.Context(), clearTwoFactorSQL+` AND totp_enabled_at IS NOT NULL`, subjectID)
	if err != nil {
		slog.Error("clearing two-factor", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "that account has no two-factor")
		return
	}
	if err := logModeration(r.Context(), tx, actor.UserID, "two_factor_reset", subjectID, ""); err != nil {
		slog.Error("recording moderation action", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing two-factor reset", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	slog.Info("two-factor removed by administrator", "actor_id", actor.UserID, "subject_id", subjectID)
	w.WriteHeader(http.StatusNoContent)
}

type securitySettings struct {
	TwoFactorRequired string `json:"two_factor_required"`
}

func (a *API) getSecuritySettings(w http.ResponseWriter, r *http.Request) {
	var out securitySettings
	if err := a.pool.QueryRow(r.Context(),
		`SELECT two_factor_required FROM server_settings`).Scan(&out.TwoFactorRequired); err != nil {
		slog.Error("loading security settings", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load security settings")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// putSecuritySettings sets who must have two-factor. Turning it on needs
// the administrator's own two-factor first (they are always covered).
// Covered accounts without it are disconnected, so their open apps
// reconnect, meet the gate and show the setup screen straight away.
func (a *API) putSecuritySettings(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	var req securitySettings
	if !decodeJSON(w, r, &req) {
		return
	}
	mode := req.TwoFactorRequired
	if mode != "off" && mode != "staff" && mode != "everyone" {
		writeError(w, http.StatusBadRequest, `two_factor_required must be "off", "staff" or "everyone"`)
		return
	}
	const fail = "could not save security settings"
	if mode != "off" {
		var mine bool
		if err := a.pool.QueryRow(r.Context(),
			`SELECT totp_enabled_at IS NOT NULL FROM users WHERE id = $1`, actor.UserID).Scan(&mine); err != nil {
			slog.Error("checking own two-factor", "err", err)
			writeError(w, http.StatusInternalServerError, fail)
			return
		}
		if !mine {
			writeError(w, http.StatusConflict, "turn on two-factor for yourself first (Settings, Account)")
			return
		}
	}

	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		slog.Error("starting security settings", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	defer tx.Rollback(r.Context())
	var old string
	if err := tx.QueryRow(r.Context(),
		`SELECT two_factor_required FROM server_settings FOR UPDATE`).Scan(&old); err != nil {
		slog.Error("loading security settings", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if old == mode {
		writeJSON(w, http.StatusOK, req)
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE server_settings SET two_factor_required = $1`, mode); err != nil {
		slog.Error("saving security settings", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO moderation_log (actor_id, action, detail) VALUES ($1, 'two_factor_policy', $2)`,
		actor.UserID, mode); err != nil {
		slog.Error("recording moderation action", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	// Who is now held at setup.
	rows, err := tx.Query(r.Context(),
		`SELECT u.id FROM users u
		  WHERE u.deleted_at IS NULL AND u.totp_enabled_at IS NULL
		    AND ($1 = 'everyone' OR ($1 = 'staff' AND EXISTS (
		          SELECT 1 FROM effective_groups eg JOIN perm_groups g ON g.id = eg.group_id
		           WHERE eg.user_id = u.id
		             AND cardinality(array_remove(g.permissions, 'direct_messages')) > 0)))`, mode)
	if err != nil {
		slog.Error("finding accounts without two-factor", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	held, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		slog.Error("finding accounts without two-factor", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Error("committing security settings", "err", err)
		writeError(w, http.StatusInternalServerError, fail)
		return
	}
	for _, id := range held {
		a.hub.DisconnectUser(id)
	}
	slog.Info("two-factor requirement changed", "actor_id", actor.UserID, "mode", mode,
		"held_at_setup", len(held))
	writeJSON(w, http.StatusOK, req)
}
