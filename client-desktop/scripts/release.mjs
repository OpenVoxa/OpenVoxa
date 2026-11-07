// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Makes a new desktop release and publishes it to the update folder
// (decisions.md, Feature decisions, "Desktop updates").
//
//   npm run release:win                 bump the patch version, build, publish
//   npm run release:win -- --no-bump    rebuild the current version
//   npm run release:win -- --no-publish build only (release/installer/)
//
// Steps: bump package.json; package the app (scripts/package.mjs); turn
// that folder into an NSIS installer plus latest.yml and a blockmap, with
// electron-builder in a Docker container that has Wine; copy them into the
// update folder, latest.yml last, so an app never sees a version whose
// installer isn't there yet. The folder defaults to deploy/desktop-updates
// (served by Caddy at /desktop-updates/); OPENVOXA_DESKTOP_UPDATES_DIR
// overrides it. The newest KEEP versions stay: an updating app fetches its
// own version's blockmap to download only what changed.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateUrl } from "./updateUrl.mjs";

const KEEP = 5;
const IMAGE = "openvoxa-desktop-builder";
const args = new Set(process.argv.slice(2));
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", ...opts });

const url = updateUrl();
if (!url) {
  console.error("No update address: put it in client-desktop/update-url.local (e.g. https://openvoxa.example.com/desktop-updates/) or set OPENVOXA_UPDATE_URL.");
  process.exit(1);
}

if (!args.has("--no-bump")) run("npm", ["version", "patch", "--no-git-tag-version"]);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
console.log(`\nOpenVoxa desktop ${version}\n`);

run("npm", ["run", "package:win"]);

// The address the installed app checks (scripts/updateUrl.mjs);
// latest.yml is written for the same place.
const config = {
  appId: "net.openvoxa.desktop",
  productName: "OpenVoxa",
  copyright: "The OpenVoxa Authors, AGPL-3.0-or-later",
  electronVersion: pkg.devDependencies.electron,
  directories: { output: "/w/release/installer" },
  // The packager already set the exe's details; editing it again needs Wine for rcedit.
  win: { target: "nsis", signAndEditExecutable: false },
  // Per user, one click, like Discord: no administrator prompt, installed
  // in %LOCALAPPDATA%\Programs\OpenVoxa. App data (bookmarks, server
  // sessions) stays in %APPDATA%\OpenVoxa, as with the zip.
  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    artifactName: "OpenVoxa-Setup-${version}.${ext}",
  },
  publish: { provider: "generic", url },
};
rmSync("release/installer", { recursive: true, force: true });
// electron-builder names things after the package name: the install folder
// (%LOCALAPPDATA%\Programs\<name>) and the folder where the installer
// keeps a copy of itself for the next differential update
// (%LOCALAPPDATA%\<name>-updater\installer.exe). Ours is
// "@openvoxa/client-desktop", which gave "@openvoxaclient-desktop" for both,
// while the app looks in "openvoxa-updater" (app-update.yml,
// scripts/package.mjs), so every update downloaded the whole installer
// (DU7). So electron-builder gets a small project folder of its own whose
// package.json says "openvoxa".
rmSync("release/eb", { recursive: true, force: true });
mkdirSync("release/eb", { recursive: true });
writeFileSync("release/eb/package.json", JSON.stringify({
  name: "openvoxa",
  productName: "OpenVoxa",
  version,
  description: pkg.description,
  author: "The OpenVoxa Authors",
  license: pkg.license,
}, null, 2));
writeFileSync("release/eb/electron-builder.json", JSON.stringify(config, null, 2));

run("docker", ["build", "-q", "-t", IMAGE, "-f", "scripts/builder.Dockerfile", "scripts"]);
const { uid, gid } = os.userInfo();
run("docker", [
  "run", "--rm", "-v", `${process.cwd()}:/w`, "-w", "/w",
  "-v", "ovx-ebcache:/cache", "-e", "ELECTRON_BUILDER_CACHE=/cache", "-e", "HOME=/tmp",
  IMAGE, "sh", "-c",
  "npx electron-builder --projectDir /w/release/eb --win nsis --x64 --prepackaged /w/release/OpenVoxa-win32-x64 " +
    `--config /w/release/eb/electron-builder.json --publish never && chown -R ${uid}:${gid} release/installer`,
]);

const setup = `OpenVoxa-Setup-${version}.exe`;
const built = path.join("release", "installer");
console.log(`\nInstaller: ${path.join(built, setup)}`);
if (args.has("--no-publish")) process.exit(0);

const dest = path.resolve(process.env.OPENVOXA_DESKTOP_UPDATES_DIR ?? "../deploy/desktop-updates");
mkdirSync(dest, { recursive: true });
copyFileSync(path.join(built, setup), path.join(dest, setup));
copyFileSync(path.join(built, setup + ".blockmap"), path.join(dest, setup + ".blockmap"));
copyFileSync(path.join(built, "latest.yml"), path.join(dest, "latest.yml.tmp"));
renameSync(path.join(dest, "latest.yml.tmp"), path.join(dest, "latest.yml"));

// Keep the newest KEEP versions (installer and blockmap).
const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
};
const versions = [...new Set(readdirSync(dest)
  .map((f) => /^OpenVoxa-Setup-(\d+\.\d+\.\d+)\.exe(\.blockmap)?$/.exec(f)?.[1])
  .filter(Boolean))].sort(cmp);
for (const old of versions.slice(KEEP)) {
  rmSync(path.join(dest, `OpenVoxa-Setup-${old}.exe`), { force: true });
  rmSync(path.join(dest, `OpenVoxa-Setup-${old}.exe.blockmap`), { force: true });
}
console.log(`Published ${version} to ${dest}`);
