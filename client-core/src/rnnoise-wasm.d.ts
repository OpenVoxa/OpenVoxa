// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// @jitsi/rnnoise-wasm ships no types. The sync build returns the
// Emscripten module object at once (rnnoiseWorklet.ts types what it uses).
declare module "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js" {
  const createRNNWasmModuleSync: () => unknown;
  export default createRNNWasmModuleSync;
}
