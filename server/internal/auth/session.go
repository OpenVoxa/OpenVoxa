// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"time"
)

// SessionDuration is how long a token stays valid. Long enough that people
// are not constantly logging in, short enough that a leaked token expires.
const SessionDuration = 30 * 24 * time.Hour

const sessionTokenBytes = 32

// NewSessionToken returns a token to hand the client, and the SHA-256 hash
// to store in the database. The plaintext token is never persisted, so a
// stolen database dump yields no usable sessions.
//
// SHA-256 rather than argon2 is correct here: the token is 32 bytes of
// output from a CSPRNG, so there is no low-entropy guess space to protect
// against. Password hashing is slow on purpose to defeat dictionary
// attacks; a random 256-bit token has no dictionary.
func NewSessionToken() (token string, hash []byte, err error) {
	raw := make([]byte, sessionTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("generating session token: %w", err)
	}

	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, HashSessionToken(token), nil
}

// HashSessionToken derives the lookup hash for a token presented by a client.
func HashSessionToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
