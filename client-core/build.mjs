// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as esbuild from "esbuild";
import { copyFile } from "node:fs/promises";

// Bundled as an IIFE exposing one global rather than as an ES module.
//
// The debug client is a plain HTML page with no module loader, and this
// keeps it that way: one script tag, one global, no import maps. When
// client-web exists it will consume the source directly through its own
// bundler and this output becomes a convenience rather than the only
// delivery mechanism.
await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "iife",
  globalName: "OpenVoxaCore",
  target: ["es2022"],
  platform: "browser",
  outfile: "dist/core.js",
  sourcemap: false,
  minify: true,
  legalComments: "none",
  logLevel: "info",
});

// LiveKit is served from our own origin rather than a CDN, for two
// reasons. The E2EE worker must be same-origin (browsers refuse a Worker
// script from another site), and it must be the exact build the main
// library expects, because the two talk over a message protocol that
// changes between releases. A floating CDN tag would break that silently.
// It also means no third party can serve the code that holds media keys.
//
// The version is pinned exactly in package.json; the Dockerfile copies
// both files into the server's embedded debugui directory.
const livekit = "node_modules/livekit-client/dist";
for (const file of ["livekit-client.umd.js", "livekit-client.e2ee.worker.js"]) {
  await copyFile(`${livekit}/${file}`, `dist/${file}`);
}
console.log("copied livekit-client browser bundle and E2EE worker into dist/");
