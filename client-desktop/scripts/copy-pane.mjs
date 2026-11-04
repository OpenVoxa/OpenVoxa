// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Copies the pane page (plain HTML, CSS and JS) next to the compiled main
// process, where main.ts loads it from.
import { cpSync, rmSync } from "node:fs";

rmSync("out/pane", { recursive: true, force: true });
cpSync("pane", "out/pane", { recursive: true });
