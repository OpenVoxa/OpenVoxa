// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// client-web imports client-core as source and bundles it itself (with
// LiveKit's E2EE worker, from this package's exact livekit-client copy:
// client-web/src/voiceWorker.ts). All that is left to do here is the
// ts-mls tree validation fix; see the script. It patches node_modules,
// so it runs after every install.
await import("./scripts/patch-ts-mls.mjs");
