// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * LiveKit's E2EE worker, built by Vite from the same livekit-client copy
 * client-core uses (its node_modules, by relative path: client-web has no
 * livekit-client of its own, so there is only ever one copy). It must be same-origin and the exact build of the main
 * library: the two talk over a message protocol that changes between
 * releases. Imported only by the voice code, which loads on first join.
 */
import E2EEWorker from "../../client-core/node_modules/livekit-client/dist/livekit-client.e2ee.worker.mjs?worker";

export function createE2EEWorker(): Worker {
  return new E2EEWorker();
}
