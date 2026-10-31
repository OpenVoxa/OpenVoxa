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
 * What protects this today is browser origin isolation: no other site can
 * read it, and the server never sees it. What does NOT protect it is
 * encryption at rest - the values are stored as-is, so anyone with the
 * device and the ability to read browser profile data can read the keys.
 *
 * That is a real limitation and it is recorded as an open item in
 * docs/decisions.md rather than hidden. The fix is to wrap writes in a
 * key derived from the user's password or recovery key, which also needs
 * recovery keys to exist. Doing it half-way - encrypting with a key also
 * stored in IndexedDB - would look like protection while providing none.
 */

const DB_NAME = "openvoxa";
const DB_VERSION = 2;

const STORE_DEVICE = "device";
const STORE_KEYPAIRS = "keypairs";
const STORE_GROUPS = "groups";
const STORE_SENT = "sent";

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

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

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

export const storage = {
  async getDevice(): Promise<StoredDevice | undefined> {
    return run<StoredDevice | undefined>(STORE_DEVICE, "readonly", (s) =>
      s.get("self") as IDBRequest<StoredDevice | undefined>,
    );
  },

  async setDevice(device: StoredDevice): Promise<void> {
    await run(STORE_DEVICE, "readwrite", (s) => s.put(device, "self"));
  },

  async clearDevice(): Promise<void> {
    await run(STORE_DEVICE, "readwrite", (s) => s.delete("self"));
  },

  async putKeyPair(pair: StoredKeyPair): Promise<void> {
    await run(STORE_KEYPAIRS, "readwrite", (s) => s.put(pair));
  },

  async getKeyPair(id: string): Promise<StoredKeyPair | undefined> {
    return run<StoredKeyPair | undefined>(STORE_KEYPAIRS, "readonly", (s) =>
      s.get(id) as IDBRequest<StoredKeyPair | undefined>,
    );
  },

  async listKeyPairs(): Promise<StoredKeyPair[]> {
    return run<StoredKeyPair[]>(STORE_KEYPAIRS, "readonly", (s) =>
      s.getAll() as IDBRequest<StoredKeyPair[]>,
    );
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
    await run(STORE_SENT, "readwrite", (s) => s.put(text, messageId));
  },

  async getPlaintext(messageId: string): Promise<string | undefined> {
    return run<string | undefined>(STORE_SENT, "readonly", (s) =>
      s.get(messageId) as IDBRequest<string | undefined>,
    );
  },

  async deletePlaintext(messageId: string): Promise<void> {
    await run(STORE_SENT, "readwrite", (s) => s.delete(messageId));
  },

  async getGroup(channelId: string): Promise<unknown> {
    return run<unknown>(STORE_GROUPS, "readonly", (s) => s.get(channelId));
  },

  async setGroup(channelId: string, state: unknown): Promise<void> {
    await run(STORE_GROUPS, "readwrite", (s) => s.put(state, channelId));
  },

  /**
   * Destroy everything.
   *
   * Called on logout and on account deletion. Leaving key material behind
   * on a shared machine after someone signs out would be a quiet way of
   * undoing the entire point.
   */
  async wipe(): Promise<void> {
    const db = await open();
    await Promise.all(
      [STORE_DEVICE, STORE_KEYPAIRS, STORE_GROUPS, STORE_SENT].map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction(name, "readwrite");
            const request = tx.objectStore(name).clear();
            request.onsuccess = () => resolve();
            request.onerror = () =>
              reject(request.error ?? new Error("indexeddb: clear failed"));
          }),
      ),
    );
    db.close();
  },
};
