// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestPublishSources(t *testing.T) {
	// LiveKit omits false and empty fields: no can_publish means
	// listen-only, no list means every source.
	p := lkParticipant{Permission: map[string]json.RawMessage{"can_publish": json.RawMessage("true")}}
	got, can := publishSources(p)
	if !can || !slices.Equal(got, allSources) {
		t.Fatalf("full grant: got %v %v", got, can)
	}
	if _, can := publishSources(lkParticipant{}); can {
		t.Fatal("missing can_publish should read as false")
	}
	p.Permission["can_publish_sources"] = json.RawMessage(`["CAMERA","SCREEN_SHARE"]`)
	if got, _ := publishSources(p); !slices.Equal(got, []string{"CAMERA", "SCREEN_SHARE"}) {
		t.Fatalf("explicit list: got %v", got)
	}
}

func TestEditSources(t *testing.T) {
	cases := []struct {
		name         string
		cur, rm, add []string
		want         []string
		changed      bool
	}{
		{"mute from full", allSources, mutedSources, nil,
			[]string{"CAMERA", "SCREEN_SHARE"}, true},
		{"mute again", []string{"CAMERA", "SCREEN_SHARE"}, mutedSources, nil,
			[]string{"CAMERA", "SCREEN_SHARE"}, false},
		{"unmute", []string{"CAMERA", "SCREEN_SHARE"}, nil, []string{"MICROPHONE", "SCREEN_SHARE_AUDIO"},
			allSources, true},
		// Share limit on a muted participant must not give the mic back,
		// and must never leave an empty list (which means "any").
		{"share limit while muted", []string{"CAMERA", "SCREEN_SHARE"},
			[]string{"SCREEN_SHARE", "SCREEN_SHARE_AUDIO"}, nil, []string{"CAMERA"}, true},
		{"empty falls back to camera", []string{"MICROPHONE"}, []string{"MICROPHONE"}, nil,
			[]string{"CAMERA"}, true},
	}
	for _, c := range cases {
		got, changed := editSources(c.cur, c.rm, c.add)
		if !slices.Equal(got, c.want) || changed != c.changed {
			t.Errorf("%s: got %v %v, want %v %v", c.name, got, changed, c.want, c.changed)
		}
	}
}
