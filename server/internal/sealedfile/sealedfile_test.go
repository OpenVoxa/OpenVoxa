// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package sealedfile

import (
	"bytes"
	"crypto/rand"
	"errors"
	"io"
	"testing"
)

func seal(t *testing.T, plain, key []byte) []byte {
	t.Helper()
	r, err := Seal(bytes.NewReader(plain), key)
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRoundTripSizes(t *testing.T) {
	key, _ := NewKey()
	for _, n := range []int{0, 1, ChunkSize - 1, ChunkSize, ChunkSize + 1, 3*ChunkSize + 77, 2 * ChunkSize} {
		plain := make([]byte, n)
		rand.Read(plain)
		sealed := seal(t, plain, key)

		if int64(len(sealed)) != SealedSize(int64(n)) {
			t.Fatalf("n=%d: sealed %d bytes, SealedSize says %d", n, len(sealed), SealedSize(int64(n)))
		}
		if got, err := PlainSize(int64(len(sealed))); err != nil || got != int64(n) {
			t.Fatalf("n=%d: PlainSize = %d, %v", n, got, err)
		}

		r, err := Open(bytes.NewReader(sealed), int64(len(sealed)), key)
		if err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		got, err := io.ReadAll(io.NewSectionReader(r, 0, r.Size()))
		if err != nil || !bytes.Equal(got, plain) {
			t.Fatalf("n=%d: read back differs (%v)", n, err)
		}
	}
}

func TestRangeReads(t *testing.T) {
	key, _ := NewKey()
	plain := make([]byte, 5*ChunkSize+123)
	rand.Read(plain)
	sealed := seal(t, plain, key)
	r, _ := Open(bytes.NewReader(sealed), int64(len(sealed)), key)

	for _, c := range [][2]int{{0, 10}, {ChunkSize - 5, 10}, {2*ChunkSize + 3, ChunkSize * 2}, {len(plain) - 4, 4}} {
		buf := make([]byte, c[1])
		n, err := r.ReadAt(buf, int64(c[0]))
		if err != nil && !errors.Is(err, io.EOF) {
			t.Fatal(err)
		}
		if !bytes.Equal(buf[:n], plain[c[0]:c[0]+n]) || n != c[1] {
			t.Fatalf("range %v: wrong bytes (n=%d)", c, n)
		}
	}
	if _, err := r.ReadAt(make([]byte, 1), int64(len(plain))); !errors.Is(err, io.EOF) {
		t.Fatalf("read past end: %v", err)
	}
}

func TestTamperingFails(t *testing.T) {
	key, _ := NewKey()
	plain := make([]byte, 2*ChunkSize+10)
	sealed := seal(t, plain, key)

	readAll := func(b []byte, k []byte) error {
		r, err := Open(bytes.NewReader(b), int64(len(b)), k)
		if err != nil {
			return err
		}
		_, err = io.ReadAll(io.NewSectionReader(r, 0, r.Size()))
		return err
	}

	flipped := append([]byte(nil), sealed...)
	flipped[ChunkSize+40] ^= 1
	if err := readAll(flipped, key); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("flipped byte: %v", err)
	}

	other, _ := NewKey()
	if err := readAll(sealed, other); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("wrong key: %v", err)
	}

	// Cutting the file at a chunk boundary drops the real last chunk; the
	// new "last" chunk was sealed as not-last, so it must not open.
	cut := sealed[:1+2*(ChunkSize+tagSize)]
	if err := readAll(cut, key); err == nil {
		t.Fatal("truncated file opened")
	}
	cut = sealed[:1+(ChunkSize+tagSize)+20]
	if err := readAll(cut, key); err == nil {
		t.Fatal("truncated mid-chunk file opened")
	}
}
