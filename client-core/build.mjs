// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as esbuild from "esbuild";

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
