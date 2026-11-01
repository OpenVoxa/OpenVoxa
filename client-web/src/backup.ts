// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The recovery backup as client-web uses it: one Backup per signed-in
 * account, plus the upload policy (decided with Ryan 2026-11-01):
 *
 * - before sign-out, always (signing out will wipe the local archive);
 * - about a minute after the latest new message, so a busy chat uploads
 *   once per quiet minute instead of once per message.
 *
 * client-web has no chat yet (M2), so nothing calls scheduleUpload()
 * today; the chat view will call it for every message it archives.
 */

import { Backup, BackupLocked, type BackupStatus } from "@core/recovery";
import { storage } from "@core/storage";

/** Wait this long after the latest new message before uploading. */
const QUIET_MS = 60_000;

/** fetch with the session token added, as client-core's Backup expects. */
function authedFetch(token: string) {
  return (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers });
  };
}

export class BackupManager {
  readonly backup: Backup;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<unknown> = Promise.resolve();
  /** Called when this device stops being able to upload (another device
   * started a new backup); the app then asks for the recovery key. */
  onLocked: () => void = () => {};

  private constructor(token: string) {
    this.backup = new Backup(authedFetch(token));
  }

  /** Point local storage at the account and build its manager. */
  static async open(userId: string, token: string): Promise<BackupManager> {
    await storage.useAccount(userId);
    return new BackupManager(token);
  }

  status(): Promise<BackupStatus | null> {
    return this.backup.status();
  }

  /** Upload about a minute from now, pushing back any pending upload. */
  scheduleUpload(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.uploadNow().catch((err) => console.warn("backup upload failed:", err));
    }, QUIET_MS);
  }

  /**
   * Upload now, after any upload already running (two at once would race
   * each other's generations). Does nothing when the account has no
   * backup or this device is locked out of it.
   */
  uploadNow(): Promise<void> {
    clearTimeout(this.#timer);
    const run = this.#running.catch(() => {}).then(async () => {
      const s = await this.backup.status();
      if (!s?.unlocked) return;
      try {
        await this.backup.upload();
      } catch (err) {
        if (err instanceof BackupLocked) this.onLocked();
        throw err;
      }
    });
    this.#running = run;
    return run;
  }

  /** Stop the timer; call when signing out after the final upload. */
  close(): void {
    clearTimeout(this.#timer);
  }
}

// "Asked once" for accounts that existed before recovery keys: remembered
// per account in this browser.
const ASKED = (userId: string) => `openvoxa.recoveryAsked.${userId}`;

export function wasAskedForKey(userId: string): boolean {
  try {
    return localStorage.getItem(ASKED(userId)) === "1";
  } catch {
    return false;
  }
}

export function markAskedForKey(userId: string): void {
  try {
    localStorage.setItem(ASKED(userId), "1");
  } catch {
    /* storage unavailable: they get asked again next time, which is fine */
  }
}
