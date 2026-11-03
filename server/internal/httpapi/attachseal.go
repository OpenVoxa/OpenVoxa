// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"os"

	"github.com/openvoxa/openvoxa/server/internal/blob"
	"github.com/openvoxa/openvoxa/server/internal/keystore"
	"github.com/openvoxa/openvoxa/server/internal/sealedfile"
)

// Attachments in plaintext channels are stored sealed (crypto-shredding
// step S3): the bytes under a random key per file, and that key and the
// real filename under the uploader's account key. Deleting the account
// key therefore makes both unreadable, backups of the blob folder
// included. Encrypted channels are stored as uploaded: the client has
// already encrypted the bytes and the name never reaches the server.

// errAttachmentShredded means the uploader's key is gone: the account was
// deleted, so the file is meant to be unreadable.
var errAttachmentShredded = errors.New("attachment's key no longer exists")

// The contexts bind the sealed key and name to this channel, uploader and
// exact blob, so neither can be moved onto another row and still open.
func attachmentKeyContext(channelID, uploaderID string, hash []byte) []byte {
	return []byte("openvoxa/attachment-key/v1\x00" + channelID + "\x00" + uploaderID + "\x00" + hex.EncodeToString(hash))
}

func attachmentNameContext(channelID, uploaderID string, hash []byte) []byte {
	return []byte("openvoxa/attachment-name/v1\x00" + channelID + "\x00" + uploaderID + "\x00" + hex.EncodeToString(hash))
}

// sealedBlob is a file written to the blob store in sealed form.
type sealedBlob struct {
	hash       []byte
	storedSize int64 // bytes on disk
	plainSize  int64
	fileKey    []byte // sealed under the uploader's key
	sealedName []byte
}

// putSealed encrypts src into the blob store and seals its key and name.
// maxPlain limits the plaintext; blob.ErrTooLarge reports going over.
func (a *API) putSealed(src io.Reader, channelID, uploaderID, filename string, maxPlain int64) (*sealedBlob, error) {
	key, err := sealedfile.NewKey()
	if err != nil {
		return nil, err
	}
	sealed, err := sealedfile.Seal(src, key)
	if err != nil {
		return nil, err
	}
	// The sealed size grows with the plaintext size, so limiting one
	// limits the other exactly.
	hash, stored, err := a.blobs.Put(sealed, sealedfile.SealedSize(maxPlain))
	if err != nil {
		return nil, err
	}
	plain, err := sealedfile.PlainSize(stored)
	if err != nil {
		return nil, err
	}
	fileKey, err := a.keys.Seal(uploaderID, key, attachmentKeyContext(channelID, uploaderID, hash))
	if err != nil {
		return nil, err
	}
	name, err := a.keys.Seal(uploaderID, []byte(filename), attachmentNameContext(channelID, uploaderID, hash))
	if err != nil {
		return nil, err
	}
	return &sealedBlob{hash: hash, storedSize: stored, plainSize: plain, fileKey: fileKey, sealedName: name}, nil
}

// storeAttachment saves an upload (or a fetched GIF) and records it,
// sealed when the channel is plaintext. Shared by uploadAttachment and
// attachGif. Returns blob.ErrTooLarge when src exceeds the limit.
func (a *API) storeAttachment(
	ctx context.Context, src io.Reader, channelID, uploaderID, filename, contentType string, seal bool,
) (attachmentInfo, error) {
	var (
		info       attachmentInfo
		hash       []byte
		stored     int64
		size       int64
		fileKey    []byte
		sealedName []byte
		dbName     = filename
	)

	if seal {
		sb, err := a.putSealed(src, channelID, uploaderID, filename, a.maxAttachment)
		if err != nil {
			return info, err
		}
		hash, stored, size = sb.hash, sb.storedSize, sb.plainSize
		fileKey, sealedName = sb.fileKey, sb.sealedName
		// The real name lives only in sealed_name.
		dbName = "file"
	} else {
		var err error
		hash, size, err = a.blobs.Put(src, a.maxAttachment)
		if err != nil {
			return info, err
		}
		stored = size
	}

	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return info, err
	}
	defer tx.Rollback(ctx)

	// Unsealed blobs may already exist from an earlier identical upload.
	// Sealed ones never do: each has its own key.
	if _, err := tx.Exec(ctx,
		`INSERT INTO blobs (hash, size) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING`,
		hash, stored,
	); err != nil {
		return info, err
	}

	err = tx.QueryRow(ctx,
		`INSERT INTO attachments
		     (channel_id, uploader_id, blob_hash, filename, content_type, size, file_key, sealed_name)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING id, content_type, size`,
		channelID, uploaderID, hash, dbName, contentType, size, fileKey, sealedName,
	).Scan(&info.ID, &info.ContentType, &info.Size)
	if err != nil {
		return info, err
	}
	if err := tx.Commit(ctx); err != nil {
		return info, err
	}

	info.Filename = filename
	info.URL = a.signAttachmentURL(info.ID)
	return info, nil
}

// finishAttachment prepares an attachment read from the database for a
// client: unseals the name, drops the internal fields, signs the link.
func (a *API) finishAttachment(ctx context.Context, channelID string, info *attachmentInfo) {
	if info.SealedName != nil {
		info.Filename = "file"
		if info.UploaderID != nil {
			name, err := a.keys.Open(*info.UploaderID, info.SealedName,
				attachmentNameContext(channelID, *info.UploaderID, info.BlobHash))
			if err == nil {
				info.Filename = string(name)
			} else if !errors.Is(err, keystore.ErrNoKey) {
				slog.ErrorContext(ctx, "opening sealed attachment name", "err", err, "attachment_id", info.ID)
			}
		}
	}
	info.UploaderID, info.BlobHash, info.SealedName = nil, nil, nil
	info.URL = a.signAttachmentURL(info.ID)
}

// openSealedBlob returns a reader of the plaintext of a sealed blob, and
// its size. f must be the open blob file.
func (a *API) openSealedBlob(f *os.File, channelID string, uploaderID *string, hash, fileKey []byte) (io.ReadSeeker, int64, error) {
	if uploaderID == nil {
		return nil, 0, errAttachmentShredded
	}
	key, err := a.keys.Open(*uploaderID, fileKey, attachmentKeyContext(channelID, *uploaderID, hash))
	if errors.Is(err, keystore.ErrNoKey) {
		return nil, 0, errAttachmentShredded
	}
	if err != nil {
		return nil, 0, err
	}
	st, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	r, err := sealedfile.Open(f, st.Size(), key)
	if err != nil {
		return nil, 0, err
	}
	return io.NewSectionReader(r, 0, r.Size()), r.Size(), nil
}

// sealExistingAttachments converts plaintext-channel attachments stored
// before S3 (crypto-shredding). One pass in id order, so a file that
// cannot be converted (its blob missing, say) is logged and skipped
// rather than retried forever. The old blob loses its last reference and
// the blob collector deletes it.
func (a *API) sealExistingAttachments(ctx context.Context) (int, error) {
	total := 0
	after := "00000000-0000-0000-0000-000000000000"
	for {
		rows, err := a.pool.Query(ctx,
			`SELECT at.id, at.channel_id, at.uploader_id, at.blob_hash, at.filename
			   FROM attachments at
			   JOIN channels c ON c.id = at.channel_id
			  WHERE NOT c.encrypted AND at.file_key IS NULL
			    AND at.uploader_id IS NOT NULL AND at.id > $1
			  ORDER BY at.id
			  LIMIT 100`, after)
		if err != nil {
			return total, err
		}
		type row struct {
			id, channelID, uploaderID string
			hash                      []byte
			filename                  string
		}
		var batch []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.channelID, &r.uploaderID, &r.hash, &r.filename); err != nil {
				rows.Close()
				return total, err
			}
			batch = append(batch, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return total, err
		}
		if len(batch) == 0 {
			return total, nil
		}

		for _, r := range batch {
			after = r.id
			ok, err := a.sealOneAttachment(ctx, r.id, r.channelID, r.uploaderID, r.hash, r.filename)
			if err != nil {
				slog.Error("sealing existing attachment", "err", err, "attachment_id", r.id)
				continue
			}
			if ok {
				total++
			}
		}
	}
}

func (a *API) sealOneAttachment(ctx context.Context, id, channelID, uploaderID string, oldHash []byte, filename string) (bool, error) {
	f, err := a.blobs.Open(oldHash)
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) {
			return false, errors.New("blob file is missing")
		}
		return false, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false, err
	}

	sb, err := a.putSealed(f, channelID, uploaderID, filename, st.Size())
	if err != nil {
		return false, err
	}

	// The new blob row and the switch-over commit together, so the blob
	// collector never sees the new blob without a reference. The guard
	// (still unsealed, still the old blob) leaves a row that changed
	// meanwhile alone; its new blob is then collected as unreferenced.
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`INSERT INTO blobs (hash, size) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING`,
		sb.hash, sb.storedSize); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx,
		`UPDATE attachments
		    SET blob_hash = $2, file_key = $3, sealed_name = $4, filename = 'file'
		  WHERE id = $1 AND file_key IS NULL AND blob_hash = $5`,
		id, sb.hash, sb.fileKey, sb.sealedName, oldHash)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
