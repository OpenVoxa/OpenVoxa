// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"bytes"
	"encoding/binary"
	"errors"
)

var errStickerType = errors.New("a sticker must be a PNG, APNG, GIF or WebP image")

// stickerImage reads a sticker's real type and pixel size from its first
// bytes. The filename and the type the browser claimed are ignored: both
// come from the uploader. Anything that is not one of the four accepted
// formats is refused, SVG included (it can carry script).
//
// Only the header is read, never the whole image. The browser decodes it
// for display, inside the sandboxed, nosniff response the image route
// sends. Header parsing by hand keeps the server free of an image
// decoding dependency (Go's standard library has no WebP).
//
// APNG is a PNG with an extra chunk and is served as image/png, which
// every browser animates.
func stickerImage(b []byte) (contentType string, width, height int, err error) {
	switch {
	case len(b) >= 24 && bytes.Equal(b[:8], []byte("\x89PNG\r\n\x1a\n")) &&
		string(b[12:16]) == "IHDR":
		w := binary.BigEndian.Uint32(b[16:20])
		h := binary.BigEndian.Uint32(b[20:24])
		if w > 1<<16 || h > 1<<16 {
			return "", 0, 0, errStickerType
		}
		contentType, width, height = "image/png", int(w), int(h)

	case len(b) >= 10 && (string(b[:6]) == "GIF87a" || string(b[:6]) == "GIF89a"):
		contentType = "image/gif"
		width = int(binary.LittleEndian.Uint16(b[6:8]))
		height = int(binary.LittleEndian.Uint16(b[8:10]))

	case len(b) >= 16 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		contentType = "image/webp"
		switch string(b[12:16]) {
		case "VP8X": // extended: animation, alpha; canvas size, 24-bit, minus one
			if len(b) < 30 {
				return "", 0, 0, errStickerType
			}
			width = 1 + (int(b[24]) | int(b[25])<<8 | int(b[26])<<16)
			height = 1 + (int(b[27]) | int(b[28])<<8 | int(b[29])<<16)
		case "VP8L": // lossless: 14-bit width and height, minus one
			if len(b) < 25 || b[20] != 0x2f {
				return "", 0, 0, errStickerType
			}
			bits := binary.LittleEndian.Uint32(b[21:25])
			width = 1 + int(bits&0x3fff)
			height = 1 + int((bits>>14)&0x3fff)
		case "VP8 ": // lossy: key frame start code, then 14-bit sizes
			if len(b) < 30 || b[23] != 0x9d || b[24] != 0x01 || b[25] != 0x2a {
				return "", 0, 0, errStickerType
			}
			width = int(binary.LittleEndian.Uint16(b[26:28]) & 0x3fff)
			height = int(binary.LittleEndian.Uint16(b[28:30]) & 0x3fff)
		default:
			return "", 0, 0, errStickerType
		}

	default:
		return "", 0, 0, errStickerType
	}
	if width <= 0 || height <= 0 {
		return "", 0, 0, errStickerType
	}
	return contentType, width, height, nil
}
