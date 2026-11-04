// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// OpenVoxa desktop shell (decisions.md, Feature decisions, "Server browser
// and desktop shell").
//
// The window has two parts. On the left is the server pane, a small local
// page (pane/) that the shell draws itself. On the right is the web client
// of whichever server is selected, loaded from that server's own address.
// Every bookmarked server gets its own WebContentsView and its own storage
// partition, so sessions, device keys and archives never mix between
// servers, and each server serves the client version that matches it.
//
// Security: loading a server means running that server's code here. A
// server view is sandboxed, has contextIsolation on and nodeIntegration
// off, gets no preload, and is kept on its own origin. Only the pane (our
// own local page) talks to this process, and every message is checked to
// come from it.

import { app, BaseWindow, WebContentsView, ipcMain, Menu, dialog, shell, net, session } from "electron";
import type { IpcMainInvokeEvent, Session, WebContents } from "electron";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Width of the server pane, in CSS pixels. Must match --pane-width in
// pane/pane.css.
const PANE_WIDTH = 72;

// Permissions a server's web client may have, and only for its own
// origin. media = microphone and camera; speaker-selection = the Speaker
// picker; clipboard-sanitized-write = copy buttons; fullscreen = full
// screen for shared screens; notifications = the optional pop-ups.
// Everything else (location, USB, files ...) is refused.
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "speaker-selection",
  "clipboard-sanitized-write",
  "fullscreen",
  "notifications",
]);

type Server = { origin: string };
type State = {
  servers: Server[];
  selected: string | null;
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
};

// ---- Stored state: bookmarks live only on this device. ----

const statePath = () => path.join(app.getPath("userData"), "servers.json");

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8")) as State;
    const servers = Array.isArray(s.servers)
      ? s.servers.filter((x) => typeof x?.origin === "string" && normalizeOrigin(x.origin) === x.origin)
      : [];
    const selected = servers.some((x) => x.origin === s.selected) ? s.selected : (servers[0]?.origin ?? null);
    return { servers, selected, bounds: s.bounds, maximized: s.maximized };
  } catch {
    return { servers: [], selected: null };
  }
}

function saveState() {
  mkdirSync(path.dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

// ---- Addresses ----

// normalizeOrigin turns whatever the user pasted ("openvoxa.example.com",
// "https://openvoxa.example.com/channels/3") into an origin
// ("https://openvoxa.example.com"), or null. HTTPS only: voice, keys and
// sessions all need a secure context. Plain http is allowed for localhost
// only, for development.
function normalizeOrigin(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = "https://" + text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  return url.origin;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// partitionFor names a server's storage partition. A hash keeps the name a
// safe directory name; "persist:" keeps it on disk across restarts.
function partitionFor(origin: string): string {
  return "persist:server-" + createHash("sha256").update(origin).digest("hex").slice(0, 32);
}

// openExternally hands a link to the user's normal browser. Only web
// links: never file:, or app protocols a page could abuse.
function openExternally(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:") {
      void shell.openExternal(u.toString());
    }
  } catch {
    // Not a URL: ignore.
  }
}

// ---- Window and views ----

let state: State;
let win: BaseWindow | null = null;
let pane: WebContentsView | null = null;
const views = new Map<string, WebContentsView>();
// While the pane shows a form (Add a Server) it covers the whole window
// and the server view is hidden.
let overlay = false;
const securedSessions = new WeakSet<Session>();

function secureSession(ses: Session, origin: string) {
  if (securedSessions.has(ses)) return;
  securedSessions.add(ses);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && originOf(details.requestingUrl) === origin);
  });
  // requestingOrigin arrives with a trailing slash
  // ("https://host/"), so it is normalised before comparing (found by
  // experiment, ED7: device names stayed hidden).
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && originOf(requestingOrigin) === origin;
  });
  // Screen share needs our own picker (Electron shows none); that is the
  // next step. Until then the request is refused and the web client
  // reports that sharing failed.
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(null));
}

// lockToOrigin keeps a server's page (or a window it opened) on that
// server. Links elsewhere open in the user's browser instead.
function lockToOrigin(wc: WebContents, origin: string) {
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (originOf(url) !== origin) {
      event.preventDefault();
      openExternally(url);
    }
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.setWindowOpenHandler(({ url }) => {
    // Attachments in encrypted channels are blob: URLs that only exist
    // inside this page, and plain attachments are on the server itself:
    // those open in a small app window with the same locks. Anything else
    // goes to the browser.
    if (url.startsWith("blob:" + origin + "/") || originOf(url) === origin) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: "#333333",
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    openExternally(url);
    return { action: "deny" };
  });
  wc.on("did-create-window", (child) => lockToOrigin(child.webContents, origin));
}

function viewFor(origin: string): WebContentsView {
  let view = views.get(origin);
  if (view) return view;
  const partition = partitionFor(origin);
  secureSession(session.fromPartition(partition), origin);
  view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Background servers stay connected and keep their timers running
      // (decided 2026-11-04), so sounds and live messages keep working.
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor("#333333");
  lockToOrigin(view.webContents, origin);
  // There is no menu bar, so the usual browser keys are wired by hand:
  // Ctrl+R / F5 reload this server, Ctrl+Shift+I / F12 open its developer
  // tools (handy for testing; they only ever see this one server).
  view.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    if (key === "f5" || (ctrl && !input.shift && key === "r")) {
      event.preventDefault();
      view!.webContents.reload();
    } else if (key === "f12" || (ctrl && input.shift && key === "i")) {
      event.preventDefault();
      view!.webContents.toggleDevTools();
    }
  });
  view.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */) return;
    pane?.webContents.send("server-error", { origin, message: `${description} (${url})` });
  });
  view.webContents.on("did-finish-load", () => pane?.webContents.send("server-error", { origin, message: null }));
  view.setVisible(false);
  win!.contentView.addChildView(view);
  void view.webContents.loadURL(origin + "/");
  views.set(origin, view);
  return view;
}

function layout() {
  if (!win || !pane) return;
  const { width, height } = win.getContentBounds();
  pane.setBounds({ x: 0, y: 0, width: overlay || !state.selected ? width : PANE_WIDTH, height });
  for (const [origin, view] of views) {
    const shown = !overlay && origin === state.selected;
    view.setVisible(shown);
    if (shown) view.setBounds({ x: PANE_WIDTH, y: 0, width: Math.max(0, width - PANE_WIDTH), height });
  }
}

function select(origin: string | null) {
  state.selected = origin;
  if (origin) {
    viewFor(origin);
    views.get(origin)!.webContents.focus();
  }
  saveState();
  layout();
  sendServers();
}

function sendServers() {
  pane?.webContents.send("servers", { servers: state.servers, selected: state.selected });
}

function removeServer(origin: string) {
  state.servers = state.servers.filter((s) => s.origin !== origin);
  const view = views.get(origin);
  if (view) {
    win?.contentView.removeChildView(view);
    view.webContents.close();
    views.delete(origin);
  }
  // The server's storage (session, device keys, archive) is kept, so
  // adding it back later finds this device again.
  select(state.selected === origin ? (state.servers[0]?.origin ?? null) : state.selected);
}

function createWindow() {
  win = new BaseWindow({
    width: state.bounds?.width ?? 1280,
    height: state.bounds?.height ?? 800,
    x: state.bounds?.x,
    y: state.bounds?.y,
    minWidth: 640,
    minHeight: 480,
    title: "OpenVoxa",
    backgroundColor: "#333333",
    autoHideMenuBar: true,
  });
  if (state.maximized) win.maximize();

  pane = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "panePreload.js"),
    },
  });
  pane.setBackgroundColor("#333333");
  // The pane never navigates or opens windows.
  pane.webContents.on("will-navigate", (e) => e.preventDefault());
  pane.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.contentView.addChildView(pane);
  void pane.webContents.loadFile(path.join(__dirname, "pane", "pane.html"));

  // Every server stays connected in the background, so load them all now.
  for (const s of state.servers) viewFor(s.origin);
  if (state.selected) views.get(state.selected)!.webContents.focus();
  layout();

  win.on("resize", layout);
  const remember = () => {
    if (!win) return;
    state.maximized = win.isMaximized();
    if (!state.maximized && !win.isMinimized()) state.bounds = win.getBounds();
    saveState();
  };
  win.on("resized", remember);
  win.on("moved", remember);
  win.on("maximize", remember);
  win.on("unmaximize", remember);
  win.on("close", remember);
  win.on("closed", () => {
    win = null;
    pane = null;
    views.clear();
  });
}

// ---- Messages from the pane ----

// fromPane rejects any message that doesn't come from our own pane page.
function fromPane(e: IpcMainInvokeEvent): boolean {
  return !!pane && e.sender === pane.webContents && !!e.senderFrame && e.senderFrame.url.startsWith("file:");
}

// checkServer confirms an address is an OpenVoxa server before
// bookmarking it: GET /api/v1/setup answers {"needs_setup_code": bool}.
async function checkServer(origin: string): Promise<string | null> {
  try {
    const res = await net.fetch(origin + "/api/v1/setup", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return "That address answered, but it doesn't look like an OpenVoxa server.";
    const body = (await res.json()) as unknown;
    if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).needs_setup_code !== "boolean") {
      return "That address answered, but it doesn't look like an OpenVoxa server.";
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Couldn't reach that server (${msg}).`;
  }
}

function registerIpc() {
  ipcMain.handle("pane:ready", (e) => {
    if (!fromPane(e)) return;
    sendServers();
  });
  ipcMain.handle("pane:select", (e, origin: unknown) => {
    if (!fromPane(e) || typeof origin !== "string") return;
    if (state.servers.some((s) => s.origin === origin)) select(origin);
  });
  ipcMain.handle("pane:reload", (e, origin: unknown) => {
    if (!fromPane(e) || typeof origin !== "string") return;
    views.get(origin)?.webContents.reload();
  });
  ipcMain.handle("pane:overlay", (e, on: unknown) => {
    if (!fromPane(e)) return;
    overlay = on === true;
    layout();
    if (!overlay && state.selected) views.get(state.selected)?.webContents.focus();
  });
  ipcMain.handle("pane:add", async (e, address: unknown): Promise<{ error: string | null }> => {
    if (!fromPane(e) || typeof address !== "string") return { error: "Invalid request." };
    const origin = normalizeOrigin(address);
    if (!origin) return { error: "Enter an HTTPS address, like openvoxa.example.com." };
    if (state.servers.some((s) => s.origin === origin)) {
      overlay = false;
      select(origin);
      return { error: null };
    }
    const problem = await checkServer(origin);
    if (problem) return { error: problem };
    state.servers.push({ origin });
    overlay = false;
    select(origin);
    return { error: null };
  });
  ipcMain.handle("pane:menu", (e, origin: unknown) => {
    if (!fromPane(e) || typeof origin !== "string" || !win) return;
    if (!state.servers.some((s) => s.origin === origin)) return;
    const host = new URL(origin).host;
    Menu.buildFromTemplate([
      { label: "Reload", click: () => views.get(origin)?.webContents.reload() },
      { type: "separator" },
      {
        label: "Remove Server",
        click: async () => {
          const { response } = await dialog.showMessageBox(win!, {
            type: "question",
            buttons: ["Remove", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            title: "Remove Server",
            message: `Remove ${host} from the list?`,
            detail: "Your account on that server is not affected. Adding it back later signs this device straight back in.",
          });
          if (response === 0) removeServer(origin);
        },
      },
    ]).popup({ window: win });
  });
}

// ---- App lifecycle ----

// Last line of defence: no page in this app, whatever created it, may
// embed <webview> or open a window without going through the handlers
// above.
app.on("web-contents-created", (_e, wc) => {
  wc.on("will-attach-webview", (event) => event.preventDefault());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  Menu.setApplicationMenu(null);
  // Windows shows notifications only for an app with an id.
  app.setAppUserModelId("net.openvoxa.desktop");
  app.whenReady().then(() => {
    state = loadState();
    registerIpc();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
