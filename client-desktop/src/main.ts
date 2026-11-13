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
// offers little: the sound for a window share the user just picked, and
// Smart Switch's signals (the app asks for a switch; the page says its
// shared window closed or its share ended).
// The pane (our own local page) talks to this process, and every message
// is checked to come from the pane or, for share sound, from the view of
// the server that asked.

import { app, BaseWindow, WebContentsView, ipcMain, Menu, dialog, shell, net, session, desktopCapturer } from "electron";
import type { DesktopCapturerSource, IpcMainInvokeEvent, Session, Streams, WebContents } from "electron";
import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, writeFileSync, mkdirSync } from "node:fs";
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

// name and icon come from the server's /api/v1/server-info and are kept
// here, so the pane shows them at once and while a server is offline.
// icon is a data: URL the shell built itself (see fetchServerInfo);
// iconSrc is the server's icon path, with its version, already fetched.
type Server = { origin: string; name?: string; icon?: string; iconSrc?: string };
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
      ? s.servers
          .filter((x) => typeof x?.origin === "string" && normalizeOrigin(x.origin) === x.origin)
          .map((x) => {
            const icon = typeof x.icon === "string" && ICON_DATA_URL.test(x.icon) ? x.icon : undefined;
            return {
              origin: x.origin,
              name: typeof x.name === "string" ? cleanName(x.name) || undefined : undefined,
              icon,
              iconSrc: icon && typeof x.iconSrc === "string" ? x.iconSrc : undefined,
            };
          })
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

// ---- Server name and icon ----

const NAME_MAX = 40;
const ICON_MAX_BYTES = 512 * 1024;
const ICON_DATA_URL = /^data:image\/(png|webp);base64,[A-Za-z0-9+/]+=*$/;

// cleanName: no control characters, at most NAME_MAX characters.
function cleanName(s: string): string {
  return Array.from(s.replace(/\p{Cc}/gu, "").trim()).slice(0, NAME_MAX).join("");
}

// iconType reads the type from the bytes, never from the server's
// headers: PNG or WebP only. SVG and everything else are refused (an SVG
// can carry script).
function iconType(b: Uint8Array): string | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

const infoFetches = new Map<string, Promise<void>>();

// fetchServerInfo asks a server for its name and icon and keeps them.
// The pane only ever gets a name (shown as text) and a data: URL of a
// PNG or WebP built here, so it never loads anything from a server.
// One fetch per server at a time; failures keep what was known.
function fetchServerInfo(origin: string): Promise<void> {
  const running = infoFetches.get(origin);
  if (running) return running;
  const p = (async () => {
    try {
      const res = await net.fetch(origin + "/api/v1/server-info", { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const body = (await res.json()) as { name?: unknown; icon?: unknown };
      const name = typeof body.name === "string" ? cleanName(body.name) || undefined : undefined;
      let icon: string | undefined;
      let iconSrc: string | undefined;
      if (typeof body.icon === "string") {
        const url = new URL(body.icon, origin);
        if (url.origin !== origin || url.pathname !== "/api/v1/server-icon") return;
        iconSrc = url.pathname + url.search;
        const known = state.servers.find((s) => s.origin === origin);
        if (known?.iconSrc === iconSrc && known.icon) {
          icon = known.icon;
        } else {
          const r = await net.fetch(url.href, { signal: AbortSignal.timeout(10_000) });
          if (!r.ok) return;
          const bytes = new Uint8Array(await r.arrayBuffer());
          const type = bytes.length <= ICON_MAX_BYTES ? iconType(bytes) : null;
          if (!type) return;
          icon = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
        }
      }
      const s = state.servers.find((x) => x.origin === origin);
      if (!s || (s.name === name && s.icon === icon && s.iconSrc === iconSrc)) return;
      s.name = name;
      s.icon = icon;
      s.iconSrc = iconSrc;
      saveState();
      sendServers();
    } catch {
      /* offline or not answering: keep what we had */
    } finally {
      infoFetches.delete(origin);
    }
  })();
  infoFetches.set(origin, p);
  return p;
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
    void answerShare(origin, request.audioRequested, callback);
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
  /** Source id -> its Smart Switch pair, for windows of a listed game. */
  pairs: Map<string, Pair>;
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
  // Smart Switch only for a page that can follow a switch (shareFollowers).
  const pairs = shareFollowers.has(p.origin) ? await pairsOf(found) : new Map<string, Pair>();
  if (pick !== p) return;
  p.sources = new Map(found.map((s) => [s.id, s]));
  p.pairs = pairs;
  pane?.webContents.send("share-sources", found.map((s) => ({
    id: s.id,
    name: s.name,
    screen: s.id.startsWith("screen:"),
    thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    smart: pairs.get(s.id)?.name ?? null,
  })));
}

// gone: the page asked because the window it shared closed, not because
// the user clicked. The picker then opens without taking the focus (the
// user is likely in a game) and the taskbar button flashes instead.
async function openPicker(origin: string, audio: boolean, callback: (streams: Streams | null) => void, gone = false) {
  // Only the server on screen may open it (a background server asking
  // would pop a picker for a page the user can't see), and only one.
  if (pick || !pane || !win || state.selected !== origin) return callback(null);
  const p: Pick = { origin, audio, callback, sources: new Map(), pairs: new Map(), timer: null };
  pick = p;
  pane.webContents.send("share-open", {
    host: new URL(origin).host, audio, screenSound: SOUND_SUPPORTED, windowSound: WINDOW_SOUND_SUPPORTED, gone,
  });
  overlay = true;
  layout();
  if (!gone) {
    win.focus();
    pane.webContents.focus();
  } else if (!win.isFocused()) {
    win.flashFrame(true);
  }
  await listSources(p);
  if (pick === p) p.timer = setInterval(() => void listSources(p), 2000);
}

// finishPick answers the page and closes the picker. A null id cancels:
// the page's getDisplayMedia then fails with "AbortError: Invalid capture
// constraints" (Electron 45, found by experiment; null, {} and no
// argument all give the same), which the web client treats as cancelled.
function finishPick(id: string | null, sound: boolean, smart = false) {
  const p = pick;
  if (!p) return;
  pick = null;
  if (p.timer) clearInterval(p.timer);
  win?.flashFrame(false);
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
      // A new pick decides Smart Switch afresh: on for a listed game's
      // window with the box ticked, off for anything else.
      const pair = p.pairs.get(source.id);
      if (smart && pair) startFollow(p.origin, pair, source.id, p.audio && sound);
      else stopFollow(p.origin);
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

// ---- Smart Switch (decisions.md, "Smart Switch") ----
//
// Some games keep two windows from two programs: League of Legends has
// its client (lobby, champ select) and, during a match, the game itself.
// A window share follows one window and ends when it closes, so the app
// keeps a list of such pairs. Sharing either window of a pair with Smart
// Switch ticked starts a follow: every two seconds the app looks at the
// open windows and, when the share should move (the game window opened,
// or it closed and the client is still there), asks the page to switch.
// The page then calls getDisplayMedia again (VoiceClient.switchShare, so
// viewers keep watching), and answerShare hands it the pair's window
// itself, without the picker. Electron 45 needs no click for that
// (checked by experiment, 2026-11-13).
//
// The page can't steer this: it can only say "my shared window closed"
// (shareGone), and the answer is then the pair's other window, if the
// user started a follow in our picker, or our picker.

type Pair = { name: string; client: string; game: string };

// Program file names, compared without case. Only pairs someone has
// tried on a real PC go in here.
const PAIRS: Pair[] = [
  { name: "League of Legends", client: "LeagueClientUx.exe", game: "League of Legends.exe" },
  // For testing elsewhere: OPENVOXA_SMART_PAIRS='[{"name":..,"client":..,"game":..}]'.
  ...extraPairs(),
];

function extraPairs(): Pair[] {
  try {
    const list = JSON.parse(process.env.OPENVOXA_SMART_PAIRS ?? "[]") as unknown;
    return Array.isArray(list)
      ? list.filter((x): x is Pair => typeof x?.name === "string" && typeof x?.client === "string" && typeof x?.game === "string")
      : [];
  } catch {
    return [];
  }
}

const FOLLOW_EVERY_MS = 2000;
// How long a closed window's share waits for the pair's other window
// before falling back to the picker (a game window takes a while to open
// after the client closes, if it closes at all).
const GONE_WAIT_MS = 10_000;
// A switch the app asked for, or a "gone" from the page, is answered
// without the picker only this soon after: the page asks at once, and a
// stale one must not answer a later click on Switch What You Share.
const AUTO_MS = { switch: 5_000, gone: 15_000 };

type Follow = {
  pair: Pair;
  sound: boolean;
  /** The source id now shared. */
  current: string;
  timer: NodeJS.Timeout;
  busy: boolean;
};
const follows = new Map<string, Follow>();
/** Pages (origins) that told us they can follow a switch (newer web clients). */
const shareFollowers = new Set<string>();
/** origin -> why the next getDisplayMedia may be answered without the picker. */
const autoShare = new Map<string, { kind: "switch" | "gone"; at: number }>();

// exeNames: the program file name behind each window source, from our
// helper on Windows, from xprop and /proc on Linux (X11). Missing when it
// can't be told.
async function exeNames(windows: DesktopCapturerSource[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const handles = new Map<string, string>(); // native id -> source id
  for (const s of windows) {
    const m = /^window:(\d+):/.exec(s.id);
    if (m) handles.set(m[1], s.id);
  }
  if (handles.size === 0) return out;
  if (process.platform === "win32") {
    if (!existsSync(helperPath())) return out;
    const text = await runQuiet(helperPath(), ["--exe", ...handles.keys()]);
    for (const line of text.split(/\r?\n/)) {
      const [h, exe] = line.split("\t");
      const id = handles.get(h);
      if (id && exe) out.set(id, exe);
    }
  } else if (process.platform === "linux") {
    await Promise.all([...handles].map(async ([h, id]) => {
      const m = /= (\d+)/.exec(await runQuiet("xprop", ["-id", h, "_NET_WM_PID"]));
      if (!m) return;
      try {
        out.set(id, path.basename(readlinkSync(`/proc/${m[1]}/exe`)));
      } catch {
        /* gone, or not ours to read */
      }
    }));
  }
  return out;
}

// runQuiet runs a small program and returns its stdout ("" on any error).
function runQuiet(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

function pairFor(exe: string): Pair | undefined {
  const e = exe.toLowerCase();
  return PAIRS.find((p) => p.client.toLowerCase() === e || p.game.toLowerCase() === e);
}

// pairsOf: which of these windows belong to a listed game.
async function pairsOf(sources: DesktopCapturerSource[]): Promise<Map<string, Pair>> {
  const pairs = new Map<string, Pair>();
  if (PAIRS.length === 0) return pairs;
  const exes = await exeNames(sources.filter((s) => s.id.startsWith("window:")));
  for (const [id, exe] of exes) {
    const pair = pairFor(exe);
    if (pair) pairs.set(id, pair);
  }
  return pairs;
}

// pairWindow: the window the share should show now: the game while it is
// open, else the client. The window already shared wins among several of
// the same program.
async function pairWindow(f: Follow): Promise<DesktopCapturerSource | null> {
  let found: DesktopCapturerSource[];
  try {
    found = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
  } catch {
    return null;
  }
  const exes = await exeNames(found);
  const of = (exe: string) => {
    const mine = found.filter((s) => exes.get(s.id)?.toLowerCase() === exe.toLowerCase());
    return mine.find((s) => s.id === f.current) ?? mine[0] ?? null;
  };
  return of(f.pair.game) ?? of(f.pair.client);
}

function startFollow(origin: string, pair: Pair, current: string, sound: boolean) {
  stopFollow(origin);
  const f: Follow = { pair, sound, current, busy: false, timer: setInterval(() => void checkFollow(origin, f), FOLLOW_EVERY_MS) };
  follows.set(origin, f);
}

function stopFollow(origin: string) {
  const f = follows.get(origin);
  if (f) clearInterval(f.timer);
  follows.delete(origin);
  autoShare.delete(origin);
}

async function checkFollow(origin: string, f: Follow) {
  const auto = autoShare.get(origin);
  if (auto && Date.now() - auto.at > AUTO_MS[auto.kind]) autoShare.delete(origin); // never asked for
  if (f.busy || follows.get(origin) !== f || pick?.origin === origin || autoShare.has(origin)) return;
  f.busy = true;
  try {
    const want = await pairWindow(f);
    if (!want || want.id === f.current || follows.get(origin) !== f || autoShare.has(origin)) return;
    const view = views.get(origin);
    if (!view || view.webContents.isDestroyed()) return stopFollow(origin);
    autoShare.set(origin, { kind: "switch", at: Date.now() });
    view.webContents.send("share-follow:switch");
  } finally {
    f.busy = false;
  }
}

// answerShare answers a page's getDisplayMedia: with the pair's window
// when the app asked for the switch (or the shared window closed during a
// follow), else with our picker.
async function answerShare(origin: string, audio: boolean, callback: (streams: Streams | null) => void) {
  const auto = autoShare.get(origin);
  autoShare.delete(origin);
  if (!auto || Date.now() - auto.at > AUTO_MS[auto.kind]) return openPicker(origin, audio, callback);
  const f = follows.get(origin);
  if (f) {
    let target = await pairWindow(f);
    // The shared window closed: give the other one time to open.
    for (const until = Date.now() + GONE_WAIT_MS; !target && auto.kind === "gone" && Date.now() < until;) {
      await new Promise((r) => setTimeout(r, 1000));
      if (follows.get(origin) !== f) break;
      target = await pairWindow(f);
    }
    if (target && follows.get(origin) === f) {
      f.current = target.id;
      if (audio && f.sound && WINDOW_SOUND_SUPPORTED) {
        pendingSound.set(origin, { window: target.id.split(":")[1], at: Date.now() });
      }
      try {
        callback({ video: target });
      } catch {
        // The page went away meanwhile.
      }
      return;
    }
  }
  // Nothing to switch to: an app-asked switch just doesn't happen (the
  // share stays as it is); a closed window gets the picker, quietly.
  if (auto.kind === "switch") return callback(null);
  stopFollow(origin);
  return openPicker(origin, audio, callback, true);
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
    stopFollow(origin);
    shareFollowers.delete(origin);
  };
  view.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) dropPick();
  });
  view.webContents.on("render-process-gone", dropPick);
  view.webContents.on("destroyed", () => {
    stopShareSound(origin);
    stopFollow(origin);
    shareFollowers.delete(origin);
  });
  view.webContents.on("did-finish-load", () => {
    pane?.webContents.send("server-error", { origin, message: null });
    void fetchServerInfo(origin);
  });
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
  ipcMain.handle("pane:share", (e, id: unknown, sound: unknown, smart: unknown) => {
    if (!fromPane(e) || (id !== null && typeof id !== "string")) return;
    finishPick(id, sound === true, smart === true);
  });
  // Smart Switch (see above). follow-ready: this page can switch when
  // asked; gone: its shared window closed; stopped: its share ended.
  ipcMain.handle("view:share-follow-ready", (e) => {
    const origin = viewOrigin(e);
    if (origin) shareFollowers.add(origin);
  });
  ipcMain.handle("view:share-gone", (e) => {
    const origin = viewOrigin(e);
    if (origin) autoShare.set(origin, { kind: "gone", at: Date.now() });
  });
  ipcMain.handle("view:share-stopped", (e) => {
    const origin = viewOrigin(e);
    if (origin) stopFollow(origin);
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
  // A nudge only: the page says the name or icon changed and the shell
  // fetches them itself, so nothing the page sends reaches the pane.
  ipcMain.handle("view:server-info-changed", (e) => {
    const origin = viewOrigin(e);
    if (origin) void fetchServerInfo(origin);
  });
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
