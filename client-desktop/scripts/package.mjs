// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Packages the app for one platform ("win32" for now) into release/, then
// zips it. Unsigned. The installer and update files are made from this
// folder by scripts/release.mjs (decisions.md, "Desktop updates").
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const platform = process.argv[2] ?? "win32";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

// Windows builds carry the window share sound helper next to the app
// (resources/openvoxa-audio.exe), built by audio-helper/build-windows.sh.
const helper = "audio-helper/target/x86_64-pc-windows-gnu/release/openvoxa-audio.exe";
if (platform === "win32" && !existsSync(helper)) {
  console.error(`${helper} is missing: run audio-helper/build-windows.sh first.`);
  process.exit(1);
}

// The updater's settings (src/updater.ts): where to look, and the name of
// its download cache folder. electron-updater reads them from
// resources/app-update.yml, which electron-builder writes only when it
// packages the app itself; we package with @electron/packager, so it is
// written here. Without it the update check works but the download never
// starts (found by experiment, DU3).
const updateConfig = "release/app-update.yml";
if (platform === "win32" && pkg.openvoxaUpdateUrl) {
  mkdirSync("release", { recursive: true });
  writeFileSync(updateConfig, [
    "provider: generic",
    `url: ${pkg.openvoxaUpdateUrl}`,
    "updaterCacheDirName: openvoxa-updater",
    "",
  ].join("\n"));
}

const [dir] = await packager({
  dir: ".",
  out: "release",
  platform,
  arch: "x64",
  overwrite: true,
  prune: true,
  asar: true,
  executableName: "OpenVoxa",
  appCopyright: "The OpenVoxa Authors, AGPL-3.0-or-later",
  // Only the compiled app, package.json and the runtime dependencies
  // (electron-updater; prune drops the dev ones) go in.
  ignore: (p) => p !== "" && !/^\/(out|node_modules|package\.json)(\/|$)/.test(p),
  extraResource: platform === "win32" ? [helper, ...(pkg.openvoxaUpdateUrl ? [updateConfig] : [])] : [],
  win32metadata: { CompanyName: "The OpenVoxa Authors", ProductName: "OpenVoxa", FileDescription: "OpenVoxa" },
});

const zip = path.join("release", `OpenVoxa-${pkg.version}-${platform}-x64.zip`);
// Python's zipfile is on every Docker host we use; no zip binary needed.
execFileSync("python3", ["-c",
  "import shutil,sys; shutil.make_archive(sys.argv[1][:-4], 'zip', sys.argv[2], sys.argv[3])",
  zip, path.dirname(dir), path.basename(dir)], { stdio: "inherit" });
console.log(zip);
