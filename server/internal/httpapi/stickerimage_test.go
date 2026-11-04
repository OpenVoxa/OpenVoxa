// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"testing"
)

func TestStickerImageRealFiles(t *testing.T) {
	img := image.NewPaletted(image.Rect(0, 0, 300, 120), color.Palette{color.Black, color.White})

	var p bytes.Buffer
	if err := png.Encode(&p, img); err != nil {
		t.Fatal(err)
	}
	var g bytes.Buffer
	if err := gif.Encode(&g, img, nil); err != nil {
		t.Fatal(err)
	}

	for name, tc := range map[string]struct {
		data []byte
		typ  string
	}{"png": {p.Bytes(), "image/png"}, "gif": {g.Bytes(), "image/gif"}} {
		typ, w, h, err := stickerImage(tc.data)
		if err != nil || typ != tc.typ || w != 300 || h != 120 {
			t.Errorf("%s: got %q %dx%d %v", name, typ, w, h, err)
		}
	}
}

func TestStickerImageWebP(t *testing.T) {
	riff := func(chunk string, body []byte) []byte {
		out := append([]byte("RIFF\x00\x00\x00\x00WEBP"), chunk...)
		out = append(out, 0, 0, 0, 0) // chunk size, unread
		return append(out, body...)
	}
	// VP8X: flags, then 24-bit width-1 and height-1 (400 x 250).
	vp8x := riff("VP8X", []byte{0x02, 0, 0, 0, 0x8f, 0x01, 0, 0xf9, 0, 0})
	// VP8L: signature, then 14 bits each (width-1 = 99, height-1 = 49).
	bits := uint32(99) | uint32(49)<<14
	vp8l := riff("VP8L", []byte{0x2f, byte(bits), byte(bits >> 8), byte(bits >> 16), byte(bits >> 24)})
	// VP8: 3-byte frame tag, start code, 14-bit width and height (64 x 32).
	vp8 := riff("VP8 ", []byte{0, 0, 0, 0x9d, 0x01, 0x2a, 64, 0, 32, 0})

	for name, tc := range map[string]struct {
		data []byte
		w, h int
	}{"vp8x": {vp8x, 400, 250}, "vp8l": {vp8l, 100, 50}, "vp8": {vp8, 64, 32}} {
		typ, w, h, err := stickerImage(tc.data)
		if err != nil || typ != "image/webp" || w != tc.w || h != tc.h {
			t.Errorf("%s: got %q %dx%d %v", name, typ, w, h, err)
		}
	}
}

func TestStickerImageRefuses(t *testing.T) {
	for name, data := range map[string][]byte{
		"svg":       []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
		"jpeg":      {0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0},
		"empty":     {},
		"short png": []byte("\x89PNG\r\n\x1a\n"),
		"zero gif":  []byte("GIF89a\x00\x00\x00\x00"),
	} {
		if _, _, _, err := stickerImage(data); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
