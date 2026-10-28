// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package auth handles password hashing and session tokens.
//
// Nothing in here is novel cryptography. It is a thin, conventional wrapper
// over golang.org/x/crypto/argon2 and crypto/rand. If you find yourself
// wanting to be clever in this file, don't.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters, following the second recommended option in RFC 9106.
// 64 MiB of memory per hash is deliberate: it is what makes offline cracking
// expensive. If registration feels slow on weak hardware, that is the cost
// working as designed.
//
// These are encoded into every hash, so raising them later does not break
// existing passwords. Old hashes keep verifying with their original
// parameters and can be upgraded on next successful login.
const (
	argonMemory  = 64 * 1024 // KiB
	argonTime    = 3
	argonThreads = 2
	argonSaltLen = 16
	argonKeyLen  = 32
)

var (
	ErrInvalidHash = errors.New("auth: malformed password hash")
	ErrMismatch    = errors.New("auth: password does not match")
)

// HashPassword returns a PHC-format string containing the parameters, salt
// and derived key. The whole string goes in users.password_hash.
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generating salt: %w", err)
	}

	key := argon2.IDKey([]byte(password), salt,
		argonTime, argonMemory, argonThreads, argonKeyLen)

	// $argon2id$v=19$m=65536,t=3,p=2$<salt>$<key>
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword reports whether password matches the given encoded hash.
// Returns ErrMismatch on a wrong password and ErrInvalidHash if the stored
// value cannot be parsed.
func VerifyPassword(password, encoded string) error {
	params, salt, want, err := decodeHash(encoded)
	if err != nil {
		return err
	}

	got := argon2.IDKey([]byte(password), salt,
		params.time, params.memory, params.threads, uint32(len(want)))

	// Constant-time: a plain == would leak how many leading bytes matched
	// through timing, which is enough to reconstruct a hash byte by byte.
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return ErrMismatch
	}
	return nil
}

type argonParams struct {
	memory  uint32
	time    uint32
	threads uint8
}

func decodeHash(encoded string) (argonParams, []byte, []byte, error) {
	var p argonParams

	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return p, nil, nil, ErrInvalidHash
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return p, nil, nil, ErrInvalidHash
	}
	if version != argon2.Version {
		return p, nil, nil, fmt.Errorf("%w: unsupported version %d", ErrInvalidHash, version)
	}

	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d",
		&p.memory, &p.time, &p.threads); err != nil {
		return p, nil, nil, ErrInvalidHash
	}

	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil {
		return p, nil, nil, ErrInvalidHash
	}
	key, err := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if err != nil {
		return p, nil, nil, ErrInvalidHash
	}

	return p, salt, key, nil
}
