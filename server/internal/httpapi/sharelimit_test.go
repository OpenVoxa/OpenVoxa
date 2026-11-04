// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import "testing"

func TestOverShareLimit(t *testing.T) {
	limit := shareLimit{Res: 1080, FPS: 60, Kbps: 8000}
	// The 1440p60 simulcast share seen on Docker (2026-11-04).
	share1440 := lkTrack{Type: "VIDEO", Width: 2560, Height: 1440,
		Codecs: []struct {
			Layers []lkLayer `json:"layers"`
		}{{Layers: []lkLayer{
			{Width: 1280, Height: 720, Bitrate: 4200000},
			{Width: 2560, Height: 1440, Bitrate: 14000000},
		}}}}
	cases := []struct {
		name string
		t    lkTrack
		over bool
	}{
		{"audio", lkTrack{Type: "AUDIO"}, false},
		{"1440p share", share1440, true},
		{"1080p at the limit", lkTrack{Type: "VIDEO", Width: 1920, Height: 1080,
			Layers: []lkLayer{{Width: 1920, Height: 1080, Bitrate: 8000000}}}, false},
		{"portrait 1080 wide", lkTrack{Type: "VIDEO", Width: 1080, Height: 1920}, false},
		{"ultrawide 1080 high", lkTrack{Type: "VIDEO", Width: 2560, Height: 1080}, false},
		{"bitrate over", lkTrack{Type: "VIDEO", Width: 1280, Height: 720,
			Layers: []lkLayer{{Width: 1280, Height: 720, Bitrate: 9000000}}}, true},
		{"bitrate within slack", lkTrack{Type: "VIDEO", Width: 1920, Height: 1080,
			Layers: []lkLayer{{Width: 1920, Height: 1080, Bitrate: 8300000}}}, false},
		{"rounded size", lkTrack{Type: "VIDEO", Width: 1922, Height: 1082}, false},
	}
	for _, c := range cases {
		if got := overShareLimit(c.t, limit); got != c.over {
			t.Errorf("%s: over = %v, want %v", c.name, got, c.over)
		}
	}
}
