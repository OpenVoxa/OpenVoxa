// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Preload for server views: the only thing a server's page gets from the
// desktop app. It offers one call, the sound for the window share the user
// just picked (decisions.md, "Per-app share sound"). The page can't choose
// what is recorded, nor start a recording without the user's pick: the
// main process only answers within a few seconds of a pick in our own
// picker, once, and only to that server's own page. No raw ipcRenderer.

import { contextBridge, ipcRenderer } from "electron";

type OnData = (pcm: Uint8Array) => void;
type OnEnd = (reason: string) => void;

let onData: OnData | null = null;
let onEnd: OnEnd | null = null;

ipcRenderer.on("share-sound:data", (_e, pcm: Uint8Array) => onData?.(pcm));
ipcRenderer.on("share-sound:end", (_e, reason: string) => {
  const cb = onEnd;
  onData = onEnd = null;
  cb?.(String(reason));
});

contextBridge.exposeInMainWorld("openvoxaDesktop", {
  /**
   * Starts the sound for the window share just picked. Resolves false when
   * there is none (a screen share, Share Sound unticked, or too late).
   * PCM: 48 kHz, stereo, 16-bit signed little endian, interleaved.
   */
  startShareSound: async (data: OnData, end: OnEnd): Promise<boolean> => {
    onData = data;
    onEnd = end;
    const ok = (await ipcRenderer.invoke("view:share-sound-start")) === true;
    if (!ok) onData = onEnd = null;
    return ok;
  },
  stopShareSound: (): Promise<void> => {
    onData = onEnd = null;
    return ipcRenderer.invoke("view:share-sound-stop");
  },
});
