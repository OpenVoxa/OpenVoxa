// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package password

import (
	"strings"
	"testing"
	"time"
)

func TestProblem(t *testing.T) {
	cases := []struct {
		pw, user, want string // want: "" ok, else a word in the message
	}{
		{"Short1!", "bob", "between"},
		{"Password12345", "bob", "commonly"},
		{"P@ssw0rd!2024", "bob", "commonly"},
		{"Sunshine2025!", "bob", "commonly"},
		{"Iloveyou-1234", "bob", "commonly"},
		{"Tuckilufigus2025!", "tuckilufigus", "username"},
		// Patterns the old rule caught: now the list or zxcvbn.
		{"Qwertyuiop12!", "bob", "?"},
		{"Aaaaaaaaaaa1!", "bob", "?"},
		{"abcdefgh1234", "bob", "?"},
		{"qwerty123456!", "bob", "?"},
		{"JohnSmith1985", "bob", "?"},
		// Only zxcvbn catches these.
		{"walkerwalker", "bob", "guess"},
		{"zzzzzzzzzzzzzzz", "bob", "guess"},
		{"michaeljordan", "bob", "guess"},
		{"09/05/1984abc", "bob", "guess"},
		// Accepted: no character-kind rule any more.
		{"orange piano kettle sunrise", "bob", ""},
		{"correcthorsebatterystaple", "bob", ""},
		{"Correct Horse 9!", "bob", ""},
		{"Mx7-quill-Brine", "bob", ""},
		{"Tr0mbone-Zeppelin", "bob", ""},
		{"8$-29#!x%4@1Q", "bob", ""},
		{"Ünïcödé-pässw0rd", "bob", ""},
	}
	for _, c := range cases {
		got := Problem(c.pw, c.user)
		switch {
		case c.want == "?": // common or guessable: either is fine
			if got == "" {
				t.Errorf("%q: accepted, want refused", c.pw)
			}
		case c.want == "" && got != "":
			t.Errorf("%q: refused (%s), want accepted", c.pw, got)
		case c.want != "" && !strings.Contains(got, c.want):
			t.Errorf("%q: got %q, want it to mention %q", c.pw, got, c.want)
		}
		t.Logf("%-28q -> %q", c.pw, got)
	}
}

func TestScore(t *testing.T) {
	s := Score("Password12345", "bob")
	if !s.Common || s.Score > 1 || s.Warning == "" {
		t.Errorf("common password: %+v", s)
	}
	s = Score("michaeljordan", "bob")
	if s.Score >= MinScore || !strings.Contains(s.Warning, "names") || len(s.Suggestions) == 0 {
		t.Errorf("names: %+v", s)
	}
	s = Score("orange piano kettle sunrise", "bob")
	if s.Score < MinScore || s.Warning != "" || len(s.Suggestions) != 0 {
		t.Errorf("passphrase: %+v", s)
	}
	for _, pw := range []string{"Summer2025!", "zxcvbnm,./12", "Aaaaaaaaaaa1!", "Pa$$word", "1985-04-12abc"} {
		s := Score(pw, "")
		t.Logf("%-16q -> %d %q %q", pw, s.Score, s.Warning, s.Suggestions)
	}
}

// Long repetitive input is truncated before scoring, so it stays fast.
func TestScoreLong(t *testing.T) {
	start := time.Now()
	Score(strings.Repeat("aB3$", 64), "")
	if d := time.Since(start); d > 100*time.Millisecond {
		t.Errorf("256 characters took %v", d)
	}
	t.Logf("took %v", time.Since(start))
}

func BenchmarkLoad(b *testing.B) {
	for i := 0; i < b.N; i++ {
		loadCommon()
	}
}
