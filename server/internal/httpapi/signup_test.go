// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"testing"
	"time"
)

func TestGeneratedSignupPassword(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		pw, err := generateSignupPassword()
		if err != nil {
			t.Fatal(err)
		}
		if !generatedPattern.MatchString(pw) {
			t.Fatalf("%q doesn't match the generated pattern", pw)
		}
		if seen[pw] {
			t.Fatalf("repeat: %q", pw)
		}
		seen[pw] = true
	}
}

func TestSignupPasswordMatches(t *testing.T) {
	gen := "K7QD-M2XF-9PRA"
	for _, ok := range []string{gen, "k7qd-m2xf-9pra", "K7QDM2XF9PRA", "k7qd m2xf 9pra"} {
		if !signupPasswordMatches(ok, gen) {
			t.Errorf("%q should match %q", ok, gen)
		}
	}
	for _, bad := range []string{"", "K7QD-M2XF-9PRB", "K7QD-M2XF"} {
		if signupPasswordMatches(bad, gen) {
			t.Errorf("%q should not match %q", bad, gen)
		}
	}
	// A chosen password is exact, case and all.
	if signupPasswordMatches("correct horse battery", "Correct horse battery") {
		t.Error("chosen passwords must match exactly")
	}
	if signupPasswordMatches("", "") {
		t.Error("an unset password must match nothing")
	}
}

func TestSignupLockout(t *testing.T) {
	l := newSignupLockout()
	now := time.Now()
	for i := 0; i < lockFreeTries-1; i++ {
		if d := l.fail("1.2.3.4", now); d != 0 {
			t.Fatalf("guess %d locked already (%v)", i+1, d)
		}
	}
	if d := l.fail("1.2.3.4", now); d != time.Minute {
		t.Fatalf("fifth wrong guess: want 1m, got %v", d)
	}
	if l.wait("1.2.3.4", now.Add(30*time.Second)) == 0 {
		t.Fatal("should still be waiting")
	}
	if l.wait("5.6.7.8", now) != 0 {
		t.Fatal("another address must not be affected")
	}
	// Each wrong guess after a wait goes one step up, to an hour at most.
	at := now.Add(2 * time.Minute)
	for _, want := range []time.Duration{5 * time.Minute, 15 * time.Minute, time.Hour, time.Hour} {
		if d := l.fail("1.2.3.4", at); d != want {
			t.Fatalf("want %v, got %v", want, d)
		}
		at = at.Add(want + time.Second)
	}
	l.clear("1.2.3.4")
	if l.wait("1.2.3.4", at) != 0 {
		t.Fatal("a right guess clears the lockout")
	}
}
