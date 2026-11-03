// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package keystore

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// kek is a fixed 32-byte key-encryption key for the wrapping tests.
var kek = bytes.Repeat([]byte{0x5a}, 32)

const alice = "11111111-1111-4111-8111-111111111111"
const bob = "22222222-2222-4222-8222-222222222222"

func TestSealOpenRoundTrip(t *testing.T) {
	s, err := Open(t.TempDir(), nil)
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
	s, _ := Open(t.TempDir(), nil)
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
	s, _ := Open(dir, nil)

	if _, err := s.Open(alice, []byte("x"), nil); !errors.Is(err, ErrNoKey) {
		t.Fatalf("Open with no key: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, alice+".key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Open created a key")
	}

	sealed, _ := s.Seal(alice, []byte("kept"), nil)

	// A fresh process reads the same key from disk.
	s2, _ := Open(dir, nil)
	if got, err := s2.Open(alice, sealed, nil); err != nil || string(got) != "kept" {
		t.Fatalf("after reopen: %q, %v", got, err)
	}

	// Removing the file is what shredding will do: the text is gone.
	os.Remove(filepath.Join(dir, alice+".key"))
	s3, _ := Open(dir, nil)
	if _, err := s3.Open(alice, sealed, nil); !errors.Is(err, ErrNoKey) {
		t.Fatalf("after removing key: %v", err)
	}
}

func TestRejectsNonUUID(t *testing.T) {
	s, _ := Open(t.TempDir(), nil)
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
			s, _ := Open(dir, nil)
			sealed[i], _ = s.Seal(alice, []byte("race"), nil)
		}(i)
	}
	wg.Wait()

	s, _ := Open(dir, nil)
	for i, b := range sealed {
		if got, err := s.Open(alice, b, nil); err != nil || string(got) != "race" {
			t.Fatalf("seal %d: %q, %v", i, got, err)
		}
	}
}

func TestDestroy(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, nil)

	sealed, _ := s.Seal(alice, []byte("gone soon"), nil)
	kept, _ := s.Seal(bob, []byte("stays"), nil)

	if err := s.Destroy(alice); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, alice+".key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("key file still exists")
	}
	// The cached copy must go too, not just the file.
	if _, err := s.Open(alice, sealed, nil); !errors.Is(err, ErrNoKey) {
		t.Fatalf("Open after Destroy: %v", err)
	}
	// A late Seal must not bring the account back with a new key.
	if _, err := s.Seal(alice, []byte("late"), nil); !errors.Is(err, ErrNoKey) {
		t.Fatalf("Seal after Destroy: %v", err)
	}
	// Other accounts are untouched.
	if got, err := s.Open(bob, kept, nil); err != nil || string(got) != "stays" {
		t.Fatalf("bob after alice destroyed: %q, %v", got, err)
	}
	// Destroying twice is fine.
	if err := s.Destroy(alice); err != nil {
		t.Fatalf("second Destroy: %v", err)
	}
	if err := s.Destroy("../etc/passwd"); !errors.Is(err, errBadID) {
		t.Fatalf("bad id: %v", err)
	}
}

func TestWrapAtRestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, kek)
	if err != nil {
		t.Fatal(err)
	}
	if !s.WrapsAtRest() {
		t.Fatal("WrapsAtRest false with a KEK")
	}

	sealed, _ := s.Seal(alice, []byte("secret"), []byte("ctx"))

	// The key file on disk must not be the raw 32-byte key.
	raw, err := os.ReadFile(filepath.Join(dir, alice+".key"))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) == keySize {
		t.Fatal("key file is stored unwrapped")
	}

	// A fresh process with the same KEK reads it back.
	s2, _ := Open(dir, kek)
	if got, err := s2.Open(alice, sealed, []byte("ctx")); err != nil || string(got) != "secret" {
		t.Fatalf("after reopen with KEK: %q, %v", got, err)
	}
}

func TestWrongKEKIsRejected(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, kek)
	s.Seal(alice, []byte("hi"), nil)

	otherKEK := bytes.Repeat([]byte{0x11}, 32)
	s2, _ := Open(dir, otherKEK)
	if _, err := s2.Open(alice, []byte("whatever"), nil); !errors.Is(err, ErrBadKEK) {
		t.Fatalf("wrong KEK: want ErrBadKEK, got %v", err)
	}

	// Dropping the KEK entirely must fail loudly, not treat wrapped bytes
	// as a key.
	s3, _ := Open(dir, nil)
	if _, err := s3.Open(alice, []byte("whatever"), nil); !errors.Is(err, ErrWrappedNoKEK) {
		t.Fatalf("no KEK on wrapped file: want ErrWrappedNoKEK, got %v", err)
	}
}

func TestWrapExistingUpgradesClearKeys(t *testing.T) {
	dir := t.TempDir()

	// Write a clear-text key by using a store with no KEK.
	plain, _ := Open(dir, nil)
	sealed, _ := plain.Seal(alice, []byte("legacy"), []byte("c"))
	if raw, _ := os.ReadFile(filepath.Join(dir, alice+".key")); len(raw) != keySize {
		t.Fatal("expected a clear-text key file to start")
	}

	// A KEK store reads it, then upgrades it in place.
	s, _ := Open(dir, kek)
	if got, err := s.Open(alice, sealed, []byte("c")); err != nil || string(got) != "legacy" {
		t.Fatalf("reading clear key under KEK store: %q, %v", got, err)
	}
	s.WrapExisting(context.Background())

	raw, _ := os.ReadFile(filepath.Join(dir, alice+".key"))
	if len(raw) == keySize {
		t.Fatal("WrapExisting left the key unwrapped")
	}
	// Still readable, and now needs the KEK.
	s2, _ := Open(dir, kek)
	if got, err := s2.Open(alice, sealed, []byte("c")); err != nil || string(got) != "legacy" {
		t.Fatalf("after upgrade: %q, %v", got, err)
	}
	s3, _ := Open(dir, nil)
	if _, err := s3.Open(alice, sealed, []byte("c")); !errors.Is(err, ErrWrappedNoKEK) {
		t.Fatalf("after upgrade without KEK: %v", err)
	}
}

func TestWrapExistingDoesNotResurrectDestroyed(t *testing.T) {
	dir := t.TempDir()
	plain, _ := Open(dir, nil)
	plain.Seal(alice, []byte("x"), nil) // clear-text key on disk

	s, _ := Open(dir, kek)
	if err := s.Destroy(alice); err != nil {
		t.Fatal(err)
	}
	s.WrapExisting(context.Background())
	if _, err := os.Stat(filepath.Join(dir, alice+".key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("WrapExisting recreated a destroyed key")
	}
}
