// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Preload for the server pane only (our own local page). Server views have
// their own, narrower one (viewPreload.ts). This is the whole bridge: a handful of named calls,
// no raw ipcRenderer, and the main process checks every one came from the
// pane.

import { contextBridge, ipcRenderer } from "electron";

type ServerList = { servers: { origin: string; name?: string; icon?: string }[]; selected: string | null };
type ServerError = { origin: string; message: string | null };
type ShareOpen = { host: string; audio: boolean; screenSound: boolean; windowSound: boolean; gone: boolean };
type UpdateState = { current: string; ready: string | null };
type ShareSource = { id: string; name: string; screen: boolean; thumbnail: string | null; icon: string | null; smart: string | null };

contextBridge.exposeInMainWorld("shell", {
  ready: () => ipcRenderer.invoke("pane:ready"),
  select: (origin: string) => ipcRenderer.invoke("pane:select", origin),
  add: (address: string) => ipcRenderer.invoke("pane:add", address) as Promise<{ error: string | null }>,
  setOverlay: (on: boolean) => ipcRenderer.invoke("pane:overlay", on),
  menu: (origin: string) => ipcRenderer.invoke("pane:menu", origin),
  reload: (origin: string) => ipcRenderer.invoke("pane:reload", origin),
  share: (id: string | null, sound: boolean, smart: boolean) => ipcRenderer.invoke("pane:share", id, sound, smart),
  onShareOpen: (cb: (req: ShareOpen) => void) => {
    ipcRenderer.on("share-open", (_e, req: ShareOpen) => cb(req));
  },
  onShareSources: (cb: (sources: ShareSource[]) => void) => {
    ipcRenderer.on("share-sources", (_e, sources: ShareSource[]) => cb(sources));
  },
  onShareError: (cb: (message: string) => void) => {
    ipcRenderer.on("share-error", (_e, message: string) => cb(message));
  },
  onShareClose: (cb: () => void) => {
    ipcRenderer.on("share-close", () => cb());
  },
  onServers: (cb: (list: ServerList) => void) => {
    ipcRenderer.on("servers", (_e, list: ServerList) => cb(list));
  },
  installUpdate: () => ipcRenderer.invoke("pane:install-update"),
  onUpdate: (cb: (s: UpdateState) => void) => {
    ipcRenderer.on("update", (_e, s: UpdateState) => cb(s));
  },
  onServerError: (cb: (err: ServerError) => void) => {
    ipcRenderer.on("server-error", (_e, err: ServerError) => cb(err));
  },
});
