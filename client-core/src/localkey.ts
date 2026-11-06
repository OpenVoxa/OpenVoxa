// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The key that encrypts this browser's local storage, and the two ways to
 * unlock it (docs/decisions.md, Encryption, "Local storage is encrypted
 * under the password, with a server-held half for refreshes").
 *
 * - The data key: 32 random bytes per account database. storage.ts
 *   encrypts every value with it (AES-256-GCM).
 * - The keyring: the data key encrypted under a key derived from the
 *   password with Argon2id. Stored unencrypted beside the data, together
 *   with the salt and Argon2id settings; useless without the password.
 * - Or, for a browser signed in by QR login (no password ever typed
 *   there), a device keyring: the data key under a per-browser secret the
 *   server keeps and releases only to a signed-in session of the account
 *   (GET /api/v1/me/device-secrets/{id}). The first password sign-in
 *   turns it into a password keyring.
 * - The session copy: the data key encrypted under a per-login-session
 *   secret the server keeps (GET /api/v1/me/unlock-secret). The tab keeps
 *   it in sessionStorage so a page refresh unlocks without the password.
 *   When the session ends, the server's half is gone and so is the copy.
 *
 * hash-wasm runs Argon2id as WebAssembly. A Content-Security-Policy on
 * the page would need 'wasm-unsafe-eval' in script-src for it.
 */

import { argon2id } from "hash-wasm";

const DATA_KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/**
 * Argon2id settings for new keyrings: 64 MiB, 3 passes, 1 lane. About
 * 0.2 s in Node on Docker; browsers on slower machines take longer.
 * Stored in every keyring, so changing these affects only new ones (and
 * any rewrap, which uses the current values).
 */
const KDF = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 } as const;

const utf8 = new TextEncoder();
const KEYRING_AAD = utf8.encode("openvoxa local keyring v1");
const SESSION_AAD = utf8.encode("openvoxa session unlock v1");
const CHECK_AAD = utf8.encode("openvoxa local keyring check v1");
const DEVICE_AAD = utf8.encode("openvoxa device keyring v1");

/** The unencrypted record that holds the wrapped data key. */
export type Keyring = PasswordKeyring | DeviceKeyring;

/** The data key under the password. */
export interface PasswordKeyring {
  readonly v: 1;
  readonly kdf: {
    readonly alg: "argon2id";
    readonly memoryKiB: number;
    readonly iterations: number;
    readonly parallelism: number;
  };
  readonly salt: Uint8Array;
  /** IV followed by AES-GCM ciphertext of the data key. */
  readonly wrapped: Uint8Array;
  /**
   * Nothing, sealed under the data key itself. Lets a data key from a
   * session copy prove it belongs to this keyring without the password.
   */
  readonly check: Uint8Array;
}

/** The data key under a server-held device secret (QR login). */
export interface DeviceKeyring {
  readonly v: 1;
  readonly kdf: {
    readonly alg: "server";
    /** The device secret's id on the server. */
    readonly id: string;
  };
  readonly wrapped: Uint8Array;
  readonly check: Uint8Array;
}

export function isKeyring(v: unknown): v is Keyring {
  if (typeof v !== "object" || v === null) return false;
  const k = v as { v?: unknown; kdf?: { alg?: unknown; id?: unknown }; salt?: unknown;
    wrapped?: unknown; check?: unknown };
  if (k.v !== 1 || !(k.wrapped instanceof Uint8Array) || !(k.check instanceof Uint8Array)) return false;
  if (k.kdf?.alg === "argon2id") return k.salt instanceof Uint8Array;
  return k.kdf?.alg === "server" && typeof k.kdf.id === "string";
}

export function isDeviceKeyring(k: Keyring): k is DeviceKeyring {
  return k.kdf.alg === "server";
}

function aesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, usages);
}

/** AES-GCM with a fresh random IV, returned as IV || ciphertext. */
export async function seal(key: CryptoKey, aad: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new Uint8Array(aad) }, key, new Uint8Array(plain),
  ));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return out;
}

/** Undo seal. Throws when the key or AAD is wrong or the bytes changed. */
export async function unseal(key: CryptoKey, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < IV_BYTES + 16) throw new Error("localkey: sealed value too short");
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.slice(0, IV_BYTES), additionalData: new Uint8Array(aad) },
    key, sealed.slice(IV_BYTES),
  ));
}

async function passwordKey(password: string, salt: Uint8Array, kdf: PasswordKeyring["kdf"]): Promise<CryptoKey> {
  const raw = await argon2id({
    password: password.normalize("NFC"),
    salt,
    memorySize: kdf.memoryKiB,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    hashLength: 32,
    outputType: "binary",
  });
  return aesKey(raw, ["encrypt", "decrypt"]);
}

/** A data key, usable for storage, kept with its raw bytes for rewraps. */
export class DataKey {
  private constructor(readonly raw: Uint8Array, readonly key: CryptoKey) {}

  static async fromRaw(raw: Uint8Array): Promise<DataKey> {
    if (raw.length !== DATA_KEY_BYTES) throw new Error("localkey: data key has the wrong length");
    return new DataKey(raw, await aesKey(raw, ["encrypt", "decrypt"]));
  }

  static generate(): Promise<DataKey> {
    return DataKey.fromRaw(crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES)));
  }

  /** A keyring holding this key under the password (new salt each time). */
  async wrap(password: string): Promise<PasswordKeyring> {
    const kdf = { alg: "argon2id" as const, ...KDF };
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const wrapped = await seal(await passwordKey(password, salt, kdf), KEYRING_AAD, this.raw);
    const check = await seal(this.key, CHECK_AAD, new Uint8Array(0));
    return { v: 1, kdf, salt, wrapped, check };
  }

  /** Whether this is the data key the keyring holds. */
  async opens(ring: Keyring): Promise<boolean> {
    try {
      await unseal(this.key, CHECK_AAD, ring.check);
      return true;
    } catch {
      return false;
    }
  }

  /** A device keyring holding this key under a server-held secret. */
  async wrapForDevice(id: string, secret: Uint8Array): Promise<DeviceKeyring> {
    const wrapped = await seal(await aesKey(secret, ["encrypt"]), DEVICE_AAD, this.raw);
    const check = await seal(this.key, CHECK_AAD, new Uint8Array(0));
    return { v: 1, kdf: { alg: "server", id }, wrapped, check };
  }

  /** The key from a device keyring, or null when the secret does not open it. */
  static async unwrapForDevice(ring: DeviceKeyring, secret: Uint8Array): Promise<DataKey | null> {
    try {
      return await DataKey.fromRaw(await unseal(await aesKey(secret, ["decrypt"]), DEVICE_AAD, ring.wrapped));
    } catch {
      return null;
    }
  }

  /** The key from a keyring, or null when the password does not open it. */
  static async unwrap(ring: PasswordKeyring, password: string): Promise<DataKey | null> {
    const kek = await passwordKey(password, ring.salt, ring.kdf);
    try {
      return await DataKey.fromRaw(await unseal(kek, KEYRING_AAD, ring.wrapped));
    } catch {
      return null;
    }
  }

  /** The session copy: this key under the server's per-session secret, as base64. */
  async wrapForSession(secret: Uint8Array): Promise<string> {
    const sealed = await seal(await aesKey(secret, ["encrypt"]), SESSION_AAD, this.raw);
    return toBase64(sealed);
  }

  /** Undo wrapForSession, or null when the secret does not match. */
  static async unwrapForSession(copy: string, secret: Uint8Array): Promise<DataKey | null> {
    try {
      const raw = await unseal(await aesKey(secret, ["decrypt"]), SESSION_AAD, fromBase64(copy));
      return await DataKey.fromRaw(raw);
    } catch {
      return null;
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
