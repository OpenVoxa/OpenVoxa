// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// client-core is imported as source ("@core/recovery"), not as the global
// bundle the debug page uses: Vite bundles only what client-web needs. The
// "@core/*" alias lives in tsconfig.json; tsconfigPaths makes Vite read it,
// so there is one definition for both tsc and the bundler.
//
// The build lands in dist/, which the Dockerfile copies into the Go
// server's embedded webui/ directory. Hashed files go under assets/ so the
// server can cache them forever and never cache index.html.
export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  base: "/",
  build: { outDir: "dist", assetsDir: "assets", sourcemap: true },
});
