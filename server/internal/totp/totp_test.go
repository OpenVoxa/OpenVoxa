// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package totp

import (
	"strings"
	"testing"
	"time"
)

// RFC 6238 appendix B, SHA-1 rows (8 digits).
func TestRFCVectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	for _, v := range []struct {
		unix int64
		want string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
		{20000000000, "65353130"},
	} {
		if got := codeAt(secret, StepAt(time.Unix(v.unix, 0)), 8); got != v.want {
			t.Errorf("t=%d: got %s, want %s", v.unix, got, v.want)
		}
	}
}

func TestCheckWindowAndReplay(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1234567890, 0)
	cur := StepAt(now)
	code := codeAt(secret, cur, Digits)

	step, ok := Check(secret, code[:3]+" "+code[3:], now, 0)
	if !ok || step != cur {
		t.Fatalf("current code refused: ok=%v step=%d", ok, step)
	}
	// Same code again: refused (replay).
	if _, ok := Check(secret, code, now, step); ok {
		t.Fatal("code accepted twice")
	}
	// The previous and next steps are allowed (clock drift).
	if _, ok := Check(secret, codeAt(secret, cur-1, Digits), now, 0); !ok {
		t.Error("previous step refused")
	}
	if _, ok := Check(secret, codeAt(secret, cur+1, Digits), now, 0); !ok {
		t.Error("next step refused")
	}
	// Two steps away: refused.
	if _, ok := Check(secret, codeAt(secret, cur-2, Digits), now, 0); ok {
		t.Error("code two steps old accepted")
	}
	if _, ok := Check(secret, "12345", now, 0); ok {
		t.Error("short code accepted")
	}
}

func TestURI(t *testing.T) {
	u := URI([]byte("12345678901234567890"), "OpenVoxa", "tuck@chat.example.com")
	if !strings.HasPrefix(u, "otpauth://totp/OpenVoxa:tuck@chat.example.com?") {
		t.Errorf("label: %s", u)
	}
	if !strings.Contains(u, "secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") {
		t.Errorf("secret: %s", u)
	}
}
