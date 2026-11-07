// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// The address installed apps check for updates: a folder on the
// publisher's own server (decisions.md, "Desktop updates"). It is a
// per-publisher setting, so it is never committed: it comes from
// OPENVOXA_UPDATE_URL or the first line of update-url.local (gitignored).
// Empty means a build without updates.
import { existsSync, readFileSync } from "node:fs";

export function updateUrl() {
  const fromEnv = process.env.OPENVOXA_UPDATE_URL?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync("update-url.local")) return "";
  return readFileSync("update-url.local", "utf8").split("\n")[0].trim();
}
