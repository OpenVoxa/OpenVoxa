// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Preload for server views: the only thing a server's page gets from the
// desktop app. It offers: the app's versions, for the About tab; a nudge
// that the server's name or icon changed (the app fetches them itself);
// the sound for the window share the user just picked (decisions.md,
// "Per-app share sound"); and Smart Switch's signals (decisions.md, "Smart
// Switch"). The page can't choose what is recorded or shared, nor start a
// recording without the user's pick: the main process only answers
// within a few seconds of a pick in our own picker, once, and only to
// that server's own page. No raw ipcRenderer.

import { contextBridge, ipcRenderer } from "electron";

type OnData = (pcm: Uint8Array) => void;
type OnEnd = (reason: string) => void;

let onData: OnData | null = null;
let onEnd: OnEnd | null = null;

ipcRenderer.on("share-sound:data", (_e, pcm: Uint8Array) => onData?.(pcm));
let onSwitch: (() => void) | null = null;
ipcRenderer.on("share-follow:switch", () => onSwitch?.());

ipcRenderer.on("share-sound:end", (_e, reason: string) => {
  const cb = onEnd;
  onData = onEnd = null;
  cb?.(String(reason));
});

contextBridge.exposeInMainWorld("openvoxaDesktop", {
  /** App, Electron and Chromium versions and the OS, for the About tab. */
  appInfo: (): Promise<{ app: string; electron: string; chromium: string; os: string } | null> =>
    ipcRenderer.invoke("view:app-info"),
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
  /** The server said its name or icon changed: the app fetches them itself. */
  serverInfoChanged: (): Promise<void> => ipcRenderer.invoke("view:server-info-changed"),
  /**
   * Smart Switch: cb runs when the app wants the share switched (the
   * page then calls getDisplayMedia again, which the app answers itself).
   * Registering also tells the app this page can follow a switch.
   */
  onShareSwitch: (cb: () => void): Promise<void> => {
    onSwitch = cb;
    return ipcRenderer.invoke("view:share-follow-ready");
  },
  /** The shared window closed: the next getDisplayMedia is answered by the app, not a click. */
  shareGone: (): Promise<void> => ipcRenderer.invoke("view:share-gone"),
  /** The share ended: Smart Switch stops following. */
  shareStopped: (): Promise<void> => ipcRenderer.invoke("view:share-stopped"),
  stopShareSound: (): Promise<void> => {
    onData = onEnd = null;
    return ipcRenderer.invoke("view:share-sound-stop");
  },
});
