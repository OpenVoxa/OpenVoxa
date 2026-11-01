// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/openvoxa/openvoxa/server/internal/hub"
)

const (
	// Tickets are spent immediately after being issued, so this is short.
	ticketTTL = 30 * time.Second

	// Largest message body we accept, in runes.
	maxMessageRunes = 4000

	// Websocket frame cap. Generous next to maxMessageRunes so a legitimate
	// multibyte message always fits, tight enough to bound memory.
	wsReadLimit = 32 * 1024

	// How many messages of history a client gets on connect.
	historyLimit = 50

	// Crude per-connection flood control: this many messages per window.
	rateLimitCount  = 20
	rateLimitWindow = 10 * time.Second

	pingInterval = 30 * time.Second

	maxAttachmentsPerMessage = 10
)

// ticketStore holds single-use websocket tickets in memory.
//
// In memory is correct here rather than lazy: tickets live 30 seconds, and
// losing them on restart only means clients reconnect. Nothing durable
// should depend on them.
type ticketStore struct {
	mu      sync.Mutex
	entries map[string]ticketEntry
}

type ticketEntry struct {
	session Session
	expires time.Time
}

func newTicketStore() *ticketStore {
	return &ticketStore{entries: make(map[string]ticketEntry)}
}

func (ts *ticketStore) issue(s Session) (string, time.Time, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, err
	}
	ticket := base64.RawURLEncoding.EncodeToString(raw)
	expires := time.Now().Add(ticketTTL)

	ts.mu.Lock()
	defer ts.mu.Unlock()

	// Sweep expired entries on write so the map cannot grow without bound.
	now := time.Now()
	for k, v := range ts.entries {
		if now.After(v.expires) {
			delete(ts.entries, k)
		}
	}

	ts.entries[ticket] = ticketEntry{session: s, expires: expires}
	return ticket, expires, nil
}

// redeem consumes a ticket. A ticket is valid exactly once.
func (ts *ticketStore) redeem(ticket string) (Session, bool) {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	entry, ok := ts.entries[ticket]
	if !ok {
		return Session{}, false
	}
	delete(ts.entries, ticket)

	if time.Now().After(entry.expires) {
		return Session{}, false
	}
	return entry.session, true
}

type ticketResponse struct {
	Ticket    string    `json:"ticket"`
	ExpiresAt time.Time `json:"expires_at"`
}

// wsTicket issues a short-lived, single-use ticket for a websocket upgrade.
//
// Why not just send the session token in the query string? Because query
// strings end up in access logs, proxy logs and browser history. A ticket
// that dies in 30 seconds and works once is worth far less to anyone who
// finds it later.
func (a *API) wsTicket(w http.ResponseWriter, r *http.Request) {
	session := sessionFrom(r.Context())

	ticket, expires, err := a.tickets.issue(session)
	if err != nil {
		slog.Error("issuing websocket ticket", "err", err)
		writeError(w, http.StatusInternalServerError, "could not issue ticket")
		return
	}

	writeJSON(w, http.StatusOK, ticketResponse{Ticket: ticket, ExpiresAt: expires})
}

// Wire format. Client sends {"type":"send","body":"..."}; everything else
// flows server to client.
type clientFrame struct {
	Type string `json:"type"`
	Body string `json:"body"`

	// IDs returned by the attachment upload endpoint. Claimed when the
	// message is sent; the server verifies each one belongs to this
	// uploader, in this channel, and is not already attached elsewhere.
	Attachments []string `json:"attachments"`

	// Optional client-chosen tag, echoed on the resulting message (and on
	// an error about this frame). The sender uses it to pair its own
	// echo with what it sent: in an encrypted channel the sender cannot
	// decrypt its own message, so it has to know which plaintext the echo
	// belongs to. Opaque here; capped so it cannot bloat broadcasts.
	Ref string `json:"ref"`
}

// maxRefLength caps clientFrame.Ref.
const maxRefLength = 64

type messageFrame struct {
	Type      string    `json:"type"`
	ID        string    `json:"id"`
	ChannelID string    `json:"channel_id"`
	AuthorID  string    `json:"author_id"`
	Username  string    `json:"username"`
	Body      string    `json:"body"`
	Deleted   bool      `json:"deleted"`
	CreatedAt time.Time `json:"created_at"`
	// Set once the author has edited the message; see migration 0016.
	EditedAt *time.Time `json:"edited_at,omitempty"`
	// The sender's clientFrame.Ref, on live messages only.
	Ref string `json:"ref,omitempty"`

	Attachments []attachmentInfo `json:"attachments,omitempty"`
}

type historyFrame struct {
	Type     string         `json:"type"`
	Messages []messageFrame `json:"messages"`
	CanPost  bool           `json:"can_post"`
	// More, older messages exist; fetch them with GET
	// /channels/{id}/messages?before=<oldest id>.
	HasMore bool `json:"has_more"`
}

type errorFrame struct {
	Type  string `json:"type"`
	Error string `json:"error"`
	// The Ref of the frame this error is about, when it had one.
	Ref string `json:"ref,omitempty"`
}

func (a *API) websocket(w http.ResponseWriter, r *http.Request) {
	ticket := r.URL.Query().Get("ticket")
	channelID := r.URL.Query().Get("channel")

	session, ok := a.tickets.redeem(ticket)
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid or expired ticket")
		return
	}

	// No channel: an event socket. It carries only server-wide events
	// (perms_changed, channel_changed, access_changed, ...), so a client
	// hears about a change to its access while no channel is open,
	// including right after losing the one it had.
	if channelID == "" {
		a.eventSocket(w, r, session)
		return
	}

	// Confirm the channel exists, is a text channel, and that this caller
	// may view it. The permission check happens before the upgrade so a
	// refusal is a plain HTTP error the client can read.
	p, err := a.channelPermsFor(r.Context(), session, channelID)
	switch {
	case errors.Is(err, errChannelNotFound):
		// 404 rather than 403: a channel you cannot see should not be
		// confirmed to exist.
		writeError(w, http.StatusNotFound, "channel not found")
		return
	case err != nil:
		slog.Error("checking channel access", "err", err, "channel_id", channelID)
		writeError(w, http.StatusInternalServerError, "could not open channel")
		return
	case p.Kind != "text":
		writeError(w, http.StatusBadRequest, "not a text channel")
		return
	}
	canPost := p.CanPost

	// OriginPatterns is empty, so coder/websocket enforces same-origin. The
	// desktop client will need an explicit allowance here later; leaving it
	// strict now means we notice rather than silently accepting anyone.
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		slog.Warn("websocket upgrade failed", "err", err)
		return
	}
	defer conn.CloseNow()

	conn.SetReadLimit(wsReadLimit)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	client := hub.NewClient(session.UserID)
	a.hub.Subscribe(channelID, client)
	defer a.hub.Unsubscribe(channelID, client)

	go writePump(ctx, cancel, conn, client)

	if err := a.sendHistory(ctx, client, channelID, canPost); err != nil {
		slog.Error("loading history", "err", err)
	}

	var windowStart time.Time
	var windowCount int

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			// Normal disconnects land here too; not worth logging as errors.
			return
		}

		var frame clientFrame
		if err := json.Unmarshal(data, &frame); err != nil {
			sendFrame(ctx, client, errorFrame{Type: "error", Error: "invalid JSON"})
			continue
		}
		if frame.Type != "send" {
			sendFrame(ctx, client, errorFrame{Type: "error", Error: "unknown frame type", Ref: frame.Ref})
			continue
		}

		// Checked per message, not just at connect. A read-only connection
		// stays read-only for its whole life.
		if !canPost {
			sendFrame(ctx, client, errorFrame{
				Type:  "error",
				Error: "you do not have permission to post in this channel",
				Ref:   frame.Ref,
			})
			continue
		}

		if now := time.Now(); now.Sub(windowStart) > rateLimitWindow {
			windowStart, windowCount = now, 0
		}
		windowCount++
		if windowCount > rateLimitCount {
			sendFrame(ctx, client, errorFrame{Type: "error", Error: "slow down", Ref: frame.Ref})
			continue
		}

		// A message carrying files may have no text, but something has
		// to be there.
		n := utf8.RuneCountInString(frame.Body)
		if n > maxMessageRunes {
			sendFrame(ctx, client, errorFrame{
				Type:  "error",
				Error: "message must be at most 4000 characters",
				Ref:   frame.Ref,
			})
			continue
		}
		if n == 0 && len(frame.Attachments) == 0 {
			sendFrame(ctx, client, errorFrame{Type: "error", Error: "message is empty", Ref: frame.Ref})
			continue
		}
		if len(frame.Attachments) > maxAttachmentsPerMessage {
			sendFrame(ctx, client, errorFrame{
				Type:  "error",
				Error: "too many attachments on one message",
				Ref:   frame.Ref,
			})
			continue
		}

		if len(frame.Ref) > maxRefLength {
			sendFrame(ctx, client, errorFrame{Type: "error", Error: "ref is too long"})
			continue
		}

		if err := a.persistAndBroadcast(ctx, session, channelID, frame.Body, frame.Attachments, frame.Ref); err != nil {
			slog.Error("persisting message", "err", err)
			sendFrame(ctx, client, errorFrame{Type: "error", Error: "could not send message", Ref: frame.Ref})
		}
	}
}

func (a *API) persistAndBroadcast(ctx context.Context, s Session, channelID, body string, attachmentIDs []string, ref string) error {
	var out messageFrame

	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// body is written as BYTEA. Today that is plain UTF-8; in an encrypted
	// channel the same column will hold MLS ciphertext and the server will
	// not be able to read it.
	err = tx.QueryRow(ctx,
		`INSERT INTO messages (channel_id, author_id, body)
		 VALUES ($1, $2, $3)
		 RETURNING id, created_at`,
		channelID, s.UserID, []byte(body),
	).Scan(&out.ID, &out.CreatedAt)
	if err != nil {
		return err
	}

	if len(attachmentIDs) > 0 {
		// The WHERE clause is the authorisation check: an attachment can
		// only be claimed by the account that uploaded it, in the channel
		// it was uploaded to, and only once. Anything that fails those
		// conditions simply does not match and is silently not attached,
		// so a client cannot steal someone else's upload by guessing an
		// ID.
		rows, qerr := tx.Query(ctx,
			`UPDATE attachments
			    SET message_id = $1
			  WHERE id = ANY($2::uuid[])
			    AND channel_id = $3
			    AND uploader_id = $4
			    AND message_id IS NULL
			  RETURNING id, filename, content_type, size`,
			out.ID, attachmentIDs, channelID, s.UserID)
		if qerr != nil {
			return qerr
		}

		for rows.Next() {
			var info attachmentInfo
			if serr := rows.Scan(&info.ID, &info.Filename, &info.ContentType, &info.Size); serr != nil {
				rows.Close()
				return serr
			}
			info.URL = a.signAttachmentURL(info.ID)
			out.Attachments = append(out.Attachments, info)
		}
		rows.Close()
		if rerr := rows.Err(); rerr != nil {
			return rerr
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	out.Type = "message"
	out.ChannelID = channelID
	out.AuthorID = s.UserID
	out.Username = s.Username
	out.Body = body
	out.Ref = ref

	payload, err := json.Marshal(out)
	if err != nil {
		return err
	}

	a.hub.Broadcast(channelID, payload)
	a.notifyActivity(channelID, out.ID, s.UserID, out.CreatedAt)
	return nil
}

func (a *API) sendHistory(ctx context.Context, client *hub.Client, channelID string, canPost bool) error {
	messages, hasMore, err := a.loadMessages(ctx, channelID, nil, historyLimit)
	if err != nil {
		return err
	}
	sendFrame(ctx, client, historyFrame{
		Type: "history", Messages: messages, CanPost: canPost, HasMore: hasMore,
	})
	return nil
}

func sendFrame(ctx context.Context, client *hub.Client, v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		slog.Error("marshalling frame", "err", err)
		return
	}
	select {
	case client.Send <- payload:
	case <-ctx.Done():
	default:
		slog.Warn("dropping frame for stalled client")
	}
}

// Writer goroutine. Everything the client receives goes through here,
// so there is exactly one writer and no need to lock the connection.
func writePump(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, client *hub.Client) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case payload, open := <-client.Send:
			if !open {
				// The hub closed this connection, which happens when
				// the account is banned or deleted. Cancelling
				// unblocks the read loop below so the handler returns
				// and the socket is actually closed, rather than
				// sitting there still accepting messages.
				cancel()
				return
			}
			if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
				cancel()
				return
			}
		case <-ticker.C:
			// Detects connections that died without a close frame,
			// which is most of them in practice.
			if err := conn.Ping(ctx); err != nil {
				cancel()
				return
			}
		}
	}
}

// eventSocket serves a websocket with no channel: server-wide events
// only. Nothing the client sends is acted on.
func (a *API) eventSocket(w http.ResponseWriter, r *http.Request, session Session) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		slog.Warn("websocket upgrade failed", "err", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1024)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	client := hub.NewClient(session.UserID)
	a.hub.SubscribeEvents(client)
	defer a.hub.Unsubscribe("", client)

	go writePump(ctx, cancel, conn, client)

	for {
		if _, _, err := conn.Read(ctx); err != nil {
			return
		}
	}
}
