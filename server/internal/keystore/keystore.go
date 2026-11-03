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
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

var (
	// ErrNoKey means the account's key does not exist: the account was
	// deleted (the key was destroyed on purpose) or the folder was lost.
	ErrNoKey = errors.New("keystore: no key for this account")

	// ErrBadSealed means sealed bytes are malformed or fail to
	// authenticate under the account's key.
	ErrBadSealed = errors.New("keystore: sealed data is invalid")

	// ErrWrappedNoKEK means a key file is wrapped under a key-encryption
	// key but none is configured: the operator set OPENVOXA_KEK once and
	// has since removed or lost it. Failing loudly beats quietly treating
	// the wrapped bytes as a key and producing garbage.
	ErrWrappedNoKEK = errors.New("keystore: key file is wrapped but OPENVOXA_KEK is not set")

	// ErrBadKEK means a wrapped key file did not authenticate under the
	// configured KEK: almost always the wrong key.
	ErrBadKEK = errors.New("keystore: key file did not unwrap (wrong OPENVOXA_KEK?)")

	errBadID = errors.New("keystore: account id is not a UUID")
)

const (
	keySize = 32

	// formatV1 is the first byte of everything Seal produces, so the
	// layout can change later without guessing which one a row uses.
	formatV1 = 0x01

	// wrapV1 is the first byte of a key file stored wrapped under the KEK.
	// A raw (unwrapped) key file is exactly keySize bytes, so length tells
	// the two apart; the marker guards against a future layout change.
	wrapV1 = 0x01
)

// Account ids become file names, so only a canonical UUID is accepted.
// That rules out "../" and anything else that could escape the folder.
var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type Store struct {
	dir string

	// wrap encrypts each account key where it rests on disk, when a KEK is
	// configured (envelope encryption). Nil means keys are stored in the
	// clear. It never touches message bodies: those stay sealed under the
	// per-account key, which this only protects at rest.
	wrap cipher.AEAD

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
//
// kek, when non-nil, must be 32 bytes and wraps every account key at
// rest. Existing clear-text key files stay readable and are upgraded in
// place by WrapExisting; new ones are written wrapped.
func Open(dir string, kek []byte) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o700); err != nil {
		return nil, fmt.Errorf("keystore: preparing %s: %w", dir, err)
	}
	probe, err := os.CreateTemp(filepath.Join(dir, "tmp"), "probe-*")
	if err != nil {
		return nil, fmt.Errorf("keystore: %s is not writable: %w", dir, err)
	}
	probe.Close()
	os.Remove(probe.Name())

	s := &Store{dir: dir, cache: map[string]cipher.AEAD{}, destroyed: map[string]bool{}}
	if kek != nil {
		block, err := aes.NewCipher(kek)
		if err != nil {
			return nil, fmt.Errorf("keystore: key-encryption key: %w", err)
		}
		if s.wrap, err = cipher.NewGCM(block); err != nil {
			return nil, fmt.Errorf("keystore: key-encryption key: %w", err)
		}
	}
	return s, nil
}

// WrapsAtRest reports whether account keys are encrypted on disk.
func (s *Store) WrapsAtRest() bool { return s.wrap != nil }

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

	raw, err := os.ReadFile(s.path(userID))
	var key []byte
	if errors.Is(err, os.ErrNotExist) {
		if !create || s.destroyed[userID] {
			return nil, ErrNoKey
		}
		key, err = s.create(userID)
	} else if err == nil {
		key, err = s.toKey(userID, raw)
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

	payload := key
	if s.wrap != nil {
		payload = s.wrapKey(userID, key)
	}

	tmp, err := os.CreateTemp(filepath.Join(s.dir, "tmp"), "key-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())

	if _, err := tmp.Write(payload); err != nil {
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
			// Another process made it first; theirs wins. Decode whatever
			// is on disk, which may already be wrapped.
			raw, rerr := os.ReadFile(s.path(userID))
			if rerr != nil {
				return nil, rerr
			}
			return s.toKey(userID, raw)
		}
		return nil, err
	}
	return key, nil
}

// wrapAAD binds a wrapped key file to its account, so a wrapped file
// copied onto another account's path fails to unwrap rather than being
// accepted as that account's key.
func wrapAAD(userID string) []byte {
	return []byte("openvoxa/keywrap/v1\x00" + userID)
}

// wrapKey encrypts an account key under the KEK for storage on disk.
func (s *Store) wrapKey(userID string, key []byte) []byte {
	out := make([]byte, 1+s.wrap.NonceSize(), 1+s.wrap.NonceSize()+len(key)+s.wrap.Overhead())
	out[0] = wrapV1
	if _, err := rand.Read(out[1:]); err != nil {
		// crypto/rand failing is fatal elsewhere too; a panic here is
		// better than writing a predictable nonce.
		panic("keystore: out of randomness: " + err.Error())
	}
	return s.wrap.Seal(out, out[1:], key, wrapAAD(userID))
}

// toKey turns the bytes of a key file into the account key. A file of
// exactly keySize is a clear-text key (no KEK, or written before the KEK
// was configured and not yet upgraded); anything else is wrapped.
func (s *Store) toKey(userID string, raw []byte) ([]byte, error) {
	if len(raw) == keySize {
		return raw, nil // clear-text key; readable with or without a KEK
	}
	if s.wrap == nil {
		return nil, ErrWrappedNoKEK
	}
	n := s.wrap.NonceSize()
	if len(raw) < 1+n+s.wrap.Overhead() || raw[0] != wrapV1 {
		return nil, fmt.Errorf("keystore: key file for %s is damaged", userID)
	}
	key, err := s.wrap.Open(nil, raw[1:1+n], raw[1+n:], wrapAAD(userID))
	if err != nil {
		return nil, ErrBadKEK
	}
	return key, nil
}

// WrapExisting upgrades clear-text key files to wrapped ones, so a key
// folder that predates the KEK, or was restored from a clear-text backup,
// ends up fully protected at rest. It is a no-op with no KEK. Safe to run
// in the background at startup: readers accept both forms, so normal
// traffic need not wait, and new keys are already written wrapped.
//
// Each file is handled under the lock, so it never races Destroy into
// resurrecting a deleted account's key.
func (s *Store) WrapExisting(ctx context.Context) {
	if s.wrap == nil {
		return
	}
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		slog.ErrorContext(ctx, "keystore: listing keys to wrap", "err", err)
		return
	}

	wrapped := 0
	for _, e := range entries {
		if ctx.Err() != nil {
			return
		}
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".key") {
			continue
		}
		userID := strings.TrimSuffix(e.Name(), ".key")
		if !uuidRe.MatchString(userID) {
			continue
		}
		did, err := s.wrapOne(userID)
		if err != nil {
			slog.ErrorContext(ctx, "keystore: wrapping key", "err", err, "user_id", userID)
			continue
		}
		if did {
			wrapped++
		}
	}
	if wrapped > 0 {
		slog.InfoContext(ctx, "keystore: wrapped existing keys at rest", "count", wrapped)
	}
}

// wrapOne rewrites one clear-text key file as wrapped, atomically.
// Returns false (no error) when the file is gone, already wrapped, or
// belongs to an account destroyed in this process.
func (s *Store) wrapOne(userID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.destroyed[userID] {
		return false, nil
	}
	raw, err := os.ReadFile(s.path(userID))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if len(raw) != keySize {
		return false, nil // already wrapped, or damaged: leave it for a reader to flag
	}

	wrappedBytes := s.wrapKey(userID, raw)
	tmp, err := os.CreateTemp(filepath.Join(s.dir, "tmp"), "key-*")
	if err != nil {
		return false, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(wrappedBytes); err != nil {
		tmp.Close()
		return false, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	// Rename replaces the clear-text file in one step; the key material is
	// the same, so a crash mid-way loses nothing either way.
	if err := os.Rename(tmp.Name(), s.path(userID)); err != nil {
		return false, err
	}
	return true, s.syncDir()
}

// syncDir flushes the key folder so a rename or unlink survives a crash.
func (s *Store) syncDir() error {
	d, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
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
	return s.syncDir()
}
