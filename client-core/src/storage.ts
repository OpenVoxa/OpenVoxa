// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local storage for cryptographic material.
 *
 * IndexedDB rather than localStorage for two reasons: it stores
 * structured values, so key material survives as Uint8Array rather than
 * being stringified and parsed back, and it is not synchronous, so
 * nothing blocks the page while reading a large group state.
 *
 * Every value is encrypted (AES-256-GCM) under this account database's
 * data key, which the password unlocks at sign-in and a per-session
 * server secret unlocks on refresh (localkey.ts; decisions.md,
 * Encryption, "Local storage is encrypted under the password, with a
 * server-held half for refreshes"). Each value's additional data names
 * its store and record key, so a value cannot be moved to another record
 * without failing to decrypt. Record keys (channel ids, message ids,
 * key package digests) are NOT encrypted: someone with the files can
 * count messages and channels, not read them.
 *
 * The keyring record (the wrapped data key) is the one unencrypted value.
 * Nothing can be read or written until unlock() or unlockFromSession()
 * has succeeded; until then every call throws StorageLocked.
 */

import { decodeTagged, encodeTagged } from "./codec.js";
import { DataKey, isKeyring, seal, unseal, type Keyring } from "./localkey.js";

/**
 * One database per account, named after the account.
 *
 * A browser profile used for two accounts at once (two windows, signed in
 * as different people) used to share one database, and so one device
 * identity and one copy of every group. Each window kept overwriting the
 * other's, and a window that loaded the other account's group state
 * removed its own real leaf as a "duplicate" and rejoined, in a loop
 * (found on Docker, 2026-10-31). Per-account databases make the two
 * windows independent. Data from the old shared database is moved into
 * the right account's database once; see useAccount.
 */
const LEGACY_DB_NAME = "openvoxa";
const DB_VERSION = 2;

let dbName = LEGACY_DB_NAME;

const STORE_DEVICE = "device";
const STORE_KEYPAIRS = "keypairs";
const STORE_GROUPS = "groups";
const STORE_SENT = "sent";

/** Device-store record keys. KEYRING is the only unencrypted value. */
const SELF = "self";
const BACKUP = "backup";
const KEYRING = "keyring";

/** The unlocked data key for the current account database, if any. */
let dataKey: DataKey | null = null;

/** Thrown by every read and write while storage is locked. */
export class StorageLocked extends Error {
  constructor() {
    super("this browser's encrypted storage is locked; sign in again");
  }
}

/** How unlock() went; see storage.unlock. */
export type UnlockResult = "unlocked" | "created" | "upgraded" | "mismatch";

export interface StoredDevice {
  readonly id: string;
  readonly label: string;
  readonly userId: string;
  readonly createdAt: number;
}

/**
 * One generated key package, public and private halves together.
 *
 * Kept until the package is used to join a group. The private half is the
 * only thing that can decrypt the welcome message someone sends when they
 * add this device, so losing it means the add silently fails.
 */
export interface StoredKeyPair {
  readonly id: string;
  readonly publicPackage: unknown;
  readonly privatePackage: unknown;
  readonly createdAt: number;
}

/**
 * Who shared a message. deviceId is the sharer's own claim from inside
 * the encrypted bundle, checked against the server's record of who
 * uploaded it; verified is false when the two disagree.
 */
export interface SharedBy {
  deviceId: string;
  username?: string;
  verified: boolean;
}

/** Archive values: plain text, or text with who shared it. */
export type ArchivedValue = string | { text: string; sharedBy: SharedBy };

function isArchivedValue(v: unknown): v is ArchivedValue {
  if (typeof v === "string") return true;
  if (typeof v !== "object" || v === null) return false;
  const o = v as { text?: unknown; sharedBy?: unknown };
  return typeof o.text === "string" && typeof o.sharedBy === "object" && o.sharedBy !== null;
}

/** See storage.getBackupKey. `key` is an AES-GCM CryptoKey: extractable when
 * given to setBackupKey, non-extractable when getBackupKey returns it. */
export interface StoredBackupKey {
  /** The server backup this key belongs to; a different id means replaced. */
  readonly backupId: string;
  readonly key: CryptoKey;
}

/** Key prefix of edit marks in the archive store; see putEdited. */
export const EDIT_PREFIX = "edit:";

/** Server timestamps compare by instant, not by how they were formatted. */
export function normalizeTime(t: string): string {
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? t : new Date(ms).toISOString();
}

const ALL_STORES = [STORE_DEVICE, STORE_KEYPAIRS, STORE_GROUPS, STORE_SENT];

function open(name: string = dbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DEVICE)) {
        db.createObjectStore(STORE_DEVICE);
      }
      if (!db.objectStoreNames.contains(STORE_KEYPAIRS)) {
        db.createObjectStore(STORE_KEYPAIRS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_GROUPS)) {
        db.createObjectStore(STORE_GROUPS);
      }
      if (!db.objectStoreNames.contains(STORE_SENT)) {
        db.createObjectStore(STORE_SENT);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb: open failed"));
  });
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = operation(tx.objectStore(store));

        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error("indexeddb: operation failed"));
        tx.oncomplete = () => db.close();
      }),
  );
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb: operation failed"));
  });
}

/**
 * Move the old shared database into this account's, if it belongs to
 * this account. One belonging to another account is left for that
 * account's first sign-in. Copied store by store with keys, then the old
 * database is deleted.
 */
async function migrateLegacy(userId: string): Promise<void> {
  // Opening a database creates it, so check it exists first where the
  // browser can say; otherwise every sign-in would leave an empty one.
  if (typeof indexedDB.databases === "function") {
    const names = (await indexedDB.databases()).map((d) => d.name);
    if (!names.includes(LEGACY_DB_NAME)) return;
  }
  const legacy = await open(LEGACY_DB_NAME);
  try {
    const tx = legacy.transaction(STORE_DEVICE, "readonly");
    const device = (await request(tx.objectStore(STORE_DEVICE).get("self"))) as
      | StoredDevice
      | undefined;
    if (!device || device.userId !== userId) return;

    const target = await open(dbName);
    try {
      // Any device record (identity, keyring, backup key) means this
      // database is already in use: never overwrite it, and never put
      // the legacy plaintext beside encrypted data. Without a keyring the
      // copy is encrypted at the next password sign-in (unlock).
      const existing = await request(
        target.transaction(STORE_DEVICE, "readonly").objectStore(STORE_DEVICE).count(),
      );
      if (existing > 0) return;

      for (const name of ALL_STORES) {
        const src = legacy.transaction(name, "readonly").objectStore(name);
        const [keys, values] = await Promise.all([
          request(src.getAllKeys()),
          request(src.getAll()),
        ]);
        const out = target.transaction(name, "readwrite");
        const dst = out.objectStore(name);
        values.forEach((value, i) => {
          // Stores with a keyPath take the key from the value itself.
          if (dst.keyPath === null) dst.put(value, keys[i]);
          else dst.put(value);
        });
        await new Promise<void>((resolve, reject) => {
          out.oncomplete = () => resolve();
          out.onerror = () => reject(out.error ?? new Error("indexeddb: copy failed"));
        });
      }
    } finally {
      target.close();
    }
  } finally {
    legacy.close();
  }
  await new Promise<void>((resolve) => {
    const del = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    // A blocked delete (another old tab still open) is not worth failing
    // sign-in over; the copy is already safe.
    del.onsuccess = del.onerror = del.onblocked = () => resolve();
  });
}

// ---------------------------------------------------------------- sealing

const utf8 = new TextEncoder();

/** A stored, encrypted value. Key-package records also carry their id. */
interface Sealed {
  readonly c: Uint8Array;
  readonly id?: string;
}

function isSealed(v: unknown): v is Sealed {
  return typeof v === "object" && v !== null && (v as Sealed).c instanceof Uint8Array;
}

function aadFor(store: string, key: IDBValidKey): Uint8Array {
  return utf8.encode(`openvoxa local v1|${store}|${String(key)}`);
}

/**
 * Plaintext framing before encryption: byte 0 says how the rest is
 * encoded. Group states are already bytes and are stored as they are;
 * everything else goes through tagged JSON (codec.ts).
 */
const FRAME_BYTES = 0;
const FRAME_TAGGED = 1;

function frame(value: unknown): Uint8Array {
  const body = value instanceof Uint8Array ? value : encodeTagged(value);
  const out = new Uint8Array(body.length + 1);
  out[0] = value instanceof Uint8Array ? FRAME_BYTES : FRAME_TAGGED;
  out.set(body, 1);
  return out;
}

function unframe(bytes: Uint8Array): unknown {
  const body = bytes.subarray(1);
  switch (bytes[0]) {
    case FRAME_BYTES: return new Uint8Array(body);
    case FRAME_TAGGED: return decodeTagged(body);
    default: throw new Error("storage: unknown value framing");
  }
}

function requireKey(): DataKey {
  if (!dataKey) throw new StorageLocked();
  return dataKey;
}

async function sealValue(dk: DataKey, store: string, key: IDBValidKey, value: unknown): Promise<Sealed> {
  const c = await seal(dk.key, aadFor(store, key), frame(value));
  return store === STORE_KEYPAIRS ? { id: String(key), c } : { c };
}

/**
 * Decrypt a stored value. A value that is not sealed, or does not
 * decrypt, is reported and treated as missing: a group then rejoins, a
 * device registers anew. That beats a page that cannot start.
 */
async function openValue(dk: DataKey, store: string, key: IDBValidKey, stored: unknown): Promise<unknown> {
  if (stored === undefined) return undefined;
  if (!isSealed(stored)) {
    console.warn(`storage: unencrypted value in ${store}/${String(key)} ignored`);
    return undefined;
  }
  try {
    return unframe(await unseal(dk.key, aadFor(store, key), stored.c));
  } catch {
    console.warn(`storage: value in ${store}/${String(key)} does not decrypt; ignored`);
    return undefined;
  }
}

async function getValue<T>(store: string, key: string): Promise<T | undefined> {
  const dk = requireKey();
  const stored = await run<unknown>(store, "readonly", (s) => s.get(key));
  return (await openValue(dk, store, key, stored)) as T | undefined;
}

async function putValue(store: string, key: string, value: unknown): Promise<void> {
  const sealed = await sealValue(requireKey(), store, key, value);
  await run(store, "readwrite", (s) =>
    s.keyPath === null ? s.put(sealed, key) : s.put(sealed));
}

/** Every record of a store, decrypted, skipping any that do not open. */
async function getAllValues(store: string): Promise<Array<[string, unknown]>> {
  const dk = requireKey();
  const db = await open();
  let keys: IDBValidKey[];
  let values: unknown[];
  try {
    const s = db.transaction(store, "readonly").objectStore(store);
    // getAllKeys and getAll walk the store in the same key order.
    [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll())]);
  } finally {
    db.close();
  }
  const out: Array<[string, unknown]> = [];
  for (let i = 0; i < keys.length; i++) {
    const v = await openValue(dk, store, keys[i]!, values[i]);
    if (v !== undefined) out.push([String(keys[i]), v]);
  }
  return out;
}

function txDone(tx: IDBTransaction, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`indexeddb: ${what} failed`));
    tx.onabort = () => reject(tx.error ?? new Error(`indexeddb: ${what} aborted`));
  });
}

async function readKeyring(): Promise<Keyring | undefined> {
  const v = await run<unknown>(STORE_DEVICE, "readonly", (s) => s.get(KEYRING));
  return isKeyring(v) ? v : undefined;
}

async function hasDevice(): Promise<boolean> {
  const n = await run<number>(STORE_DEVICE, "readonly", (s) => s.count(SELF));
  return n > 0;
}

/**
 * Encrypt everything in this database under a new data key and store its
 * keyring, in one transaction: either all of it is encrypted with the
 * keyring present, or nothing changed. Returns whether there was any
 * data (an upgrade) or the database was empty.
 *
 * The remembered backup key is dropped: it is a non-extractable
 * CryptoKey, so it cannot be encrypted. The app's "enter your recovery
 * key" prompt brings it back once. Values that already look encrypted
 * cannot be read without a keyring and are dropped too.
 */
async function encryptInPlace(dk: DataKey, ring: Keyring): Promise<boolean> {
  const db = await open();
  try {
    const plain = new Map<string, Array<[IDBValidKey, unknown]>>();
    const read = db.transaction(ALL_STORES, "readonly");
    for (const name of ALL_STORES) {
      const s = read.objectStore(name);
      const [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll())]);
      plain.set(name, keys.map((k, i) => [k, values[i]]));
    }

    let found = false;
    const sealed = new Map<string, Array<[IDBValidKey, Sealed]>>();
    for (const name of ALL_STORES) {
      const out: Array<[IDBValidKey, Sealed]> = [];
      for (const [k, v] of plain.get(name)!) {
        if (name === STORE_DEVICE && (k === KEYRING || k === BACKUP)) continue;
        if (isSealed(v)) continue;
        found = true;
        out.push([k, await sealValue(dk, name, k, v)]);
      }
      sealed.set(name, out);
    }

    const write = db.transaction(ALL_STORES, "readwrite");
    for (const name of ALL_STORES) {
      const s = write.objectStore(name);
      s.clear();
      for (const [k, v] of sealed.get(name)!) {
        if (s.keyPath === null) s.put(v, k);
        else s.put(v);
      }
    }
    write.objectStore(STORE_DEVICE).put(ring, KEYRING);
    await txDone(write, "encrypting local storage");
    return found;
  } finally {
    db.close();
  }
}

/** Clear every store; keep the keyring unless told otherwise. */
async function clearAll(keepKeyring: boolean): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(ALL_STORES, "readwrite");
    for (const name of ALL_STORES) {
      if (name !== STORE_DEVICE || !keepKeyring) {
        tx.objectStore(name).clear();
        continue;
      }
      const s = tx.objectStore(name);
      s.getAllKeys().onsuccess = (e) => {
        for (const k of (e.target as IDBRequest<IDBValidKey[]>).result) {
          if (k !== KEYRING) s.delete(k);
        }
      };
    }
    await txDone(tx, "clear");
  } finally {
    db.close();
  }
}

export const storage = {
  /**
   * Point storage at one account's database. Called once per page, at
   * sign-in, before anything is read or written. Switching to another
   * account locks storage.
   */
  async useAccount(userId: string): Promise<void> {
    const name = `${LEGACY_DB_NAME}-${userId}`;
    if (name !== dbName) dataKey = null;
    dbName = name;
    try {
      await migrateLegacy(userId);
    } catch {
      // Migration is a convenience: without it this account simply
      // starts with a new device, as on a fresh browser.
    }
  },

  isUnlocked(): boolean {
    return dataKey !== null;
  },

  /** Forget the data key; storage throws StorageLocked until unlocked. */
  lock(): void {
    dataKey = null;
  },

  /**
   * Unlock with the password, at sign-in. Results:
   *
   * - "unlocked": the keyring opened.
   * - "created": there was nothing stored (or no keyring and no data);
   *   a new data key and keyring now exist.
   * - "upgraded": data from before encryption existed and has now been
   *   encrypted under a new data key. The remembered backup key was
   *   dropped (see encryptInPlace).
   * - "mismatch": the keyring does not open with this password, and
   *   there is data under it. The password was changed from another
   *   browser. Storage stays locked; the caller decides, normally with
   *   discardAndUnlock() and a recovery-key restore.
   *
   * Argon2id makes this take a noticeable fraction of a second.
   */
  async unlock(password: string): Promise<UnlockResult> {
    const ring = await readKeyring();
    if (ring) {
      const dk = await DataKey.unwrap(ring, password);
      if (dk) {
        dataKey = dk;
        return "unlocked";
      }
      if (await hasDevice()) return "mismatch";
      // A keyring over an empty database (after sign-out, say) protects
      // nothing; replace it rather than refuse.
      await clearAll(false);
    }
    const dk = await DataKey.generate();
    const upgraded = await encryptInPlace(dk, await dk.wrap(password));
    dataKey = dk;
    return upgraded ? "upgraded" : "created";
  },

  /**
   * After "mismatch": destroy this browser's data for the account
   * (unreadable without the old password anyway) and start over with a
   * new keyring. The caller then registers a new device as usual.
   */
  async discardAndUnlock(password: string): Promise<UnlockResult> {
    dataKey = null;
    await clearAll(false);
    return this.unlock(password);
  },

  /**
   * Re-encrypt the data key under a new password, after a password
   * change. Only the keyring changes; the data is untouched.
   */
  async rewrap(newPassword: string): Promise<void> {
    const ring = await requireKey().wrap(newPassword);
    await run(STORE_DEVICE, "readwrite", (s) => s.put(ring, KEYRING));
  },

  /**
   * The session copy of the data key, encrypted under the server's
   * per-session secret, for the tab to keep in sessionStorage.
   */
  async sessionCopy(secret: Uint8Array): Promise<string> {
    return requireKey().wrapForSession(secret);
  },

  /**
   * Unlock on refresh from the session copy. False when the secret does
   * not open it, or the key it holds is not this database's (no keyring,
   * or a different one): the caller then asks for the password.
   */
  async unlockFromSession(copy: string, secret: Uint8Array): Promise<boolean> {
    const dk = await DataKey.unwrapForSession(copy, secret);
    const ring = await readKeyring();
    if (!dk || !ring || !(await dk.opens(ring))) return false;
    dataKey = dk;
    return true;
  },

  async getDevice(): Promise<StoredDevice | undefined> {
    return getValue<StoredDevice>(STORE_DEVICE, SELF);
  },

  async setDevice(device: StoredDevice): Promise<void> {
    await putValue(STORE_DEVICE, SELF, device);
  },

  async clearDevice(): Promise<void> {
    await run(STORE_DEVICE, "readwrite", (s) => s.delete(SELF));
  },

  async putKeyPair(pair: StoredKeyPair): Promise<void> {
    await putValue(STORE_KEYPAIRS, pair.id, pair);
  },

  async getKeyPair(id: string): Promise<StoredKeyPair | undefined> {
    return getValue<StoredKeyPair>(STORE_KEYPAIRS, id);
  },

  async listKeyPairs(): Promise<StoredKeyPair[]> {
    return (await getAllValues(STORE_KEYPAIRS)).map(([, v]) => v as StoredKeyPair);
  },

  async deleteKeyPair(id: string): Promise<void> {
    await run(STORE_KEYPAIRS, "readwrite", (s) => s.delete(id));
  },

  /**
   * The local message archive: plaintext of every message this device
   * has read or sent in an encrypted channel, keyed by message id.
   *
   * MLS gives forward secrecy by deleting each message key the moment it
   * is used. So a message can be decrypted exactly once: reload the page,
   * fetch history again, and the ciphertext is unreadable to the very
   * device that read it a minute ago. Senders are worse off still: they
   * cannot decrypt their own application messages at all.
   *
   * Every MLS client solves this the same way, by keeping its own
   * plaintext once it has it. That is a real cost of the design and worth
   * stating: this copy is as readable as any other local data, so "the
   * server cannot read your messages" remains true while "nothing on your
   * device can" does not. It must also be deleted when the message is,
   * or a deletion would only ever reach the server.
   *
   * The object store is still called "sent" because it began as only
   * this device's own messages; renaming it would need a migration for
   * no change in behaviour.
   */
  async putPlaintext(messageId: string, text: string): Promise<void> {
    await putValue(STORE_SENT, messageId, text);
  },

  async getPlaintext(messageId: string): Promise<string | undefined> {
    const value = await getValue<ArchivedValue>(STORE_SENT, messageId);
    return typeof value === "string" ? value : value?.text;
  },

  /**
   * Store a message another member shared (history sharing), unless this
   * device already has its own copy. The sharer is kept with it, because
   * a shared message is that member's word for what was said: nothing
   * here can prove it matches the original (decisions.md, "History
   * sharing is opt-in per channel").
   */
  async putShared(messageId: string, text: string, sharedBy: SharedBy): Promise<boolean> {
    if ((await this.getPlaintext(messageId)) !== undefined) return false;
    await putValue(STORE_SENT, messageId, { text, sharedBy });
    return true;
  },

  /** Who shared a message, or undefined for one this device read itself. */
  async getSharedBy(messageId: string): Promise<SharedBy | undefined> {
    const value = await getValue<ArchivedValue>(STORE_SENT, messageId);
    return typeof value === "object" && value ? value.sharedBy : undefined;
  },

  async deletePlaintext(messageId: string): Promise<void> {
    await run(STORE_SENT, "readwrite", (s) => s.delete(messageId));
    await run(STORE_SENT, "readwrite", (s) => s.delete(EDIT_PREFIX + messageId));
  },

  /**
   * Store the plaintext of an edited message, replacing the earlier
   * version, together with the server's edited_at for it. The mark lets a
   * later history load tell whether the archive holds the latest edit or
   * an older version (the message was edited again while this device was
   * away). It lives in the same store under "edit:<id>", as a plain
   * string, so backups carry it with no format change.
   */
  async putEdited(messageId: string, text: string, editedAt: string): Promise<void> {
    await putValue(STORE_SENT, messageId, text);
    await putValue(STORE_SENT, EDIT_PREFIX + messageId, normalizeTime(editedAt));
  },

  /** The edited_at of the version archived for a message, if it was edited. */
  async getEditedAt(messageId: string): Promise<string | undefined> {
    const v = await getValue<unknown>(STORE_SENT, EDIT_PREFIX + messageId);
    return typeof v === "string" ? v : undefined;
  },

  /**
   * Every archive entry, decrypted, for the recovery backup (recovery.ts).
   * Values are plain text, or text with who shared it.
   */
  async exportArchive(): Promise<Array<[string, ArchivedValue]>> {
    return (await getAllValues(STORE_SENT)).filter(
      (e): e is [string, ArchivedValue] => isArchivedValue(e[1]),
    );
  },

  /**
   * Add restored archive entries this device does not already have, and
   * return how many were added. A local copy always wins: it is this
   * device's own reading, the backup is older or equal. Malformed
   * entries are skipped rather than failing the whole restore.
   *
   * Encryption is async and an IndexedDB transaction cannot wait for it,
   * so entries are encrypted first and the write transaction checks
   * again that each id is still absent before putting it.
   */
  async importArchive(entries: Array<[string, unknown]>): Promise<number> {
    const dk = requireKey();
    const before = new Set(
      (await run<IDBValidKey[]>(STORE_SENT, "readonly", (s) => s.getAllKeys())).map(String),
    );
    const prepared: Array<[string, Sealed]> = [];
    const chosen = new Set<string>();
    for (const [id, value] of entries) {
      if (typeof id !== "string" || before.has(id) || chosen.has(id) || !isArchivedValue(value)) continue;
      // An edit mark only describes the text it was stored with: keep
      // it only when that text is being imported too, never beside a
      // version this device already had.
      if (id.startsWith(EDIT_PREFIX) && before.has(id.slice(EDIT_PREFIX.length))) continue;
      chosen.add(id);
      prepared.push([id, await sealValue(dk, STORE_SENT, id, value)]);
    }

    const db = await open();
    try {
      const tx = db.transaction(STORE_SENT, "readwrite");
      const store = tx.objectStore(STORE_SENT);
      let added = 0;
      for (const [id, sealed] of prepared) {
        store.count(id).onsuccess = (e) => {
          if ((e.target as IDBRequest<number>).result > 0) return;
          store.put(sealed, id);
          // Edit marks ride along but are not messages.
          if (!id.startsWith(EDIT_PREFIX)) added++;
        };
      }
      await txDone(tx, "import");
      return added;
    } finally {
      db.close();
    }
  },

  /**
   * The recovery backup key remembered on this device, so later uploads
   * need no typing. Stored as raw bytes, encrypted like everything else,
   * and handed back as a non-extractable CryptoKey.
   */
  async getBackupKey(): Promise<StoredBackupKey | undefined> {
    const v = await getValue<{ backupId: string; raw: Uint8Array }>(STORE_DEVICE, BACKUP);
    if (!v || typeof v.backupId !== "string" || !(v.raw instanceof Uint8Array)) return undefined;
    const key = await crypto.subtle.importKey(
      "raw", new Uint8Array(v.raw), "AES-GCM", false, ["encrypt", "decrypt"],
    );
    return { backupId: v.backupId, key };
  },

  /** The key must be extractable (recovery.ts derive() makes it so). */
  async setBackupKey(value: StoredBackupKey): Promise<void> {
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", value.key));
    await putValue(STORE_DEVICE, BACKUP, { backupId: value.backupId, raw });
  },

  async clearBackupKey(): Promise<void> {
    await run(STORE_DEVICE, "readwrite", (s) => s.delete(BACKUP));
  },

  async getGroup(channelId: string): Promise<unknown> {
    return getValue<unknown>(STORE_GROUPS, channelId);
  },

  async setGroup(channelId: string, state: unknown): Promise<void> {
    await putValue(STORE_GROUPS, channelId, state);
  },

  async deleteGroup(channelId: string): Promise<void> {
    await run(STORE_GROUPS, "readwrite", (s) => s.delete(channelId));
  },

  /**
   * Destroy everything but the keyring.
   *
   * Called when the server says this device was revoked (unused for 30
   * days, or removed in Settings), on account deletion, and by the
   * debug page's "Forget device". NOT on an ordinary sign-out, which
   * keeps the device, encrypted, for the password to unlock next time
   * (decisions.md, Encryption, sign-out bullet). The keyring stays so a
   * revoked device can register its replacement without the password;
   * over an empty database it guards nothing, and the next password
   * sign-in replaces it if it no longer matches. Callers that are done
   * with the account also call lock().
   */
  async wipe(): Promise<void> {
    await clearAll(true);
  },
};
