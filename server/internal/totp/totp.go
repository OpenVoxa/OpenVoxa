// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package totp checks time-based one-time codes from authenticator apps
// (RFC 6238 over RFC 4226 HOTP), with the settings every common app
// assumes: HMAC-SHA1, 6 digits, a 30-second step. Small enough to write
// out rather than take a dependency for.
package totp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	// Step is how long one code lasts.
	Step = 30 * time.Second
	// Digits in a code.
	Digits = 6
	// SecretSize is 160 bits, the size RFC 4226 recommends for SHA-1.
	SecretSize = 20
)

// b32 is how secrets are shown and put in otpauth addresses: base32,
// no padding (some apps reject "=").
var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewSecret returns a fresh random secret.
func NewSecret() ([]byte, error) {
	s := make([]byte, SecretSize)
	if _, err := rand.Read(s); err != nil {
		return nil, fmt.Errorf("totp: generating secret: %w", err)
	}
	return s, nil
}

// Encode is the secret as people type it into an app by hand.
func Encode(secret []byte) string { return b32.EncodeToString(secret) }

// URI is the otpauth:// address the QR code carries. issuer and account
// show in the app's list, e.g. "OpenVoxa" and "tuck@chat.example.com".
func URI(secret []byte, issuer, account string) string {
	label := url.PathEscape(issuer) + ":" + url.PathEscape(account)
	q := url.Values{}
	q.Set("secret", Encode(secret))
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(Digits))
	q.Set("period", fmt.Sprint(int(Step/time.Second)))
	return "otpauth://totp/" + label + "?" + q.Encode()
}

// StepAt is the step number a time falls in.
func StepAt(t time.Time) int64 { return t.Unix() / int64(Step/time.Second) }

// codeAt is the HOTP value for one step, with the given number of digits.
func codeAt(secret []byte, step int64, digits int) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, bin%mod)
}

// Check reports whether code is right at time now, allowing one step
// either side for a phone clock that is slightly off. It only accepts a
// step later than lastStep, so a code that has been used once (or any
// older one) is refused. The step to remember next is returned.
func Check(secret []byte, code string, now time.Time, lastStep int64) (step int64, ok bool) {
	code = Normalize(code)
	if len(code) != Digits {
		return 0, false
	}
	cur := StepAt(now)
	for _, s := range []int64{cur - 1, cur, cur + 1} {
		if s <= lastStep {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(codeAt(secret, s, Digits)), []byte(code)) == 1 {
			return s, true
		}
	}
	return 0, false
}

// Normalize drops the spaces and dashes people type or paste.
func Normalize(code string) string {
	return strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' || r == '\t' {
			return -1
		}
		return r
	}, strings.TrimSpace(code))
}
