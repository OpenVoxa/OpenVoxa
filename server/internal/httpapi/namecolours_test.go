// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"math"
	"testing"
)

func TestContrastRatio(t *testing.T) {
	cases := []struct {
		colour string
		want   float64
	}{
		{"#ffffff", 12.63},
		{"#00ffff", 10.08},
		{"#ff00ff", 4.03},
		{"#d96932", 3.62},
		{"#333333", 1},
	}
	for _, c := range cases {
		got := contrastRatio(c.colour, nameColourBackground)
		if math.Abs(got-c.want) > 0.01 {
			t.Errorf("contrast %s = %.2f, want %.2f", c.colour, got, c.want)
		}
	}
}

func TestCheckNameColour(t *testing.T) {
	for _, ok := range []string{"#D96932", " #ff00ff ", "#00ffff", "#ffffff"} {
		if _, msg := checkNameColour(ok); msg != "" {
			t.Errorf("%q refused: %s", ok, msg)
		}
	}
	if c, msg := checkNameColour(""); c != "" || msg != "" {
		t.Errorf("empty should clear, got %q %q", c, msg)
	}
	if c, _ := checkNameColour("#ABCDEF"); c != "#abcdef" {
		t.Errorf("not lowercased: %q", c)
	}
	for _, bad := range []string{"red", "#fff", "#12345g", "#000000", "#444444", "#0000ff"} {
		if _, msg := checkNameColour(bad); msg == "" {
			t.Errorf("%q accepted", bad)
		}
	}
}
