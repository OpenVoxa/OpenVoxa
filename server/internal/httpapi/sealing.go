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
