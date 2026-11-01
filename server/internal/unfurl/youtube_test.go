// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package unfurl

import (
	"net/url"
	"testing"
)

func TestYoutubeID(t *testing.T) {
	cases := map[string]string{
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ":        "dQw4w9WgXcQ",
		"https://youtube.com/watch?v=dQw4w9WgXcQ&t=42":       "dQw4w9WgXcQ",
		"https://m.youtube.com/watch?v=dQw4w9WgXcQ":          "dQw4w9WgXcQ",
		"https://youtu.be/dQw4w9WgXcQ?si=abc":                "dQw4w9WgXcQ",
		"https://www.youtube.com/shorts/dQw4w9WgXcQ":         "dQw4w9WgXcQ",
		"https://www.youtube.com/live/dQw4w9WgXcQ?feature=x": "dQw4w9WgXcQ",
		"https://www.youtube.com/@somechannel":               "",
		"https://example.com/watch?v=dQw4w9WgXcQ":            "",
		"https://www.youtube.com/watch?v=short":              "",
	}
	for raw, want := range cases {
		u, _ := url.Parse(raw)
		if got := youtubeID(u); got != want {
			t.Errorf("youtubeID(%q) = %q, want %q", raw, got, want)
		}
	}
}
