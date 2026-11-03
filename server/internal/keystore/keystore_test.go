// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package keystore

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

const alice = "11111111-1111-4111-8111-111111111111"
const bob = "22222222-2222-4222-8222-222222222222"

func TestSealOpenRoundTrip(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := []byte("chan\x00alice")

	sealed, err := s.Seal(alice, []byte("hello"), ctx)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("hello")) {
		t.Fatal("sealed bytes contain the plaintext")
	}
	got, err := s.Open(alice, sealed, ctx)
	if err != nil || string(got) != "hello" {
		t.Fatalf("Open = %q, %v", got, err)
	}

	// Empty text seals and opens too (a message that is only files).
	sealed, _ = s.Seal(alice, nil, ctx)
	if got, err := s.Open(alice, sealed, ctx); err != nil || len(got) != 0 {
		t.Fatalf("empty: %q, %v", got, err)
	}
}

func TestWrongContextOrAccountFails(t *testing.T) {
	s, _ := Open(t.TempDir())
	sealed, _ := s.Seal(alice, []byte("hi"), []byte("a"))

	if _, err := s.Open(alice, sealed, []byte("b")); !errors.Is(err, ErrBadSealed) {
		t.Fatalf("other context: %v", err)
	}
	if _, err := s.Seal(bob, []byte("x"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(bob, sealed, []byte("a")); !errors.Is(err, ErrBadSealed) {
		t.Fatalf("other account: %v", err)
	}
	if _, err := s.Open(alice, []byte{1, 2, 3}, []byte("a")); !errors.Is(err, ErrBadSealed) {
		t.Fatalf("short input: %v", err)
	}
}

func TestKeyPersistsAndIsNotCreatedByOpen(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)

	if _, err := s.Open(alice, []byte("x"), nil); !errors.Is(err, ErrNoKey) {
		t.Fatalf("Open with no key: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, alice+".key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Open created a key")
	}

	sealed, _ := s.Seal(alice, []byte("kept"), nil)

	// A fresh process reads the same key from disk.
	s2, _ := Open(dir)
	if got, err := s2.Open(alice, sealed, nil); err != nil || string(got) != "kept" {
		t.Fatalf("after reopen: %q, %v", got, err)
	}

	// Removing the file is what shredding will do: the text is gone.
	os.Remove(filepath.Join(dir, alice+".key"))
	s3, _ := Open(dir)
	if _, err := s3.Open(alice, sealed, nil); !errors.Is(err, ErrNoKey) {
		t.Fatalf("after removing key: %v", err)
	}
}

func TestRejectsNonUUID(t *testing.T) {
	s, _ := Open(t.TempDir())
	for _, id := range []string{"", "../etc/passwd", "ABCDEFAB-1111-4111-8111-111111111111"} {
		if _, err := s.Seal(id, []byte("x"), nil); err == nil {
			t.Fatalf("accepted id %q", id)
		}
	}
}

func TestConcurrentFirstUseMakesOneKey(t *testing.T) {
	dir := t.TempDir()
	// Separate stores stand in for separate processes sharing the folder.
	var wg sync.WaitGroup
	sealed := make([][]byte, 8)
	for i := range sealed {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s, _ := Open(dir)
			sealed[i], _ = s.Seal(alice, []byte("race"), nil)
		}(i)
	}
	wg.Wait()

	s, _ := Open(dir)
	for i, b := range sealed {
		if got, err := s.Open(alice, b, nil); err != nil || string(got) != "race" {
			t.Fatalf("seal %d: %q, %v", i, got, err)
		}
	}
}
