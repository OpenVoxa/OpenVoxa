// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"strings"
	"testing"
)

func TestNormaliseStatusText(t *testing.T) {
	for in, want := range map[string]string{
		"  Playing   ranked ":   "Playing ranked",
		"two\nlines\r\nhere":    "two lines here",
		"tab\there":             "tab here",
		"bidi‮trick":            "biditrick",
		"":                      "",
		strings.Repeat("é", 60): strings.Repeat("é", 60),
	} {
		got, msg := normaliseStatusText(in)
		if msg != "" || got != want {
			t.Errorf("normaliseStatusText(%q) = %q, %q; want %q", in, got, msg, want)
		}
	}
	if _, msg := normaliseStatusText(strings.Repeat("a", 61)); msg == "" {
		t.Error("61 characters were accepted")
	}
}

func TestCheckStatusEmoji(t *testing.T) {
	for _, ok := range []string{"", "🎮", "👍🏽", "🇬🇧", "👨‍👩‍👧", "1️⃣", "#️⃣", "❤️", " 🎮 "} {
		if _, msg := checkStatusEmoji(ok); msg != "" {
			t.Errorf("checkStatusEmoji(%q) refused: %s", ok, msg)
		}
	}
	for _, bad := range []string{"a", "🎮 hi", "🎮a", "1", ":)", "🎮‮", strings.Repeat("🎮", 17)} {
		if _, msg := checkStatusEmoji(bad); msg == "" {
			t.Errorf("checkStatusEmoji(%q) accepted", bad)
		}
	}
}
