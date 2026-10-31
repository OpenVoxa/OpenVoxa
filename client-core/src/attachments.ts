// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Attachments in encrypted channels, and the message envelope that
 * carries their keys.
 *
 * Each file is encrypted on this device with its own random AES-256-GCM
 * key before upload, so the server stores bytes it cannot read. The key,
 * nonce, real filename and real type travel inside the MLS-encrypted
 * message that claims the attachment. The server sees only a ciphertext
 * blob of roughly the original size.
 *
 * Why a fresh key per file rather than one derived from the group: a key
 * from the MLS epoch would make an attachment unreadable to anyone who
 * joins later even if the message itself were shared with them (opt-in
 * history sharing is planned), and it would tie the file's lifetime to
 * group state. A per-file key travels with the message and nothing else.
 *
 * What this gives up: content-addressed deduplication. Two uploads of the
 * same file are now different ciphertexts. That is deliberate: dedup
 * across users reveals that someone else uploaded an identical file.
 *
 * Integrity: GCM authenticates the ciphertext, and the key arrives inside
 * an authenticated MLS message, so a server that swaps or alters a blob
 * produces a decryption failure, never a different file.
 */

/** What a receiver needs to fetch, decrypt and present one attachment. */
export interface FileKey {
  /** Server attachment ID, used to match the server's list. */
  readonly id: string;
  /** Raw AES-256 key, base64. */
  readonly key: string;
  /** 12-byte GCM nonce, base64. */
  readonly iv: string;
  /** The real filename. The server only ever sees a placeholder. */
  readonly name: string;
  /** The real content type, as claimed by the sender. Treat as untrusted. */
  readonly type: string;
  /** Plaintext size in bytes. */
  readonly size: number;
}

export interface EncryptedFile {
  /** Upload this. */
  readonly ciphertext: Uint8Array;
  /** Everything about the file except the server ID, which the upload returns. */
  readonly key: Omit<FileKey, "id">;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encryptFile(
  data: ArrayBuffer | Uint8Array,
  name: string,
  type: string,
): Promise<EncryptedFile> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  // A fresh random key per file means a random nonce cannot repeat under
  // the same key; the 12-byte size is GCM's native one.
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const plaintext = owned(data);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );

  return {
    ciphertext,
    key: {
      key: toB64(raw),
      iv: toB64(iv),
      name,
      type: type || "application/octet-stream",
      size: plaintext.length,
    },
  };
}

/** Throws if the bytes were altered or the key is wrong. */
export async function decryptFile(
  ciphertext: ArrayBuffer | Uint8Array,
  file: FileKey,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", fromB64(file.key), "AES-GCM", false, ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(file.iv) },
    key,
    owned(ciphertext),
  );
  return new Uint8Array(plaintext);
}

// WebCrypto's types refuse views that might sit on a SharedArrayBuffer.
// Copying into a fresh ArrayBuffer satisfies them and costs one pass over
// a file that is about to be encrypted or decrypted anyway.
function owned(data: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
}

// ------------------------------------------------------------ envelope

/**
 * The plaintext inside an encrypted channel message.
 *
 * Before attachments were encrypted the plaintext was just the text.
 * Messages are now a small JSON object with a version marker, so the
 * shape can grow (replies, edits, reactions) without guessing. Anything
 * that does not parse as an envelope is treated as plain text, which
 * keeps older messages readable.
 */
export interface Envelope {
  readonly text: string;
  readonly files: FileKey[];
}

const ENVELOPE_VERSION = 1;

export function encodeEnvelope(env: Envelope): string {
  return JSON.stringify({ ovx: ENVELOPE_VERSION, text: env.text, files: env.files });
}

export function decodeEnvelope(plaintext: string): Envelope {
  if (plaintext.startsWith('{"ovx":')) {
    try {
      const v = JSON.parse(plaintext);
      if (v && v.ovx === ENVELOPE_VERSION && typeof v.text === "string") {
        const files = Array.isArray(v.files) ? v.files.filter(isFileKey) : [];
        return { text: v.text, files };
      }
    } catch { /* fall through: treat as text */ }
  }
  return { text: plaintext, files: [] };
}

// The sender is an authenticated group member, not a trusted one: a
// malformed entry is dropped rather than allowed to break rendering.
function isFileKey(f: unknown): f is FileKey {
  if (!f || typeof f !== "object") return false;
  const o = f as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.key === "string" &&
    typeof o.iv === "string" && typeof o.name === "string" &&
    typeof o.type === "string" && typeof o.size === "number";
}
