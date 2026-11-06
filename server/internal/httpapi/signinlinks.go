// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

// QR login (decisions.md, Feature decisions, "Planned", "QR login
// settled"). A signed-in device makes a one-time link and shows it as a
// QR code; another device opens it and asks to sign in; the first device
// approves, and the second gets a session without a password or a
// two-factor code.
//
//	signed-in device (A)                    new device (B)
//	POST /me/sign-in-links        -> id
//	shows https://host/#signin=<id>.<secret>
//	                                        POST /sign-in-links/{id}/claim
//	                                          {device_name} -> {claim}
//	GET /me/sign-in-links/{id}    -> claimed, device name
//	"Sign in as X on <device>?"
//	POST .../{id}/approve {payload}         POST /sign-in-links/{id}/status
//	  (or DELETE: deny)                       {claim} -> session, payload
//
// The secret after the dot is in the URL fragment, which browsers never
// send, so the server only ever sees the id. A encrypts the recovery
// handover (payload) under a key derived from the secret: the server
// relays it without being able to read it. The claim token ties the
// status polls to the device that claimed, so a second person opening the
// same link gets nothing.
//
// Links live in memory: a restart only cancels the ones in flight.

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/openvoxa/openvoxa/server/internal/auth"
)

const (
	// How long a link waits to be opened, and then to be approved.
	signInLinkTTL = 2 * time.Minute
	// How long an approved link waits for the new device to collect it.
	signInLinkCollectTTL = time.Minute
	// The encrypted handover: a backup id and a 32-byte key, sealed.
	// Generous, so the format can grow a little.
	signInLinkPayloadMax = 4096
)

type signInLinkState string

const (
	linkWaiting  signInLinkState = "waiting"
	linkClaimed  signInLinkState = "claimed"
	linkApproved signInLinkState = "approved"
	linkDenied   signInLinkState = "denied"
	// The new device has its session; A shows "signed in".
	linkDone signInLinkState = "done"
)

type signInLink struct {
	userID, username string
	state            signInLinkState
	expires          time.Time
	claimHash        [32]byte
	deviceName       string
	payload          []byte
	session          *sessionResponse
}

type signInLinks struct {
	mu      sync.Mutex
	entries map[string]*signInLink
}

func newSignInLinks() *signInLinks {
	return &signInLinks{entries: make(map[string]*signInLink)}
}

func randomHex(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// sweep drops expired links. Called with mu held.
func (l *signInLinks) sweep(now time.Time) {
	for k, e := range l.entries {
		if now.After(e.expires) {
			delete(l.entries, k)
		}
	}
}

// create makes a new link for the account, cancelling any earlier one it
// still had: one QR on screen at a time.
func (l *signInLinks) create(userID, username string) (string, time.Time, error) {
	id, err := randomHex(16)
	if err != nil {
		return "", time.Time{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	l.sweep(now)
	for k, e := range l.entries {
		if e.userID == userID {
			delete(l.entries, k)
		}
	}
	expires := now.Add(signInLinkTTL)
	l.entries[id] = &signInLink{userID: userID, username: username, state: linkWaiting, expires: expires}
	return id, expires, nil
}

// own returns the caller's own live link, with mu held; nil when missing.
func (l *signInLinks) own(id, userID string) *signInLink {
	l.sweep(time.Now())
	e, ok := l.entries[id]
	if !ok || e.userID != userID {
		return nil
	}
	return e
}

// ---- The signed-in device ----

type signInLinkCreated struct {
	ID        string    `json:"id"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (a *API) createSignInLink(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	id, expires, err := a.signInLinks.create(s.UserID, s.Username)
	if err != nil {
		slog.Error("creating sign-in link", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create a sign-in link")
		return
	}
	writeJSON(w, http.StatusCreated, signInLinkCreated{ID: id, ExpiresAt: expires})
}

type signInLinkView struct {
	Status     signInLinkState `json:"status"`
	DeviceName string          `json:"device_name,omitempty"`
	ExpiresAt  time.Time       `json:"expires_at"`
}

// getSignInLink is the signed-in device's poll: has anyone opened it yet?
// 404 once it has expired.
func (a *API) getSignInLink(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	l := a.signInLinks
	l.mu.Lock()
	e := l.own(r.PathValue("id"), s.UserID)
	var view signInLinkView
	if e != nil {
		view = signInLinkView{Status: e.state, DeviceName: e.deviceName, ExpiresAt: e.expires}
	}
	l.mu.Unlock()
	if e == nil {
		writeError(w, http.StatusNotFound, "this sign-in link has expired")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, view)
}

type approveSignInLinkRequest struct {
	// Sealed by the client under a key from the link's secret; opaque
	// here. Empty when this device has no backup key to hand over.
	Payload []byte `json:"payload"`
}

func (a *API) approveSignInLink(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	var req approveSignInLinkRequest
	if !decodeJSONLimit(w, r, &req, 2*signInLinkPayloadMax) {
		return
	}
	if len(req.Payload) > signInLinkPayloadMax {
		writeError(w, http.StatusRequestEntityTooLarge, "payload too large")
		return
	}

	l := a.signInLinks
	l.mu.Lock()
	e := l.own(r.PathValue("id"), s.UserID)
	if e == nil || e.state != linkClaimed {
		l.mu.Unlock()
		writeError(w, http.StatusNotFound, "this sign-in link has expired")
		return
	}
	deviceName := e.deviceName
	l.mu.Unlock()

	// Outside the lock: it talks to the database.
	session, err := a.createSession(r.Context(), s.UserID, s.Username, deviceName)
	if err != nil {
		slog.Error("creating session for sign-in link", "err", err)
		writeError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	l.mu.Lock()
	e = l.own(r.PathValue("id"), s.UserID)
	if e == nil || e.state != linkClaimed {
		l.mu.Unlock()
		// Expired or denied meanwhile: the session must not linger.
		a.dropSessionByToken(r, session.Token)
		writeError(w, http.StatusNotFound, "this sign-in link has expired")
		return
	}
	e.state = linkApproved
	e.payload = req.Payload
	e.session = &session
	e.expires = time.Now().Add(signInLinkCollectTTL)
	l.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

// dropSessionByToken deletes a session created for a link that did not
// get delivered.
func (a *API) dropSessionByToken(r *http.Request, token string) {
	if _, err := a.pool.Exec(r.Context(),
		`DELETE FROM sessions WHERE token_hash = $1`, auth.HashSessionToken(token)); err != nil {
		slog.Error("dropping undelivered session", "err", err)
	}
}

// deleteSignInLink is Deny (after someone opened it) or Cancel (closing
// the QR). A denied link stays long enough for the other device to see
// "denied" rather than a bare expiry.
func (a *API) deleteSignInLink(w http.ResponseWriter, r *http.Request) {
	s := sessionFrom(r.Context())
	l := a.signInLinks
	l.mu.Lock()
	defer l.mu.Unlock()
	id := r.PathValue("id")
	e := l.own(id, s.UserID)
	switch {
	case e == nil:
	case e.state == linkClaimed:
		e.state = linkDenied
		e.expires = time.Now().Add(signInLinkCollectTTL)
	case e.state == linkApproved:
		// Too late to deny: the session exists. Leave it to be collected.
	default:
		delete(l.entries, id)
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- The new device (not signed in) ----

type claimSignInLinkRequest struct {
	DeviceName string `json:"device_name"`
}

type claimSignInLinkResponse struct {
	Claim string `json:"claim"`
	// Shown on the new device: "Approve on your other device".
	Username string `json:"username"`
}

// claimSignInLink is the new device opening the link. The first claim
// wins; anyone after that is told it has been used.
func (a *API) claimSignInLink(w http.ResponseWriter, r *http.Request) {
	var req claimSignInLinkRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.DeviceName)
	if utf8.RuneCountInString(name) > 64 {
		name = string([]rune(name)[:64])
	}
	if name == "" {
		name = "Unknown device"
	}
	claim, err := randomHex(32)
	if err != nil {
		slog.Error("issuing sign-in link claim", "err", err)
		writeError(w, http.StatusInternalServerError, "could not open the sign-in link")
		return
	}

	l := a.signInLinks
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweep(time.Now())
	e, ok := l.entries[r.PathValue("id")]
	if !ok {
		writeError(w, http.StatusNotFound, "this sign-in link has expired: make a new one")
		return
	}
	if e.state != linkWaiting {
		writeError(w, http.StatusConflict, "this sign-in link has already been used: make a new one")
		return
	}
	e.state = linkClaimed
	e.claimHash = sha256.Sum256([]byte(claim))
	e.deviceName = name
	e.expires = time.Now().Add(signInLinkTTL)
	writeJSON(w, http.StatusOK, claimSignInLinkResponse{Claim: claim, Username: e.username})
}

type signInLinkStatusRequest struct {
	Claim string `json:"claim"`
}

type signInLinkStatusResponse struct {
	Status  signInLinkState  `json:"status"`
	Session *sessionResponse `json:"session,omitempty"`
	Payload []byte           `json:"payload,omitempty"`
}

// signInLinkStatus is the new device's poll. On approval it returns the
// session and the sealed handover once, and the link is spent.
//
// Not rate limited: it is polled every second or two, and without the
// 256-bit claim token it answers nothing.
func (a *API) signInLinkStatus(w http.ResponseWriter, r *http.Request) {
	var req signInLinkStatusRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	got := sha256.Sum256([]byte(req.Claim))

	l := a.signInLinks
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweep(time.Now())
	e, ok := l.entries[r.PathValue("id")]
	if !ok || e.state == linkWaiting || e.state == linkDone ||
		subtle.ConstantTimeCompare(got[:], e.claimHash[:]) != 1 {
		writeError(w, http.StatusNotFound, "this sign-in link has expired: make a new one")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	resp := signInLinkStatusResponse{Status: e.state}
	if e.state == linkApproved {
		resp.Session = e.session
		resp.Payload = e.payload
		// Keep a husk so the signed-in device can show "signed in".
		e.state = linkDone
		e.session = nil
		e.payload = nil
		e.expires = time.Now().Add(signInLinkCollectTTL)
	}
	writeJSON(w, http.StatusOK, resp)
}
