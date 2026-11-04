// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import "testing"

func TestValidEmoji(t *testing.T) {
	good := []string{
		"👍", "👍🏽", "❤️", "❤", "🔥", "😂", "✅", "⭐", "☀️", "⬆️", "©️",
		"🇬🇧", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "1️⃣", "#️⃣", "👨‍👩‍👧‍👦", "👩🏻‍❤️‍💋‍👨🏼", "🫠", "🏳️‍🌈",
	}
	for _, s := range good {
		if !validEmoji(s) {
			t.Errorf("validEmoji(%q) = false, want true", s)
		}
	}
	bad := []string{
		"", "a", "lol", "1", "#", "👍 ", " 👍", "👍a", "<b>", "‍", "️",
		"👍👍👍👍👍👍👍👍👍👍👍", "\xff",
	}
	for _, s := range bad {
		if validEmoji(s) {
			t.Errorf("validEmoji(%q) = true, want false", s)
		}
	}
}
