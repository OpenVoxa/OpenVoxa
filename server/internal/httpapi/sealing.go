// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"errors"
	"log/slog"

	"github.com/openvoxa/openvoxa/server/internal/keystore"
)

// Message bodies in plaintext channels are stored sealed under the
// author's key (keystore), so account deletion can destroy them in the
// database's backups as well as in the live rows. Encrypted channels are
// left alone: their bodies are MLS ciphertext the server cannot read.

// messageSealContext binds a sealed body to its channel and author, so
// bytes moved onto another row fail to open instead of appearing there.
func messageSealContext(channelID, authorID string) []byte {
	return []byte("openvoxa/message/v1\x00" + channelID + "\x00" + authorID)
}

// sealBody returns what to store for a new or edited message, and
// whether it is sealed.
func (a *API) sealBody(channelID, authorID, body string, encrypted bool) ([]byte, bool, error) {
	if encrypted {
		return []byte(body), false, nil
	}
	sealed, err := a.keys.Seal(authorID, []byte(body), messageSealContext(channelID, authorID))
	if err != nil {
		return nil, false, err
	}
	return sealed, true, nil
}

// openBody turns a stored body back into text for delivery.
//
// A body that cannot be opened is delivered empty rather than failing the
// whole history page: one damaged row should not hide a channel. Missing
// keys are expected after an account deletion (those rows are tombstones
// with no author), so only other failures are logged.
func (a *API) openBody(ctx context.Context, channelID string, authorID *string, body []byte, sealed bool) string {
	if !sealed {
		return string(body)
	}
	if authorID == nil || len(body) == 0 {
		return ""
	}
	plain, err := a.keys.Open(*authorID, body, messageSealContext(channelID, *authorID))
	if err != nil {
		if !errors.Is(err, keystore.ErrNoKey) {
			slog.ErrorContext(ctx, "opening sealed message body",
				"err", err, "channel_id", channelID, "author_id", *authorID)
		} else {
			slog.WarnContext(ctx, "sealed message body has no key",
				"channel_id", channelID, "author_id", *authorID)
		}
		return ""
	}
	return string(plain)
}

// Report copies (reports.claimed_body) are the accused's words, so they
// are sealed under the accused's key, whatever kind of channel the
// message was in: in an encrypted channel the reporter has handed the
// server the decrypted text.

func reportSealContext(accusedID string) []byte {
	return []byte("openvoxa/report/v1\x00" + accusedID)
}

// sealReport returns what to store for a report's copy of the text and
// whether it is sealed. With no accused (cannot happen for a message that
// still exists) nothing is kept.
func (a *API) sealReport(accusedID *string, claimed string) ([]byte, bool, error) {
	if accusedID == nil {
		return []byte{}, false, nil
	}
	sealed, err := a.keys.Seal(*accusedID, []byte(claimed), reportSealContext(*accusedID))
	if err != nil {
		return nil, false, err
	}
	return sealed, true, nil
}

// openReport is openBody for report copies.
func (a *API) openReport(ctx context.Context, accusedID *string, body []byte, sealed bool) string {
	if !sealed {
		return string(body)
	}
	if accusedID == nil || len(body) == 0 {
		return ""
	}
	plain, err := a.keys.Open(*accusedID, body, reportSealContext(*accusedID))
	if err != nil {
		slog.WarnContext(ctx, "opening sealed report copy", "err", err, "accused_id", *accusedID)
		return ""
	}
	return string(plain)
}

// sealBatch is how many rows the upgrade converts per round trip.
const sealBatch = 500

// SealExisting seals plaintext-channel message bodies and report copies
// written before sealing existed (crypto-shredding step S2). It runs in
// the background at startup: readers handle sealed and unsealed rows
// alike, so the server need not wait for it, and once everything is
// sealed it is one cheap query per table.
//
// Each row's UPDATE requires it still to be unsealed and unchanged, so a
// concurrent edit (which seals by itself) or deletion is never
// overwritten with the old text.
func (a *API) SealExisting(ctx context.Context) {
	messages, err := a.sealExistingMessages(ctx)
	if err != nil {
		slog.Error("sealing existing messages", "err", err, "sealed_so_far", messages)
	}
	reports, err := a.sealExistingReports(ctx)
	if err != nil {
		slog.Error("sealing existing report copies", "err", err, "sealed_so_far", reports)
	}
	files, err := a.sealExistingAttachments(ctx)
	if err != nil {
		slog.Error("sealing existing attachments", "err", err, "sealed_so_far", files)
	}
	if messages > 0 || reports > 0 || files > 0 {
		slog.Info("sealed existing plaintext",
			"messages", messages, "reports", reports, "attachments", files)
	}
}

func (a *API) sealExistingMessages(ctx context.Context) (int, error) {
	total := 0
	for {
		rows, err := a.pool.Query(ctx,
			`SELECT m.id, m.channel_id, m.author_id, m.body
			   FROM messages m
			   JOIN channels c ON c.id = m.channel_id
			  WHERE NOT m.sealed AND NOT c.encrypted
			    AND m.author_id IS NOT NULL AND NOT m.deleted
			  LIMIT $1`, sealBatch)
		if err != nil {
			return total, err
		}
		type row struct {
			id, channelID, authorID string
			body                    []byte
		}
		var batch []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.channelID, &r.authorID, &r.body); err != nil {
				rows.Close()
				return total, err
			}
			batch = append(batch, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return total, err
		}
		if len(batch) == 0 {
			return total, nil
		}

		progressed := false
		for _, r := range batch {
			sealed, err := a.keys.Seal(r.authorID, r.body, messageSealContext(r.channelID, r.authorID))
			if err != nil {
				return total, err
			}
			tag, err := a.pool.Exec(ctx,
				`UPDATE messages SET body = $2, sealed = true
				  WHERE id = $1 AND NOT sealed AND NOT deleted AND body = $3`,
				r.id, sealed, r.body)
			if err != nil {
				return total, err
			}
			if tag.RowsAffected() > 0 {
				total++
				progressed = true
			}
		}
		// Every row in the batch changed under us (edited or deleted, and
		// so no longer selected): the next query moves on regardless,
		// but stop rather than spin if nothing at all could be updated.
		if !progressed && len(batch) < sealBatch {
			return total, nil
		}
	}
}

func (a *API) sealExistingReports(ctx context.Context) (int, error) {
	total := 0
	for {
		rows, err := a.pool.Query(ctx,
			`SELECT id, accused_id, claimed_body FROM reports
			  WHERE NOT claimed_sealed AND accused_id IS NOT NULL
			  LIMIT $1`, sealBatch)
		if err != nil {
			return total, err
		}
		type row struct {
			id, accusedID string
			body          []byte
		}
		var batch []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.accusedID, &r.body); err != nil {
				rows.Close()
				return total, err
			}
			batch = append(batch, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return total, err
		}
		if len(batch) == 0 {
			return total, nil
		}

		for _, r := range batch {
			sealed, err := a.keys.Seal(r.accusedID, r.body, reportSealContext(r.accusedID))
			if err != nil {
				return total, err
			}
			// Report copies are never edited, so only the flag guards.
			tag, err := a.pool.Exec(ctx,
				`UPDATE reports SET claimed_body = $2, claimed_sealed = true
				  WHERE id = $1 AND NOT claimed_sealed`,
				r.id, sealed)
			if err != nil {
				return total, err
			}
			total += int(tag.RowsAffected())
		}
	}
}
