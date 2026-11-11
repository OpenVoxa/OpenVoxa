// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"strings"
	"testing"
)

func TestNormaliseBio(t *testing.T) {
	ok := []struct{ in, want string }{
		{"", ""},
		{"  hello  ", "hello"},
		{"a\r\nb", "a\nb"},
		{"a\tb", "a b"},
		{"a\n\n\n\nb", "a\n\nb"},
		{"a   \nb", "a\nb"},
		{"x‮y⁦z\x07", "xyz"},
		{"🎮 gamer ✨", "🎮 gamer ✨"},
		{strings.Repeat("é", bioMaxChars), strings.Repeat("é", bioMaxChars)},
		{strings.Repeat("l\n", bioMaxLines), strings.TrimSuffix(strings.Repeat("l\n", bioMaxLines), "\n")},
	}
	for _, c := range ok {
		got, msg := normaliseBio(c.in)
		if msg != "" || got != c.want {
			t.Errorf("normaliseBio(%q) = %q, %q; want %q", c.in, got, msg, c.want)
		}
	}
	bad := []string{
		strings.Repeat("a", bioMaxChars+1),
		strings.Repeat("l\n", bioMaxLines) + "l",
		"\xff",
	}
	for _, in := range bad {
		if _, msg := normaliseBio(in); msg == "" {
			t.Errorf("normaliseBio(%.20q...) accepted", in)
		}
	}
}
