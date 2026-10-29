// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package blob stores attachment bytes on local disk, addressed by the
// SHA-256 of their contents.
//
// Local disk rather than object storage, because requiring an S3 bucket to
// self-host a chat server on a home machine would be absurd. The Store
// type is small enough that an S3-backed implementation can be swapped in
// behind the same three methods if anyone wants one.
//
// Content addressing means a path can never be influenced by user input:
// the location of a file is derived from its own bytes, so there is no
// filename to sanitise and no traversal to defend against. It also
// deduplicates, which matters when the same meme is posted forty times.
package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

var (
	ErrTooLarge = errors.New("blob: content exceeds the size limit")
	ErrNotFound = errors.New("blob: not found")
)

type Store struct {
	dir string
}

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o750); err != nil {
		return nil, fmt.Errorf("blob: preparing store: %w", err)
	}
	return &Store{dir: dir}, nil
}

// path spreads blobs across two levels of directories taken from the
// first four hex characters of the hash. A single flat directory with
// hundreds of thousands of entries is slow on most filesystems.
func (s *Store) path(hash []byte) string {
	h := hex.EncodeToString(hash)
	return filepath.Join(s.dir, h[0:2], h[2:4], h)
}

// Put streams r to disk, enforcing maxBytes, and returns the content hash
// and the number of bytes written.
//
// The content is written to a temporary file first and only moved into
// place once it is complete and its hash is known. A failed or oversized
// upload therefore cannot leave a partial blob that looks valid, and the
// final rename is atomic.
func (s *Store) Put(r io.Reader, maxBytes int64) (hash []byte, size int64, err error) {
	tmp, err := os.CreateTemp(filepath.Join(s.dir, "tmp"), "upload-*")
	if err != nil {
		return nil, 0, err
	}
	tmpName := tmp.Name()

	defer func() {
		tmp.Close()
		// Removing a file that has already been renamed away is a no-op
		// error we do not care about.
		if err != nil {
			os.Remove(tmpName)
		}
	}()

	digest := sha256.New()

	// One extra byte so exceeding the limit is detectable rather than
	// silently truncated.
	written, err := io.Copy(io.MultiWriter(tmp, digest), io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, 0, err
	}
	if written > maxBytes {
		return nil, 0, ErrTooLarge
	}

	if err = tmp.Sync(); err != nil {
		return nil, 0, err
	}
	if err = tmp.Close(); err != nil {
		return nil, 0, err
	}

	hash = digest.Sum(nil)
	final := s.path(hash)

	if err = os.MkdirAll(filepath.Dir(final), 0o750); err != nil {
		return nil, 0, err
	}

	// Already present: identical content, so the existing copy is as good
	// as this one. Discard the upload and report success.
	if _, statErr := os.Stat(final); statErr == nil {
		os.Remove(tmpName)
		return hash, written, nil
	}

	if err = os.Rename(tmpName, final); err != nil {
		return nil, 0, err
	}

	return hash, written, nil
}

// Open returns a reader for a stored blob.
func (s *Store) Open(hash []byte) (*os.File, error) {
	f, err := os.Open(s.path(hash))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

// Remove deletes a blob. Missing is not an error: the caller is reconciling
// the database against the disk, and a file already gone is the desired
// state.
func (s *Store) Remove(hash []byte) error {
	err := os.Remove(s.path(hash))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
