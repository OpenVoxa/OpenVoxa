// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package password

import (
	"strings"
	"testing"
)

func TestProblem(t *testing.T) {
	cases := []struct {
		pw, user, want string // want: "" ok, else a word in the message
	}{
		{"Short1!", "bob", "between"},
		{"password12345", "bob", "at least 3"},
		{"Password12345", "bob", "commonly"},
		{"P@ssw0rd!2024", "bob", "commonly"},
		{"Sunshine2025!", "bob", "commonly"},
		{"Iloveyou-1234", "bob", "commonly"},
		{"Tuckilufigus2025!", "tuckilufigus", "username"},
		{"Qwertyuiop12!", "bob", ""}, // checked below: common or pattern
		{"Aaaaaaaaaaa1!", "bob", ""},
		{"Correct Horse 9!", "bob", ""},
		{"Mx7-quill-Brine", "bob", ""},
		{"Tr0mbone-Zeppelin", "bob", ""},
		{"8$-29#!x%4@1Q", "bob", ""},
		{"Ünïcödé-pässw0rd", "bob", ""}, // accents are not folded (stdlib only)
	}
	for _, c := range cases {
		got := Problem(c.pw, c.user)
		switch {
		case c.pw == "Qwertyuiop12!" || c.pw == "Aaaaaaaaaaa1!":
			if got == "" {
				t.Errorf("%q: accepted, want refused", c.pw)
			}
		case c.want == "" && got != "":
			t.Errorf("%q: refused (%s), want accepted", c.pw, got)
		case c.want != "" && !strings.Contains(got, c.want):
			t.Errorf("%q: got %q, want it to mention %q", c.pw, got, c.want)
		}
		t.Logf("%-20q -> %q", c.pw, got)
	}
}

func TestMostlyPattern(t *testing.T) {
	for pw, want := range map[string]bool{
		"qwerty123456!": true, "abcdefgh1234": true, "Zzzzzzzzzz9!": true,
		"Correct Horse 9!": false, "Mx7-quill-Brine": false,
	} {
		if got := MostlyPattern(pw); got != want {
			t.Errorf("%q: got %v", pw, got)
		}
	}
}

func BenchmarkLoad(b *testing.B) {
	for i := 0; i < b.N; i++ {
		loadCommon()
	}
}
