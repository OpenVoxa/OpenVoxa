// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"strings"
	"testing"
)

func TestBannerShape(t *testing.T) {
	for _, c := range []struct {
		w, h int
		ok   bool
	}{
		{1600, 900, true},   // 16:9
		{1600, 800, true},   // 2:1
		{1600, 533, true},   // 3:1, rounded
		{1600, 400, true},   // 4:1
		{1600, 1200, false}, // 4:3: too tall
		{1600, 1600, false}, // square
		{1600, 300, false},  // 5.3:1: too thin
		{0, 0, false},
	} {
		if got := bannerShapeOK(c.w, c.h); got != c.ok {
			t.Errorf("bannerShapeOK(%d, %d) = %v, want %v", c.w, c.h, got, c.ok)
		}
	}
}

func TestCleanHomeText(t *testing.T) {
	got, err := cleanHomeText("  Hi\r\n\tthere  \n", "rules")
	if err != nil || got != "Hi\n\tthere" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := cleanHomeText("bell\x07", "rules"); err == nil {
		t.Error("control character accepted")
	}
	if _, err := cleanHomeText(strings.Repeat("é", homeTextMax+1), "rules"); err == nil {
		t.Error("over-long text accepted")
	}
	if _, err := cleanHomeText(strings.Repeat("é", homeTextMax), "rules"); err != nil {
		t.Errorf("text at the limit refused: %v", err)
	}
}
