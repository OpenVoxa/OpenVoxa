// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package sealedfile encrypts attachment bytes in fixed-size chunks so
// they can be stored sealed yet still served with range requests (video
// seeking needs those). Used for plaintext-channel attachments, whose
// per-file key is in turn sealed under the uploader's account key, so
// deleting the account makes the file unreadable (crypto-shredding; see
// docs/decisions.md, Encryption, "Account deletion is crypto-shredding").
//
// Layout: one format byte, then chunks. Every chunk but the last holds
// exactly ChunkSize bytes of plaintext; the last holds the remainder,
// possibly nothing. Each chunk is AES-256-GCM with a 16-byte tag and a
// nonce made from its index and a "last chunk" flag, so chunks cannot be
// reordered, dropped or the file cut short without failing to open.
// Every file has its own random key, so a counter nonce never repeats
// under one key.
package sealedfile

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"sync"
)

const (
	// ChunkSize is the plaintext bytes per chunk.
	ChunkSize = 64 * 1024
	// KeySize is the per-file key length (AES-256).
	KeySize = 32

	tagSize  = 16
	formatV1 = 0x01
)

var ErrCorrupt = errors.New("sealedfile: data is damaged or the key is wrong")

// NewKey returns a fresh random per-file key.
func NewKey() ([]byte, error) {
	k := make([]byte, KeySize)
	_, err := rand.Read(k)
	return k, err
}

// SealedSize is the stored size of a plaintext of n bytes. It grows with
// n, so a limit on stored bytes is exactly a limit on plaintext bytes.
func SealedSize(n int64) int64 {
	return 1 + n + tagSize*(n/ChunkSize+1)
}

// PlainSize inverts SealedSize.
func PlainSize(sealed int64) (int64, error) {
	body := sealed - 1
	if body < tagSize {
		return 0, ErrCorrupt
	}
	chunks := (body + ChunkSize + tagSize - 1) / (ChunkSize + tagSize)
	// A body that is an exact multiple of a full chunk would be missing
	// its final (possibly empty) chunk.
	if body%(ChunkSize+tagSize) == 0 {
		return 0, ErrCorrupt
	}
	n := body - chunks*tagSize
	if n < 0 || SealedSize(n) != sealed {
		return 0, ErrCorrupt
	}
	return n, nil
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != KeySize {
		return nil, errors.New("sealedfile: key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func nonce(index int64, last bool) []byte {
	n := make([]byte, 12)
	binary.BigEndian.PutUint64(n[3:11], uint64(index))
	if last {
		n[11] = 1
	}
	return n
}

// sealer is the io.Reader returned by Seal.
type sealer struct {
	src   io.Reader
	aead  cipher.AEAD
	plain []byte
	out   []byte // pending ciphertext not yet handed to the caller
	index int64
	done  bool
	err   error
}

// Seal returns a reader of the sealed form of src.
func Seal(src io.Reader, key []byte) (io.Reader, error) {
	a, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	return &sealer{
		src:   src,
		aead:  a,
		plain: make([]byte, ChunkSize),
		out:   []byte{formatV1},
	}, nil
}

func (s *sealer) Read(p []byte) (int, error) {
	for len(s.out) == 0 {
		if s.err != nil {
			return 0, s.err
		}
		if s.done {
			return 0, io.EOF
		}
		n, err := io.ReadFull(s.src, s.plain)
		switch {
		case err == nil:
			// A full chunk is never the last one; see the package comment.
			s.out = s.aead.Seal(s.out[:0], nonce(s.index, false), s.plain, nil)
		case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
			s.out = s.aead.Seal(s.out[:0], nonce(s.index, true), s.plain[:n], nil)
			s.done = true
		default:
			s.err = err
			return 0, err
		}
		s.index++
	}
	n := copy(p, s.out)
	s.out = s.out[n:]
	return n, nil
}

// Reader decrypts a sealed file on demand. It implements io.ReaderAt;
// wrap it in io.NewSectionReader(r, 0, r.Size()) for a ReadSeeker.
type Reader struct {
	src    io.ReaderAt
	aead   cipher.AEAD
	size   int64 // plaintext
	chunks int64

	mu        sync.Mutex
	cached    int64 // index of the chunk in buf, or -1
	buf       []byte
	cipherBuf []byte
}

// Open prepares to read a sealed file of sealedSize bytes from src.
func Open(src io.ReaderAt, sealedSize int64, key []byte) (*Reader, error) {
	a, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	size, err := PlainSize(sealedSize)
	if err != nil {
		return nil, err
	}
	head := make([]byte, 1)
	if _, err := src.ReadAt(head, 0); err != nil {
		return nil, err
	}
	if head[0] != formatV1 {
		return nil, ErrCorrupt
	}
	return &Reader{
		src:       src,
		aead:      a,
		size:      size,
		chunks:    size/ChunkSize + 1,
		cached:    -1,
		cipherBuf: make([]byte, ChunkSize+tagSize),
	}, nil
}

// Size is the plaintext length.
func (r *Reader) Size() int64 { return r.size }

// chunk decrypts chunk i into r.buf. Callers hold r.mu.
func (r *Reader) chunk(i int64) error {
	if r.cached == i {
		return nil
	}
	plainLen := int64(ChunkSize)
	if i == r.chunks-1 {
		plainLen = r.size - i*ChunkSize
	}
	ct := r.cipherBuf[:plainLen+tagSize]
	off := 1 + i*(ChunkSize+tagSize)
	if _, err := r.src.ReadAt(ct, off); err != nil && !(errors.Is(err, io.EOF) && i == r.chunks-1) {
		return err
	}
	plain, err := r.aead.Open(r.buf[:0], nonce(i, i == r.chunks-1), ct, nil)
	if err != nil {
		r.cached = -1
		return ErrCorrupt
	}
	r.buf = plain
	r.cached = i
	return nil
}

func (r *Reader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, errors.New("sealedfile: negative offset")
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	read := 0
	for read < len(p) {
		pos := off + int64(read)
		if pos >= r.size {
			return read, io.EOF
		}
		i := pos / ChunkSize
		if err := r.chunk(i); err != nil {
			return read, err
		}
		read += copy(p[read:], r.buf[pos-i*ChunkSize:])
	}
	return read, nil
}
