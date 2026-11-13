// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"testing"
	"time"
)

func TestTypingGate(t *testing.T) {
	var g typingGate
	t0 := time.Unix(1000, 0)
	at := func(d time.Duration) time.Time { return t0.Add(d) }

	if g.allow(true, at(0)) {
		t.Fatal("a stop before any start went out")
	}
	if !g.allow(false, at(0)) {
		t.Fatal("first typing signal dropped")
	}
	if g.allow(false, at(time.Second)) {
		t.Fatal("typing signal 1 s after the last went out")
	}
	if !g.allow(false, at(3*time.Second)) {
		t.Fatal("typing signal 3 s after the last dropped")
	}
	if !g.allow(true, at(3500*time.Millisecond)) {
		t.Fatal("stop after a start dropped")
	}
	if g.allow(true, at(3600*time.Millisecond)) {
		t.Fatal("second stop in a row went out")
	}
	if !g.allow(false, at(3700*time.Millisecond)) {
		t.Fatal("typing right after a stop dropped")
	}
	g.sent()
	if g.allow(true, at(3800*time.Millisecond)) {
		t.Fatal("stop after a sent message went out")
	}
	if !g.allow(false, at(3900*time.Millisecond)) {
		t.Fatal("typing right after a sent message dropped")
	}
}
