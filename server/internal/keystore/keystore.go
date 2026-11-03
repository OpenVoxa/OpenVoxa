// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package keystore holds one secret key per account, for crypto-shredding
// what the server can read (plaintext-channel messages, report copies and
// attachments). See docs/decisions.md, Encryption, "Account deletion is
// crypto-shredding".
//
// The keys live in a folder of files, deliberately NOT in Postgres:
// anything in the database is in every database backup, so a key stored
// there would be restored alongside the data it exists to destroy. Each
// account's key is its own file, named after the account's UUID, so
// destroying one is a single unlink that cannot damage anyone else's.
//
// A key is created the first time it is needed, so accounts that existed
// before this package need no migration step of their own.
package keystore

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

var (
	// ErrNoKey means the account's key does not exist: the account was
	// deleted (the key was destroyed on purpose) or the folder was lost.
	ErrNoKey = errors.New("keystore: no key for this account")

	// ErrBadSealed means sealed bytes are malformed or fail to
	// authenticate under the account's key.
	ErrBadSealed = errors.New("keystore: sealed data is invalid")

	errBadID = errors.New("keystore: account id is not a UUID")
)

const (
	keySize = 32

	// formatV1 is the first byte of everything Seal produces, so the
	// layout can change later without guessing which one a row uses.
	formatV1 = 0x01
)

// Account ids become file names, so only a canonical UUID is accepted.
// That rules out "../" and anything else that could escape the folder.
var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type Store struct {
	dir string

	// Keys are tiny and read on every history page, so they are cached
	// for the life of the process. Destroy removes the cached copy too.
	mu    sync.Mutex
	cache map[string]cipher.AEAD

	// Accounts destroyed by this process. Seal refuses them, so a send
	// that races an account deletion cannot quietly make a new key for
	// an account that no longer exists.
	destroyed map[string]bool
}

// Open prepares the key folder, creating it if needed, and checks the
// server can write there. A folder it cannot write would otherwise only
// show up at the first message, as a failed send.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o700); err != nil {
		return nil, fmt.Errorf("keystore: preparing %s: %w", dir, err)
	}
	probe, err := os.CreateTemp(filepath.Join(dir, "tmp"), "probe-*")
	if err != nil {
		return nil, fmt.Errorf("keystore: %s is not writable: %w", dir, err)
	}
	probe.Close()
	os.Remove(probe.Name())

	return &Store{dir: dir, cache: map[string]cipher.AEAD{}, destroyed: map[string]bool{}}, nil
}

func (s *Store) path(userID string) string {
	return filepath.Join(s.dir, userID+".key")
}

// aead returns the cipher for an account, creating its key first when
// create is true and none exists yet.
func (s *Store) aead(userID string, create bool) (cipher.AEAD, error) {
	if !uuidRe.MatchString(userID) {
		return nil, errBadID
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if a, ok := s.cache[userID]; ok {
		return a, nil
	}

	key, err := os.ReadFile(s.path(userID))
	if errors.Is(err, os.ErrNotExist) {
		if !create || s.destroyed[userID] {
			return nil, ErrNoKey
		}
		key, err = s.create(userID)
	}
	if err != nil {
		return nil, err
	}
	if len(key) != keySize {
		return nil, fmt.Errorf("keystore: key file for %s is damaged", userID)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	a, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	s.cache[userID] = a
	return a, nil
}

// create writes a new random key. It is written to a temporary file,
// flushed to disk, and only then linked into place, so a crash can never
// leave a half-written key that looks valid. Link refuses to replace an
// existing file, so the key, once made, is never overwritten.
func (s *Store) create(userID string) ([]byte, error) {
	key := make([]byte, keySize)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}

	tmp, err := os.CreateTemp(filepath.Join(s.dir, "tmp"), "key-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())

	if _, err := tmp.Write(key); err != nil {
		tmp.Close()
		return nil, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}

	if err := os.Link(tmp.Name(), s.path(userID)); err != nil {
		if errors.Is(err, os.ErrExist) {
			// Another process made it first; theirs wins.
			return os.ReadFile(s.path(userID))
		}
		return nil, err
	}
	return key, nil
}

// Seal encrypts plaintext under the account's key, creating the key if
// this is the account's first sealed item. context binds the result to
// where it is stored (for example channel and author), so sealed bytes
// copied onto another row fail to open rather than showing up there.
func (s *Store) Seal(userID string, plaintext, context []byte) ([]byte, error) {
	a, err := s.aead(userID, true)
	if err != nil {
		return nil, err
	}

	out := make([]byte, 1+a.NonceSize(), 1+a.NonceSize()+len(plaintext)+a.Overhead())
	out[0] = formatV1
	if _, err := rand.Read(out[1:]); err != nil {
		return nil, err
	}
	return a.Seal(out, out[1:], plaintext, context), nil
}

// Open decrypts what Seal produced. ErrNoKey means the account's key is
// gone, which after an account deletion is the intended outcome.
func (s *Store) Open(userID string, sealed, context []byte) ([]byte, error) {
	a, err := s.aead(userID, false)
	if err != nil {
		return nil, err
	}
	n := a.NonceSize()
	if len(sealed) < 1+n+a.Overhead() || sealed[0] != formatV1 {
		return nil, ErrBadSealed
	}
	plain, err := a.Open(nil, sealed[1:1+n], sealed[1+n:], context)
	if err != nil {
		return nil, ErrBadSealed
	}
	return plain, nil
}

// Destroy deletes the account's key, which makes everything sealed under
// it permanently unreadable, including copies in database backups. That
// is the whole of crypto-shredding: nothing else needs rewriting.
//
// Call it only after the account's deletion has committed. Destroying
// first and then rolling back would leave a live account whose messages
// can never be read again.
//
// A key that is already gone is not an error, so a retry is harmless.
// Another process (the running server, when the host command deletes an
// account) may still hold the key in memory until it restarts; it never
// uses it, because the deleted account's id is no longer on any row.
func (s *Store) Destroy(userID string) error {
	if !uuidRe.MatchString(userID) {
		return errBadID
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.cache, userID)
	s.destroyed[userID] = true

	if err := os.Remove(s.path(userID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("keystore: destroying key for %s: %w", userID, err)
	}

	// Flush the folder so the unlink survives a power cut.
	d, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
