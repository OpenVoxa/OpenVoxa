// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The build lands in dist/, which the Dockerfile copies into the Go
// server's embedded webui/ directory. Hashed files go under assets/ so the
// server can cache them forever and never cache index.html.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", assetsDir: "assets", sourcemap: true },
});
