// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Desktop app updates (decisions.md, Feature decisions, "Desktop updates").
//
// Only the shell needs updating: each server serves its own web client.
// The installed app (NSIS, per user) checks the update folder a few
// seconds after start and every four hours, downloads a new version in the
// background (only the changed blocks, thanks to the blockmap), and then
// waits for the user: the pane shows "Restart to Update", and closing the
// app installs it too. Nothing restarts by surprise.
//
// Unsigned for now, so the updater's only check is the SHA-512 in
// latest.yml, fetched over HTTPS from the same host as the installer.
// Whoever controls that folder can ship code to every installed app
// (decisions.md, Known tensions, "Whoever hosts desktop updates").

import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { appendFileSync, existsSync, statSync, renameSync } from "node:fs";
import path from "node:path";

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export type UpdateState = { current: string; ready: string | null };

let ready: string | null = null;
let notify: (s: UpdateState) => void = () => {};

// A short log in the app's data folder (%APPDATA%\OpenVoxa\updater.log),
// so a failed update can be diagnosed. Kept under about 200 KB.
function log(level: string, message: unknown) {
  try {
    const file = path.join(app.getPath("userData"), "updater.log");
    try {
      if (statSync(file).size > 200_000) renameSync(file, file + ".old");
    } catch {
      // No log yet.
    }
    appendFileSync(file, `${new Date().toISOString()} ${level} ${message instanceof Error ? message.message : String(message)}\n`);
  } catch {
    // Logging must never break the app.
  }
}

export function updateState(): UpdateState {
  return { current: app.getVersion(), ready };
}

// startUpdates does nothing in development, outside Windows, or in a
// build without update settings. The settings (the folder's address, from
// scripts/updateUrl.mjs, and the download cache's name) are
// resources/app-update.yml, written by scripts/package.mjs.
export function startUpdates(onChange: (s: UpdateState) => void) {
  notify = onChange;
  if (!app.isPackaged || process.platform !== "win32") return;
  if (!existsSync(path.join(process.resourcesPath, "app-update.yml"))) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log("info", m),
    warn: (m: unknown) => log("warn", m),
    error: (m: unknown) => log("error", m),
    debug: () => {},
  };
  autoUpdater.on("update-downloaded", (info) => {
    ready = info.version;
    notify(updateState());
  });
  // Errors (offline, server down) only go to the log: the next check
  // tries again, and nothing is shown to the user.
  autoUpdater.on("error", (err) => log("error", err));

  // Checks go on after a download, so a newer patch replaces one that
  // is still waiting for a restart.
  const check = () => {
    autoUpdater.checkForUpdates().catch((err: unknown) => log("error", err));
  };
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

// installNow quits, installs silently and starts the new version.
export function installNow() {
  if (!ready) return;
  log("info", `installing ${ready} now`);
  autoUpdater.quitAndInstall(true, true);
}
