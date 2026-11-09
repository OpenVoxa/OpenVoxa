// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"encoding/binary"
	"testing"
)

func pngChunk(typ string, data []byte) []byte {
	out := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
	out = append(out, typ...)
	out = append(out, data...)
	return append(out, 0, 0, 0, 0) // CRC, not checked
}

func TestImageAnimated(t *testing.T) {
	sig := []byte("\x89PNG\r\n\x1a\n")
	ihdr := pngChunk("IHDR", make([]byte, 13))
	png := append(append(append([]byte{}, sig...), ihdr...), pngChunk("IDAT", []byte{1, 2})...)
	apng := append(append(append(append([]byte{}, sig...), ihdr...), pngChunk("acTL", make([]byte, 8))...),
		pngChunk("IDAT", []byte{1, 2})...)
	// acTL after the first IDAT is not an animation control chunk.
	late := append(append([]byte{}, png...), pngChunk("acTL", make([]byte, 8))...)

	webp := func(flags byte) []byte {
		b := []byte("RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00")
		return append(b, flags, 0, 0, 0, 255, 0, 0, 255, 0, 0)
	}
	cases := []struct {
		name string
		b    []byte
		want bool
	}{
		{"png", png, false},
		{"apng", apng, true},
		{"acTL after IDAT", late, false},
		{"truncated png", sig, false},
		{"huge chunk length", append(append([]byte{}, sig...), 0xff, 0xff, 0xff, 0xff, 'a', 'b', 'c', 'd'), false},
		{"webp static", webp(0x10), false},
		{"webp animated", webp(0x12), true},
		{"webp lossy", []byte("RIFF\x00\x00\x00\x00WEBPVP8 \x00\x00\x00\x00\x00\x00\x00"), false},
	}
	for _, c := range cases {
		if got := imageAnimated(c.b); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
