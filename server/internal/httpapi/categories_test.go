// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"slices"
	"strings"
	"testing"
)

func TestPlaceBefore(t *testing.T) {
	s := func(v string) *string { return &v }
	ids := []string{"a", "b", "c", "d"}
	cases := []struct {
		moved  string
		before *string
		want   []string
		ok     bool
	}{
		{"d", s("a"), []string{"d", "a", "b", "c"}, true},      // to the top
		{"a", nil, []string{"b", "c", "d", "a"}, true},         // to the end
		{"b", s("d"), []string{"a", "c", "b", "d"}, true},      // down
		{"c", s("c"), nil, false},                              // before itself
		{"x", s("b"), []string{"a", "x", "b", "c", "d"}, true}, // from elsewhere
		{"a", s("zz"), nil, false},
	}
	for _, c := range cases {
		got, ok := placeBefore(ids, c.moved, c.before)
		if ok != c.ok || (ok && !slices.Equal(got, c.want)) {
			t.Errorf("placeBefore(%q, %v) = %v, %v; want %v, %v", c.moved, c.before, got, ok, c.want, c.ok)
		}
	}
	if !slices.Equal(ids, []string{"a", "b", "c", "d"}) {
		t.Errorf("input changed: %v", ids)
	}
}

func TestNormaliseCategoryName(t *testing.T) {
	ok := map[string]string{
		"  Gaming  ":          "Gaming",
		"Late\tnight\n games": "Late night games",
		"Staff \u202eonly":    "Staff only",
		"🎮 Games":             "🎮 Games",
	}
	for in, want := range ok {
		if got, msg := normaliseCategoryName(in); msg != "" || got != want {
			t.Errorf("normaliseCategoryName(%q) = %q, %q; want %q", in, got, msg, want)
		}
	}
	for _, in := range []string{"", "   ", "\u202e", strings.Repeat("x", 33)} {
		if _, msg := normaliseCategoryName(in); msg == "" {
			t.Errorf("normaliseCategoryName(%q) accepted", in)
		}
	}
}
