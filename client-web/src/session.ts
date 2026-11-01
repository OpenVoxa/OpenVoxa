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
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable (private mode quirks): stay logged in for this page only */
  }
}
