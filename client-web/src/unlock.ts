// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unlocking this browser's encrypted storage (client-core localkey.ts,
 * storage.ts; decisions.md, Encryption, "Local storage is encrypted under
 * the password, with a server-held half for refreshes").
 *
 * - At sign-in the password unlocks it (unlockWithPassword).
 * - The tab then keeps a session copy of the data key in sessionStorage,
 *   encrypted under a secret the server holds for this login session.
 * - A page refresh fetches that secret and unlocks without the password
 *   (unlockOnRefresh). When the session ends, the secret is gone and the
 *   copy is useless; the user signs in again.
 */

import { storage, type DeviceSecrets, type LinkUnlockResult, type UnlockResult } from "@core/storage";
import { ApiError, call, isUnreachable, type Session } from "./api";
import { clearUnlockCopy, loadUnlockCopy, saveUnlockCopy } from "./session";

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sessionSecret(token: string): Promise<Uint8Array> {
  const r = await call<{ secret: string }>("/api/v1/me/unlock-secret", { token });
  return fromBase64(r.secret);
}

/**
 * The server's device secrets (QR login): what opens this browser's
 * storage when it was signed in by a link, not a password.
 */
export function deviceSecrets(token: string): DeviceSecrets {
  return {
    async create() {
      const r = await call<{ id: string; secret: string }>("/api/v1/me/device-secrets", { method: "POST", token });
      return { id: r.id, secret: fromBase64(r.secret) };
    },
    async get(id) {
      try {
        const r = await call<{ secret: string }>(`/api/v1/me/device-secrets/${encodeURIComponent(id)}`, { token });
        return fromBase64(r.secret);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  };
}

/**
 * Unlock (or set up) this browser's storage after a QR login, with no
 * password, and keep the session copy as a password sign-in does.
 */
export async function unlockForLink(session: Session): Promise<LinkUnlockResult> {
  await storage.useAccount(session.user_id);
  const result = await storage.unlockForLink(deviceSecrets(session.token));
  saveUnlockCopy(session.user_id, await storage.sessionCopy(await sessionSecret(session.token)));
  return result;
}

/** What happened at sign-in, for a message on the next screen. */
export type PasswordUnlock = UnlockResult | "replaced";

/**
 * Unlock with the password just used to sign in, and keep the session
 * copy. A "mismatch" (the password was changed from another browser, so
 * this browser's keyring no longer opens) discards the unreadable data
 * and starts this browser over as a new device; that returns "replaced".
 */
export async function unlockWithPassword(session: Session, password: string): Promise<PasswordUnlock> {
  await storage.useAccount(session.user_id);
  let result: PasswordUnlock = await storage.unlock(password, deviceSecrets(session.token));
  if (result === "mismatch") {
    await storage.discardAndUnlock(password);
    result = "replaced";
  }
  saveUnlockCopy(session.user_id, await storage.sessionCopy(await sessionSecret(session.token)));
  return result;
}

/**
 * Unlock after a page refresh from the session copy. False means the
 * user has to sign in again: no copy in this tab, the session has ended,
 * or the copy belongs to a keyring that has since been replaced. Throws
 * when the server can't be reached (isUnreachable): offline, or opened
 * during a server restart, the caller waits and tries again rather than
 * signing anyone out.
 */
export async function unlockOnRefresh(session: Session): Promise<boolean> {
  await storage.useAccount(session.user_id);
  if (storage.isUnlocked()) return true;
  const copy = loadUnlockCopy(session.user_id);
  if (!copy) return false;
  let secret: Uint8Array;
  try {
    secret = await sessionSecret(session.token);
  } catch (err) {
    if (isUnreachable(err)) throw err;
    return false;
  }
  const ok = await storage.unlockFromSession(copy, secret);
  if (!ok) clearUnlockCopy();
  return ok;
}

/** Forget the unlocked key in this page and the tab's session copy. */
export function lockStorage(): void {
  storage.lock();
  clearUnlockCopy();
}
