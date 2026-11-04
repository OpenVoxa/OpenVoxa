// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Preload for the server pane only (our own local page). Server views get
// no preload at all. This is the whole bridge: a handful of named calls,
// no raw ipcRenderer, and the main process checks every one came from the
// pane.

import { contextBridge, ipcRenderer } from "electron";

type ServerList = { servers: { origin: string }[]; selected: string | null };
type ServerError = { origin: string; message: string | null };

contextBridge.exposeInMainWorld("shell", {
  ready: () => ipcRenderer.invoke("pane:ready"),
  select: (origin: string) => ipcRenderer.invoke("pane:select", origin),
  add: (address: string) => ipcRenderer.invoke("pane:add", address) as Promise<{ error: string | null }>,
  setOverlay: (on: boolean) => ipcRenderer.invoke("pane:overlay", on),
  menu: (origin: string) => ipcRenderer.invoke("pane:menu", origin),
  reload: (origin: string) => ipcRenderer.invoke("pane:reload", origin),
  onServers: (cb: (list: ServerList) => void) => {
    ipcRenderer.on("servers", (_e, list: ServerList) => cb(list));
  },
  onServerError: (cb: (err: ServerError) => void) => {
    ipcRenderer.on("server-error", (_e, err: ServerError) => cb(err));
  },
});
