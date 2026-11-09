// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "New features are available" (decisions.md Feature decisions, "New
 * version notice"). The web client is embedded in the server, so a
 * server update brings a new one, but an open page keeps running the old
 * one until it reloads. The server's restart drops the event socket;
 * after it reconnects, ChatApp calls checkForNewVersion, which fetches
 * the front page and compares the app script it names (Vite gives it a
 * content hash, e.g. /assets/index-oy7t_le9.js) with the one this page
 * runs. Nothing new is exposed: the front page is public anyway.
 *
 * A development server (no hashed script) never reports one.
 */

const SCRIPT = /\/assets\/index-[\w-]+\.js/;

/** This page's own app script, or null (development server). */
function runningScript(): string | null {
  for (const s of document.querySelectorAll<HTMLScriptElement>("script[type=module][src]")) {
    const m = SCRIPT.exec(s.getAttribute("src") ?? "");
    if (m) return m[0];
  }
  return null;
}

/** The server's newer app script, or null when this page is current
 * (or the check failed: an update notice is never worth an error). */
export async function checkForNewVersion(): Promise<string | null> {
  const mine = runningScript();
  if (!mine) return null;
  try {
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return null;
    const m = SCRIPT.exec(await res.text());
    return m && m[0] !== mine ? m[0] : null;
  } catch {
    return null;
  }
}
