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
// off, and is kept on its own origin. Its only preload (viewPreload.ts)
// offers one thing: the sound for a window share the user just picked.
// The pane (our own local page) talks to this process, and every message
// is checked to come from the pane or, for share sound, from the view of
// the server that asked.

import { app, BaseWindow, WebContentsView, ipcMain, Menu, dialog, shell, net, session, desktopCapturer } from "electron";
import type { DesktopCapturerSource, IpcMainInvokeEvent, Session, Streams, WebContents } from "electron";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startUpdates, updateState, installNow } from "./updater";

// Width of the server pane, in CSS pixels. Must match --pane-width in
// pane/pane.css.
const PANE_WIDTH = 72;

// Permissions a server's web client may have, and only for its own
// origin. media = microphone and camera; speaker-selection = the Speaker
// picker; clipboard-sanitized-write = copy buttons; fullscreen = full
// screen for shared screens; notifications = the optional pop-ups;
// display-capture = screen share (what is shared is still chosen in our
// own picker, never by the page). Everything else (location, USB,
// files ...) is refused.
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "display-capture",
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
  // Electron shows no screen share picker of its own: the pane draws one
  // (see "Screen share picker" below). The server's page only asks; what
  // gets shared is chosen in our own UI, never by the page.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (originOf(request.securityOrigin) !== origin || !request.videoRequested) return callback(null);
    void openPicker(origin, request.audioRequested, callback);
  });
}

// ---- Screen share picker ----
//
// One picker at a time, for the server on screen. While it is open the
// pane covers the window (like the Add a Server form) and its thumbnails
// refresh every two seconds. Sound, Windows only: a whole screen gets
// Electron's "all system sound" (loopback; the web client asks for
// restrictOwnAudio, which leaves OpenVoxa itself out). A window gets
// only its program's sound, recorded by our helper (see "Window share
// sound" below), which needs Windows 10 2004 (build 19041) or later.

const SOUND_SUPPORTED = process.platform === "win32";
const WINDOW_SOUND_SUPPORTED =
  SOUND_SUPPORTED && Number(os.release().split(".")[2] ?? 0) >= 19041 && existsSync(helperPath());
const THUMB = { width: 320, height: 180 };

type Pick = {
  origin: string;
  audio: boolean;
  callback: (streams: Streams | null) => void;
  sources: Map<string, DesktopCapturerSource>;
  timer: NodeJS.Timeout | null;
};
let pick: Pick | null = null;

async function listSources(p: Pick) {
  let found: DesktopCapturerSource[];
  try {
    found = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: THUMB, fetchWindowIcons: true });
  } catch (err) {
    // Shown in the picker; the timer keeps trying.
    if (pick === p) pane?.webContents.send("share-error", `Couldn't list screens and windows (${err instanceof Error ? err.message : String(err)}).`);
    return;
  }
  if (pick !== p) return; // closed meanwhile
  p.sources = new Map(found.map((s) => [s.id, s]));
  pane?.webContents.send("share-sources", found.map((s) => ({
    id: s.id,
    name: s.name,
    screen: s.id.startsWith("screen:"),
    thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  })));
}

async function openPicker(origin: string, audio: boolean, callback: (streams: Streams | null) => void) {
  // Only the server on screen may open it (a background server asking
  // would pop a picker for a page the user can't see), and only one.
  if (pick || !pane || !win || state.selected !== origin) return callback(null);
  const p: Pick = { origin, audio, callback, sources: new Map(), timer: null };
  pick = p;
  pane.webContents.send("share-open", {
    host: new URL(origin).host, audio, screenSound: SOUND_SUPPORTED, windowSound: WINDOW_SOUND_SUPPORTED,
  });
  overlay = true;
  layout();
  win.focus();
  pane.webContents.focus();
  await listSources(p);
  if (pick === p) p.timer = setInterval(() => void listSources(p), 2000);
}

// finishPick answers the page and closes the picker. A null id cancels:
// the page's getDisplayMedia then fails with "AbortError: Invalid capture
// constraints" (Electron 45, found by experiment; null, {} and no
// argument all give the same), which the web client treats as cancelled.
function finishPick(id: string | null, sound: boolean) {
  const p = pick;
  if (!p) return;
  pick = null;
  if (p.timer) clearInterval(p.timer);
  const source = id ? p.sources.get(id) : undefined;
  try {
    if (source) {
      const streams: Streams = { video: source };
      const isScreen = source.id.startsWith("screen:");
      if (p.audio && sound && SOUND_SUPPORTED && isScreen) streams.audio = "loopback";
      // A window's sound comes separately: the page asks for it right
      // after getDisplayMedia returns (startShareSound below).
      if (p.audio && sound && WINDOW_SOUND_SUPPORTED && !isScreen) {
        pendingSound.set(p.origin, { window: source.id.split(":")[1], at: Date.now() });
      }
      p.callback(streams);
    } else {
      p.callback(null);
    }
  } catch {
    // The page went away while the picker was open: nothing to answer.
  }
  pane?.webContents.send("share-close");
  overlay = false;
  layout();
  if (state.selected) views.get(state.selected)?.webContents.focus();
}

// ---- Window share sound ----
//
// For a window share with Share Sound ticked, the page gets the window's
// program's sound from openvoxa-audio.exe (audio-helper/): it records that
// program and everything it started, as raw PCM on stdout (48 kHz stereo
// s16le, about 192 kB a second), and exits when its stdin closes. The page
// may start it only once per pick, within a few seconds of the pick, and
// only for its own server: a page can never record anything on its own.

const PENDING_SOUND_MS = 15_000;
const pendingSound = new Map<string, { window: string; at: number }>();
const shareSound = new Map<string, ChildProcessWithoutNullStreams>();

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "openvoxa-audio.exe")
    : path.join(__dirname, "..", "audio-helper", "target", "x86_64-pc-windows-gnu", "release", "openvoxa-audio.exe");
}

function startShareSound(origin: string, wc: WebContents): boolean {
  const p = pendingSound.get(origin);
  pendingSound.delete(origin);
  if (!p || Date.now() - p.at > PENDING_SOUND_MS || !/^\d+$/.test(p.window)) return false;
  stopShareSound(origin);
  const child = spawn(helperPath(), ["--window", p.window], { stdio: "pipe", windowsHide: true });
  shareSound.set(origin, child);
  const end = (reason: string) => {
    if (shareSound.get(origin) !== child) return;
    shareSound.delete(origin);
    if (!wc.isDestroyed()) wc.send("share-sound:end", reason);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (shareSound.get(origin) === child && !wc.isDestroyed()) wc.send("share-sound:data", chunk);
  });
  let stderr = "";
  child.stderr.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-2000);
  });
  child.on("error", (err) => end(`couldn't start the sound helper: ${err.message}`));
  child.on("exit", (code) => end(code === 0 ? "stopped" : stderr.split("\n").find((l) => l.startsWith("error:")) ?? `helper exited (${code})`));
  return true;
}

function stopShareSound(origin: string) {
  pendingSound.delete(origin);
  const child = shareSound.get(origin);
  if (!child) return;
  shareSound.delete(origin);
  child.stdin.end(); // the helper exits by itself
  setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000);
}

// viewOrigin returns the server whose own page (main frame, on its own
// origin) sent this message, or null.
function viewOrigin(e: IpcMainInvokeEvent): string | null {
  for (const [origin, view] of views) {
    if (e.sender === view.webContents) {
      return e.senderFrame && e.senderFrame === view.webContents.mainFrame && originOf(e.senderFrame.url) === origin
        ? origin : null;
    }
  }
  return null;
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
      preload: path.join(__dirname, "viewPreload.js"),
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
  // A page that reloads or crashes with the picker open can't take the
  // answer any more: close the picker.
  // Share sound stops with it.
  const dropPick = () => {
    if (pick?.origin === origin) finishPick(null, false);
    stopShareSound(origin);
  };
  view.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) dropPick();
  });
  view.webContents.on("render-process-gone", dropPick);
  view.webContents.on("destroyed", () => stopShareSound(origin));
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
  if (pick && pick.origin !== origin) finishPick(null, false);
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
    pane?.webContents.send("update", updateState());
  });
  ipcMain.handle("pane:install-update", (e) => {
    if (!fromPane(e)) return;
    installNow();
  });
  ipcMain.handle("pane:select", (e, origin: unknown) => {
    if (!fromPane(e) || typeof origin !== "string") return;
    if (state.servers.some((s) => s.origin === origin)) select(origin);
  });
  ipcMain.handle("pane:reload", (e, origin: unknown) => {
    if (!fromPane(e) || typeof origin !== "string") return;
    views.get(origin)?.webContents.reload();
  });
  ipcMain.handle("pane:share", (e, id: unknown, sound: unknown) => {
    if (!fromPane(e) || (id !== null && typeof id !== "string")) return;
    finishPick(id, sound === true);
  });
  ipcMain.handle("view:share-sound-start", (e) => {
    const origin = viewOrigin(e);
    return origin ? startShareSound(origin, e.sender) : false;
  });
  // Read-only, for the About tab: nothing here a page could misuse.
  ipcMain.handle("view:app-info", (e) => viewOrigin(e) ? {
    app: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    os: `${process.platform} ${process.getSystemVersion()}`,
  } : null);
  ipcMain.handle("view:share-sound-stop", (e) => {
    const origin = viewOrigin(e);
    if (origin) stopShareSound(origin);
  });
  ipcMain.handle("pane:overlay", (e, on: unknown) => {
    if (!fromPane(e) || pick) return; // the picker owns the overlay while open
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
    startUpdates((s) => pane?.webContents.send("update", s));
  });
  app.on("window-all-closed", () => app.quit());
}
