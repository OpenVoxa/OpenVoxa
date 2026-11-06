// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs before the RNNoise glue in rnnoiseWorklet.ts (imports run in
 * order). The glue reads `import.meta.url` at load, which Vite's worker
 * build turns into `self.location.href`; the audio thread has neither
 * `self` nor `location`, so loading would throw. The address is only used
 * to find a separate .wasm file, which the sync build doesn't have.
 */
const g = globalThis as { self?: unknown; location?: unknown };
if (g.self === undefined) g.self = globalThis;
if (g.location === undefined) g.location = { href: "" };

export {};
