// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package password

import (
	"math/rand"
	"testing"
)

// Random passwords that pass the length and kind rules should almost
// never be refused as common or a pattern.
func TestRandomPasswordsMostlyAccepted(t *testing.T) {
	const cs = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*-_"
	r := rand.New(rand.NewSource(1))
	refused := 0
	for i := 0; i < 20000; i++ {
		b := make([]byte, 12)
		for j := range b {
			b[j] = cs[r.Intn(len(cs))]
		}
		pw := string(b)
		if len(missingKinds(pw)) > 4-RequiredKinds {
			continue
		}
		if p := Problem(pw, "someuser"); p != "" {
			refused++
			t.Log(pw, p)
		}
	}
	if refused > 10 {
		t.Errorf("%d of 20000 random passwords refused", refused)
	}
}
