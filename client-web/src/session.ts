// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Session } from "./api";

/**
 * Where the session lives depends on "Stay signed in" on the login page
 * (decisions.md, Feature decisions, "Stay signed in"):
 *
 * - ticked (the default): localStorage. It survives closing the tab, the
 *   browser or the desktop app, until the session expires (30 days) or
 *   the user signs out.
 * - unticked: sessionStorage. It survives a page refresh but not closing
 *   the tab.
 *
 * The unlock copy (below) always sits in the same place as its session.
 * One tab per account still holds (the Web Lock in client-core), so a
 * second tab that picks up a stored session is refused, not signed in
 * twice.
 */
const KEY = "openvoxa.session";
const STAY_KEY = "openvoxa.staySignedIn";

function local(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function tab(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

// Set by the login page before it signs in, and by loadSession from where
// it found a stored session.
let staying = true;

/** The login page's last choice, so the box comes back as it was left. */
export function staySignedInChoice(): boolean {
  return local()?.getItem(STAY_KEY) !== "0";
}

export function setStaySignedIn(on: boolean): void {
  staying = on;
  try {
    local()?.setItem(STAY_KEY, on ? "1" : "0");
  } catch {
    /* unavailable: the box just starts ticked next time */
  }
}

function store(): Storage | null {
  return staying ? local() : tab();
}

export function loadSession(): Session | null {
  for (const [where, stay] of [[tab(), false], [local(), true]] as const) {
    try {
      const raw = where?.getItem(KEY);
      if (!raw) continue;
      const s = JSON.parse(raw) as Session;
      if (new Date(s.expires_at).getTime() <= Date.now()) continue;
      staying = stay;
      return s;
    } catch {
      /* unreadable: try the other one */
    }
  }
  return null;
}

export function saveSession(s: Session | null): void {
  try {
    if (s) store()?.setItem(KEY, JSON.stringify(s));
    else {
      for (const where of [tab(), local()]) {
        where?.removeItem(KEY);
        where?.removeItem(UNLOCK_KEY);
      }
    }
  } catch {
    /* storage unavailable (private mode quirks): stay logged in for this page only */
  }
}

/**
 * The session copy of the local data key (unlock.ts), beside the session
 * it belongs to and cleared with it. It is encrypted under a secret the
 * server holds for this session, so on its own it opens nothing: signing
 * the session out (here or from another device) makes it useless.
 */
const UNLOCK_KEY = "openvoxa.unlock";

export function saveUnlockCopy(userId: string, copy: string): void {
  try {
    store()?.setItem(UNLOCK_KEY, JSON.stringify({ userId, copy }));
  } catch {
    /* unavailable: a refresh will ask for the password instead */
  }
}

export function loadUnlockCopy(userId: string): string | null {
  try {
    const v = JSON.parse(store()?.getItem(UNLOCK_KEY) ?? "null") as
      { userId?: unknown; copy?: unknown } | null;
    return v && v.userId === userId && typeof v.copy === "string" ? v.copy : null;
  } catch {
    return null;
  }
}

export function clearUnlockCopy(): void {
  for (const where of [tab(), local()]) {
    try {
      where?.removeItem(UNLOCK_KEY);
    } catch {
      /* nothing to clear */
    }
  }
}
