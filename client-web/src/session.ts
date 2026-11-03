// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Session } from "./api";

/**
 * The session lives in sessionStorage: it survives a page refresh but not
 * closing the tab, and each tab has its own. That matches the debug page's
 * one-account-per-tab rule. "Remember me" can come later.
 */
const KEY = "openvoxa.session";

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (new Date(s.expires_at).getTime() <= Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else {
      sessionStorage.removeItem(KEY);
      sessionStorage.removeItem(UNLOCK_KEY);
    }
  } catch {
    /* storage unavailable (private mode quirks): stay logged in for this page only */
  }
}

/**
 * The session copy of the local data key (unlock.ts), beside the session
 * it belongs to and cleared with it. It is encrypted under a secret the
 * server holds for this session, so on its own it opens nothing.
 */
const UNLOCK_KEY = "openvoxa.unlock";

export function saveUnlockCopy(userId: string, copy: string): void {
  try {
    sessionStorage.setItem(UNLOCK_KEY, JSON.stringify({ userId, copy }));
  } catch {
    /* unavailable: a refresh will ask for the password instead */
  }
}

export function loadUnlockCopy(userId: string): string | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(UNLOCK_KEY) ?? "null") as
      { userId?: unknown; copy?: unknown } | null;
    return v && v.userId === userId && typeof v.copy === "string" ? v.copy : null;
  } catch {
    return null;
  }
}

export function clearUnlockCopy(): void {
  try {
    sessionStorage.removeItem(UNLOCK_KEY);
  } catch {
    /* nothing to clear */
  }
}
