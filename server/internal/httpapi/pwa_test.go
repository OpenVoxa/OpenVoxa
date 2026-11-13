// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// TestEncodeAppIcon: a 256 px icon comes out as a PNG of each manifest
// size; opaque fills the transparent corners with the app colour.
func TestEncodeAppIcon(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 256, 256))
	src.Set(128, 128, color.NRGBA{0xd9, 0x69, 0x32, 0xff})
	for size := range appIconSizes {
		for _, opaque := range []bool{false, true} {
			data, err := encodeAppIcon(src, size, opaque)
			if err != nil {
				t.Fatal(err)
			}
			img, err := png.Decode(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if b := img.Bounds(); b.Dx() != size || b.Dy() != size {
				t.Fatalf("size %d: got %v", size, b)
			}
			_, _, _, a := img.At(0, 0).RGBA()
			if opaque && a != 0xffff {
				t.Fatalf("size %d opaque: corner alpha %d", size, a)
			}
			if !opaque && a != 0 {
				t.Fatalf("size %d: corner alpha %d, want transparent", size, a)
			}
		}
	}
}
