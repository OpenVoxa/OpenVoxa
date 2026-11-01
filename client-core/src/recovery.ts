// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Recovery key and the encrypted backup of the local archive
 * (docs/decisions.md, build order 13, "Recovery key v1 = history backup
 * only").
 *
 * Why this exists: encrypted channels can only be read from the local
 * archive (MLS message keys are single-use), and signing out wipes it. A
 * backup on the server, encrypted under a key only the user holds, is
 * how history survives a sign-out or a new device.
 *
 * The key: 128 random bits shown as 12 BIP-39 words (the word list
 * crypto wallets use, with a built-in checksum that catches most typos),
 * or as a QR payload of the same bits. 128 bits cannot be guessed, so
 * no slow password hash is needed; HKDF turns it into an AES-256-GCM key.
 *
 * On the server (recovery.go): one header (format, salt, key check) and
 * named chunks. Each upload writes a full new generation of chunks named
 * `<gen>-<n>`, then deletes the old generation, so a crash mid-upload
 * still leaves one complete backup. Every chunk is bound to its backup
 * id and name (GCM additional data), so the server cannot swap chunks
 * between backups or positions without decryption failing. Inside each
 * chunk: gzip'd JSON with the part count, so a missing part is noticed.
 *
 * What the server learns: that a backup exists, its size, and when it
 * changes. Not which channels, how many messages, or any text.
 *
 * The derived key (never the words) is remembered on this device as a
 * non-extractable CryptoKey so later uploads need no typing.
 */

import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { storage, type ArchivedValue, type StoredBackupKey } from "./storage.js";

/** An authenticated fetch: the caller adds the session token. */
export interface AuthedFetch {
  (path: string, init?: RequestInit): Promise<Response>;
}

/** What Backup needs from local storage; storage itself by default. */
export interface BackupArchive {
  exportArchive(): Promise<Array<[string, ArchivedValue]>>;
  importArchive(entries: Array<[string, unknown]>): Promise<number>;
  getBackupKey(): Promise<StoredBackupKey | undefined>;
  setBackupKey(value: StoredBackupKey): Promise<void>;
  clearBackupKey(): Promise<void>;
}

const QR_PREFIX = "OVRK1:";
const KEY_BYTES = 16;
const FORMAT = "openvoxa-backup";
const FORMAT_VERSION = 1;
/** Plaintext per chunk before gzip; the server allows 4 MiB per chunk. */
const PART_BYTES = 3 * 1024 * 1024;
const CHUNK_NAME = /^([0-9a-f]{16})-(\d{1,4})$/;

const utf8 = new TextEncoder();

// ---------------------------------------------------------------- errors

/** A recovery key that could not be read: unknown word, wrong count, typo. */
export class InvalidRecoveryKey extends Error {}
/** A well-formed key that does not open this account's backup. */
export class WrongRecoveryKey extends Error {
  constructor() {
    super("that recovery key does not match this account's backup");
  }
}
/** The account has no backup on the server. */
export class NoBackup extends Error {
  constructor() {
    super("this account has no backup yet");
  }
}
/**
 * This device has no remembered key for the server's current backup:
 * never unlocked here, or another device started a new backup since.
 * Ask for the recovery key and call unlock().
 */
export class BackupLocked extends Error {
  constructor() {
    super("enter your recovery key to keep backing up from this device");
  }
}
/** The backup is damaged or incomplete; nothing was imported. */
export class BackupDamaged extends Error {}
/** The server refused a request. */
export class BackupHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- the key

/** A recovery key. Show `words` and `qrPayload` once; keep neither. */
export class RecoveryKey {
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /** A new random key. */
  static generate(): RecoveryKey {
    return new RecoveryKey(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
  }

  /**
   * Read a key typed as words (spaces, commas, dashes or new lines
   * between; any case; the first four letters of a word are enough, as
   * BIP-39 guarantees they are unique) or scanned from the QR code.
   * Throws InvalidRecoveryKey with a message fit to show the user.
   */
  static parse(input: string): RecoveryKey {
    const text = input.trim();
    if (text.toUpperCase().startsWith(QR_PREFIX)) {
      const hex = text.slice(QR_PREFIX.length).trim().toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(hex)) {
        throw new InvalidRecoveryKey("that QR code is not an OpenVoxa recovery key");
      }
      const bytes = new Uint8Array(KEY_BYTES);
      for (let i = 0; i < KEY_BYTES; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return new RecoveryKey(bytes);
    }

    const typed = text.toLowerCase().split(/[\s,;.\-]+/).filter(Boolean);
    if (typed.length !== 12) {
      throw new InvalidRecoveryKey(`a recovery key has 12 words; that has ${typed.length}`);
    }
    const words = typed.map((w, i) => {
      if (wordlist.includes(w)) return w;
      const matches = w.length >= 4 ? wordlist.filter((x) => x.startsWith(w.slice(0, 4))) : [];
      if (matches.length === 1 && matches[0]!.startsWith(w)) return matches[0]!;
      throw new InvalidRecoveryKey(`word ${i + 1} ("${w}") is not a recovery key word`);
    });
    try {
      return new RecoveryKey(mnemonicToEntropy(words.join(" "), wordlist));
    } catch {
      // Every word is valid but the checksum fails: a word was swapped
      // for another valid one, or two are in the wrong order.
      throw new InvalidRecoveryKey("one of the words is wrong or out of order");
    }
  }

  /** The 12 words, in order. */
  get words(): string[] {
    return entropyToMnemonic(this.#bytes, wordlist).split(" ");
  }

  /**
   * What the QR code encodes. Upper-case hex after the prefix, so a QR
   * library can use its compact alphanumeric mode.
   */
  get qrPayload(): string {
    let hex = "";
    for (const b of this.#bytes) hex += b.toString(16).padStart(2, "0");
    return QR_PREFIX + hex.toUpperCase();
  }

  /** For this module only: the raw bits. */
  bytes(): Uint8Array {
    return this.#bytes;
  }
}

// ---------------------------------------------------------------- crypto

interface Meta {
  format: string;
  v: number;
  kdf: string;
  salt: string;
  check: string;
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

function randomHex(bytes: number): string {
  let hex = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Two independent outputs from one key: the AES key, and a check value
 * stored in the header so a wrong key is reported as wrong instead of as
 * a damaged backup. The check reveals nothing about the AES key.
 */
async function derive(
  key: RecoveryKey,
  salt: Uint8Array<ArrayBuffer>,
): Promise<{ aes: CryptoKey; check: Uint8Array }> {
  const ikm = await crypto.subtle.importKey(
    "raw", new Uint8Array(key.bytes()), "HKDF", false, ["deriveKey", "deriveBits"],
  );
  const aes = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8.encode("openvoxa backup v1 encryption") },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  const check = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8.encode("openvoxa backup v1 key check") },
    ikm, 256,
  ));
  return { aes, check };
}

function aad(backupId: string, name: string): Uint8Array<ArrayBuffer> {
  return utf8.encode(`${FORMAT} v${FORMAT_VERSION}|${backupId}|${name}`);
}

async function gzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Part {
  v: number;
  gen: string;
  part: number;
  parts: number;
  created: string;
  entries: Array<[string, unknown]>;
}

async function seal(aes: CryptoKey, backupId: string, name: string, part: Part): Promise<Uint8Array<ArrayBuffer>> {
  const plain = await gzip(utf8.encode(JSON.stringify(part)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(backupId, name) }, aes, plain,
  ));
  const out = new Uint8Array(1 + iv.length + ct.length);
  out[0] = FORMAT_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + iv.length);
  return out;
}

async function open(aes: CryptoKey, backupId: string, name: string, bytes: Uint8Array<ArrayBuffer>): Promise<Part> {
  if (bytes[0] !== FORMAT_VERSION || bytes.length < 1 + 12 + 16) {
    throw new BackupDamaged(`backup part ${name} has an unknown format`);
  }
  let plain: Uint8Array<ArrayBuffer>;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(1, 13), additionalData: aad(backupId, name) },
      aes, bytes.slice(13),
    ));
  } catch {
    throw new BackupDamaged(`backup part ${name} failed to decrypt (altered or damaged)`);
  }
  const part = JSON.parse(new TextDecoder().decode(await gunzip(plain))) as Part;
  const m = CHUNK_NAME.exec(name);
  if (part.v !== FORMAT_VERSION || !m || part.gen !== m[1] || part.part !== Number(m[2])
      || !Array.isArray(part.entries)) {
    throw new BackupDamaged(`backup part ${name} does not match its name`);
  }
  return part;
}

/** Split entries into parts of at most PART_BYTES of JSON. Always ≥ 1 part. */
function split(entries: Array<[string, ArchivedValue]>): Array<Array<[string, ArchivedValue]>> {
  const parts: Array<Array<[string, ArchivedValue]>> = [[]];
  let size = 0;
  for (const e of entries) {
    const n = utf8.encode(JSON.stringify(e)).length + 1;
    if (size + n > PART_BYTES && parts[parts.length - 1]!.length > 0) {
      parts.push([]);
      size = 0;
    }
    parts[parts.length - 1]!.push(e);
    size += n;
  }
  return parts;
}

// ---------------------------------------------------------------- backup

export interface BackupStatus {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly totalBytes: number;
  /** This device remembers the key for this backup, so upload() works. */
  readonly unlocked: boolean;
}

export interface UploadResult {
  readonly entries: number;
  readonly parts: number;
  readonly bytes: number;
}

export interface RestoreResult {
  /** Entries in the backup. */
  readonly entries: number;
  /** Entries this device did not have and now does. */
  readonly added: number;
  /** When the restored backup was written. */
  readonly created: string;
}

interface ServerBackup {
  id: string;
  meta: string;
  created_at: string;
  updated_at: string;
  total_bytes: number;
  chunks: Array<{ name: string; size: number; updated_at: string }>;
}

/**
 * The account's recovery backup. Create one per session, after
 * startSession (storage must already point at the account).
 *
 * Typical use:
 * - signup / existing account with none: `key = RecoveryKey.generate()`,
 *   show it, confirm, then `create(key)`.
 * - from then on: `upload()` whenever worth it, and before sign-out
 *   (sign-out wipes the archive).
 * - new device or after sign-out: `restore(RecoveryKey.parse(typed))`.
 */
export class Backup {
  readonly #fetch: AuthedFetch;
  readonly #archive: BackupArchive;

  constructor(fetch: AuthedFetch, archive: BackupArchive = storage) {
    this.#fetch = fetch;
    this.#archive = archive;
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.#fetch(`/api/v1/me/backup${path}`, init);
    if (!res.ok) {
      let message = `backup request failed (${res.status})`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch { /* not JSON */ }
      throw new BackupHttpError(res.status, message);
    }
    return res;
  }

  async #server(): Promise<ServerBackup | null> {
    try {
      return (await (await this.#request("")).json()) as ServerBackup;
    } catch (err) {
      if (err instanceof BackupHttpError && err.status === 404) return null;
      throw err;
    }
  }

  /** The server's backup and whether this device can upload to it; null if none. */
  async status(): Promise<BackupStatus | null> {
    const s = await this.#server();
    if (!s) return null;
    const mine = await this.#archive.getBackupKey();
    return {
      id: s.id,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      totalBytes: s.total_bytes,
      unlocked: mine?.backupId === s.id,
    };
  }

  /**
   * Start a new backup under `key`, replacing any existing one (whose
   * contents become unreadable), remember the key here, and upload.
   */
  async create(key: RecoveryKey): Promise<UploadResult> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const { aes, check } = await derive(key, salt);
    const meta: Meta = {
      format: FORMAT, v: FORMAT_VERSION, kdf: "hkdf-sha256",
      salt: toB64(salt), check: toB64(check),
    };
    const res = await this.#request("", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta: toB64(utf8.encode(JSON.stringify(meta))) }),
    });
    const { id } = (await res.json()) as { id: string };
    await this.#archive.setBackupKey({ backupId: id, key: aes });
    return this.upload();
  }

  /**
   * Check `key` against the server's backup and remember it here, so
   * upload() works on this device. Throws NoBackup or WrongRecoveryKey.
   */
  async unlock(key: RecoveryKey): Promise<void> {
    const s = await this.#server();
    if (!s) throw new NoBackup();
    await this.#archive.setBackupKey({ backupId: s.id, key: await this.#unlockWith(s, key) });
  }

  async #unlockWith(s: ServerBackup, key: RecoveryKey): Promise<CryptoKey> {
    let meta: Meta;
    try {
      meta = JSON.parse(new TextDecoder().decode(fromB64(s.meta))) as Meta;
    } catch {
      throw new BackupDamaged("the backup header is unreadable");
    }
    if (meta.format !== FORMAT || meta.v !== FORMAT_VERSION || meta.kdf !== "hkdf-sha256") {
      throw new BackupDamaged("the backup was written by a newer or unknown version");
    }
    const { aes, check } = await derive(key, fromB64(meta.salt));
    if (!sameBytes(check, fromB64(meta.check))) throw new WrongRecoveryKey();
    return aes;
  }

  /**
   * Upload this device's whole archive as a new generation, then remove
   * the previous one. Uses the remembered key; throws NoBackup or
   * BackupLocked when there is none for the server's current backup.
   */
  async upload(): Promise<UploadResult> {
    const s = await this.#server();
    if (!s) throw new NoBackup();
    const mine = await this.#archive.getBackupKey();
    if (!mine || mine.backupId !== s.id) throw new BackupLocked();

    const entries = await this.#archive.exportArchive();
    const parts = split(entries);
    const gen = randomHex(8);
    const created = new Date().toISOString();
    let bytes = 0;

    for (let i = 0; i < parts.length; i++) {
      const name = `${gen}-${i}`;
      const body = await seal(mine.key, s.id, name, {
        v: FORMAT_VERSION, gen, part: i, parts: parts.length, created, entries: parts[i]!,
      });
      bytes += body.length;
      try {
        await this.#request(`/chunks/${name}?backup=${encodeURIComponent(s.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body,
        });
      } catch (err) {
        // 409: another device replaced the backup while this one uploaded.
        if (err instanceof BackupHttpError && err.status === 409) {
          await this.#archive.clearBackupKey();
          throw new BackupLocked();
        }
        throw err;
      }
    }

    // Only now that the new generation is complete: drop the old ones.
    for (const c of s.chunks) {
      if (!c.name.startsWith(`${gen}-`)) {
        await this.#request(`/chunks/${encodeURIComponent(c.name)}`, { method: "DELETE" });
      }
    }
    return { entries: entries.length, parts: parts.length, bytes };
  }

  /**
   * Download the backup, decrypt it with `key`, and add what this device
   * lacks to its archive. Also remembers the key, so this device keeps
   * the backup current from now on. Throws NoBackup, WrongRecoveryKey or
   * BackupDamaged (nothing imported in that case).
   */
  async restore(key: RecoveryKey): Promise<RestoreResult> {
    const s = await this.#server();
    if (!s) throw new NoBackup();
    const aes = await this.#unlockWith(s, key);

    // Group chunks by generation. Normally there is one; two means an
    // upload was interrupted, and the newest complete one wins.
    const gens = new Map<string, string[]>();
    for (const c of s.chunks) {
      const m = CHUNK_NAME.exec(c.name);
      if (!m) continue;
      gens.set(m[1]!, [...(gens.get(m[1]!) ?? []), c.name]);
    }

    const candidates: Array<{ first: Part; names: string[] }> = [];
    for (const [gen, names] of gens) {
      try {
        const first = await this.#part(aes, s.id, `${gen}-0`);
        const complete = names.length === first.parts
          && Array.from({ length: first.parts }, (_, i) => `${gen}-${i}`).every((n) => names.includes(n));
        if (complete) candidates.push({ first, names });
      } catch {
        /* a generation without a readable part 0 is incomplete */
      }
    }
    candidates.sort((a, b) => b.first.created.localeCompare(a.first.created));

    let lastError: unknown = new BackupDamaged("the backup has no complete copy to restore");
    for (const { first } of candidates) {
      try {
        const entries = [...first.entries];
        for (let i = 1; i < first.parts; i++) {
          const p = await this.#part(aes, s.id, `${first.gen}-${i}`);
          if (p.parts !== first.parts || p.created !== first.created) {
            throw new BackupDamaged("backup parts do not belong together");
          }
          entries.push(...p.entries);
        }
        const added = await this.#archive.importArchive(entries);
        await this.#archive.setBackupKey({ backupId: s.id, key: aes });
        return { entries: entries.length, added, created: first.created };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async #part(aes: CryptoKey, backupId: string, name: string): Promise<Part> {
    const res = await this.#request(`/chunks/${name}`);
    return open(aes, backupId, name, new Uint8Array(await res.arrayBuffer()));
  }

  /** Delete the backup from the server and forget the key here. */
  async remove(): Promise<void> {
    await this.#request("", { method: "DELETE" });
    await this.#archive.clearBackupKey();
  }
}
