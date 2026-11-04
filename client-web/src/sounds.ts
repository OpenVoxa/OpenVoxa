// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Notification sounds (decisions.md Feature decisions, "Custom sounds").
 *
 * Six events. For each one the user picks, per browser: a sound from the
 * Kenney Interface Sounds pack (CC0, client-web/public/sounds/kenney,
 * served at /sounds/kenney/), the "Classic" tones made with WebAudio (the
 * original beeps, no files), or a file of their own. Each event also has
 * on/off and a volume. All of it lives in this browser only: choices in
 * localStorage, the user's own files in a small IndexedDB database of
 * their own ("openvoxa-sounds"; not the encrypted account database,
 * since a sound file is a preference, like the theme, not account data).
 *
 * If a sound can't be loaded or decoded (a browser without Ogg Vorbis,
 * say), the event's default is tried, then the Classic tone, so something
 * always plays.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { VoiceSnapshot } from "@core/voice";
import { localStore } from "./core";

export type SoundEvent = "join" | "leave" | "message" | "mention" | "streamStart" | "streamEnd";

export interface SoundInfo {
  readonly id: SoundEvent;
  readonly label: string;
  readonly help: string;
  /** Default choice: "kenney/<name>" or "classic". */
  readonly fallback: string;
  /** Not played anywhere yet (shown with a note in Settings). */
  readonly pending?: boolean;
  /** The old on/off key this event's switch replaces (settings.ts, before sounds.ts). */
  readonly legacyKey?: string;
}

/** The defaults are Ryan's picks, by ear (2026-11-04). */
export const SOUND_EVENTS: readonly SoundInfo[] = [
  { id: "join", label: "Join", help: "You or someone else joins your call.",
    fallback: "kenney/confirmation_001", legacyKey: "voice.tones" },
  { id: "leave", label: "Leave", help: "You or someone else leaves or drops out of your call.",
    fallback: "kenney/question_004", legacyKey: "voice.tones" },
  { id: "streamStart", label: "Stream Start", help: "Someone in your call starts sharing their screen.",
    fallback: "kenney/maximize_006" },
  { id: "streamEnd", label: "Stream End", help: "Someone in your call stops sharing their screen.",
    fallback: "kenney/minimize_006" },
  { id: "mention", label: "Mention", help: "Someone mentions you, unless you're already looking at that channel.",
    fallback: "kenney/confirmation_004", legacyKey: "chat.mentionSound" },
  { id: "message", label: "Message", help: "A channel you aren't viewing gets a new message.",
    fallback: "classic", pending: true },
];

/** Every file in client-web/public/sounds/kenney, without ".ogg". */
export const KENNEY: readonly string[] = [
  ...seq("back", 4), "bong_001", ...seq("click", 5), ...seq("close", 4), ...seq("confirmation", 4),
  ...seq("drop", 4), ...seq("error", 8), ...seq("glass", 6), ...seq("glitch", 4), ...seq("maximize", 9),
  ...seq("minimize", 9), ...seq("open", 4), ...seq("pluck", 2), ...seq("question", 4), ...seq("scratch", 5),
  ...seq("scroll", 5), ...seq("select", 8), ...seq("switch", 7), "tick_001", "tick_002", "tick_004",
  ...seq("toggle", 4),
];

function seq(name: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${name}_${String(i + 1).padStart(3, "0")}`);
}

/** "glass_004" -> "Glass 4". */
export function kenneyLabel(name: string): string {
  const [word, num] = name.split("_");
  return `${word[0].toUpperCase()}${word.slice(1)} ${Number(num)}`;
}

/** Limits on the user's own files. */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SECONDS = 5;
export const DEFAULT_VOLUME = 60;

// ------------------------------------------------------------ settings

export interface SoundSetting {
  on: boolean;
  /** "kenney/<name>", "classic" or "custom". */
  choice: string;
  /** 0..100 */
  volume: number;
  /** The user's own file's name, if they've chosen one. */
  customName: string | null;
}

const key = (id: SoundEvent, what: string) => `sound.${id}.${what}`;
const info = (id: SoundEvent) => SOUND_EVENTS.find((s) => s.id === id)!;

function readSetting(id: SoundEvent): SoundSetting {
  const s = info(id);
  const on = localStore.get(key(id, "on")) ?? (s.legacyKey ? localStore.get(s.legacyKey) : null);
  const vol = Number(localStore.get(key(id, "volume")));
  const customName = localStore.get(key(id, "customName")) || null;
  let choice = localStore.get(key(id, "choice")) || s.fallback;
  if (choice === "custom" && !customName) choice = s.fallback;
  if (choice.startsWith("kenney/") && !KENNEY.includes(choice.slice(7))) choice = s.fallback;
  return {
    on: on !== "0",
    choice,
    volume: localStore.get(key(id, "volume")) === null || !Number.isFinite(vol)
      ? DEFAULT_VOLUME : Math.min(100, Math.max(0, vol)),
    customName,
  };
}

const listeners = new Set<() => void>();
const cache = new Map<SoundEvent, SoundSetting>();

export function getSound(id: SoundEvent): SoundSetting {
  let s = cache.get(id);
  if (!s) cache.set(id, (s = readSetting(id)));
  return s;
}

function changed(id: SoundEvent): void {
  cache.delete(id);
  for (const l of listeners) l();
}

export function setSoundOn(id: SoundEvent, on: boolean): void {
  localStore.set(key(id, "on"), on ? "1" : "0");
  changed(id);
}

export function setSoundChoice(id: SoundEvent, choice: string): void {
  localStore.set(key(id, "choice"), choice);
  changed(id);
}

export function setSoundVolume(id: SoundEvent, volume: number): void {
  localStore.set(key(id, "volume"), String(Math.round(volume)));
  changed(id);
}

/** Back to the default sound and volume; the user's own file is forgotten. */
export async function resetSound(id: SoundEvent): Promise<void> {
  localStore.set(key(id, "choice"), "");
  localStore.set(key(id, "volume"), String(DEFAULT_VOLUME));
  localStore.set(key(id, "customName"), "");
  decoded.delete(`custom:${id}`);
  await fileDb("readwrite", (st) => st.delete(id)).catch(() => {});
  changed(id);
}

export function isDefault(id: SoundEvent): boolean {
  const s = getSound(id);
  return s.choice === info(id).fallback && s.volume === DEFAULT_VOLUME && !s.customName;
}

export function useSound(id: SoundEvent): SoundSetting {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getSound(id),
  );
}

// -------------------------------------------------------- user's files

interface StoredFile {
  name: string;
  data: ArrayBuffer;
}

function fileDb<T>(mode: IDBTransactionMode, op: (st: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("openvoxa-sounds", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("files");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = op(db.transaction("files", mode).objectStore("files"));
      req.onsuccess = () => { resolve(req.result); db.close(); };
      req.onerror = () => { reject(req.error); db.close(); };
    };
  });
}

/**
 * Checks and keeps the user's own file for one event, and makes it the
 * choice. Throws a message for the user if it's too big, too long or not
 * a sound the browser can play.
 */
export async function setCustomFile(id: SoundEvent, file: File): Promise<void> {
  if (!/\.(mp3|ogg|wav)$/i.test(file.name)) throw new Error("Choose an MP3, OGG or WAV file.");
  if (file.size > MAX_FILE_BYTES) throw new Error("That file is over 1 MB. Choose a shorter sound.");
  const data = await file.arrayBuffer();
  let buf: AudioBuffer;
  try {
    buf = await audio().decodeAudioData(data.slice(0));
  } catch {
    throw new Error("This browser can't play that file. Try an MP3 or WAV.");
  }
  if (buf.duration > MAX_SECONDS) {
    throw new Error(`That sound is ${buf.duration.toFixed(1)} seconds long; the limit is ${MAX_SECONDS}.`);
  }
  await fileDb("readwrite", (st) => st.put({ name: file.name, data } satisfies StoredFile, id));
  decoded.set(`custom:${id}`, Promise.resolve(buf));
  localStore.set(key(id, "customName"), file.name);
  localStore.set(key(id, "choice"), "custom");
  changed(id);
}

// ------------------------------------------------------------ playback

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Decoded sounds by source ("kenney/glass_004", "custom:join"). */
const decoded = new Map<string, Promise<AudioBuffer>>();

function load(id: SoundEvent, choice: string): Promise<AudioBuffer> {
  const src = choice === "custom" ? `custom:${id}` : choice;
  let p = decoded.get(src);
  if (!p) {
    p = (async () => {
      let data: ArrayBuffer;
      if (choice === "custom") {
        const f = await fileDb<StoredFile | undefined>("readonly", (st) => st.get(id));
        if (!f) throw new Error("file gone");
        data = f.data.slice(0);
      } else {
        const res = await fetch(`/sounds/${choice}.ogg`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.arrayBuffer();
      }
      return audio().decodeAudioData(data);
    })();
    p.catch(() => decoded.delete(src));
    decoded.set(src, p);
  }
  return p;
}

/**
 * Plays an event's sound, if it's switched on. `preview` plays it even
 * when off, and lets Settings try a choice before keeping it.
 */
export async function playSound(id: SoundEvent, preview?: { choice: string }): Promise<void> {
  const s = getSound(id);
  if (!preview && !s.on) return;
  const gain = s.volume / 100;
  if (gain <= 0) return;
  const tries = [preview?.choice ?? s.choice, info(id).fallback];
  try {
    for (const choice of tries) {
      if (choice === "classic") break;
      try {
        const buf = await load(id, choice);
        const ac = audio();
        const src = ac.createBufferSource();
        const g = ac.createGain();
        src.buffer = buf;
        g.gain.value = gain;
        src.connect(g).connect(ac.destination);
        src.start();
        return;
      } catch {
        /* try the next one */
      }
    }
    classic(id, gain);
  } catch {
    /* no WebAudio: stay quiet */
  }
}

/** The original synthesised tones: two or three short sine notes. */
function classic(id: SoundEvent, gain: number): void {
  const C5 = 523.25, E5 = 659.25, G5 = 783.99;
  const notes = {
    join: [C5, G5],
    leave: [G5, C5],
    mention: [880, 1174.66], // A5, D6: higher, so it isn't mistaken for a call
    message: [E5],
    streamStart: [C5, E5, G5],
    streamEnd: [G5, E5, C5],
  }[id];
  const ac = audio();
  const peak = 0.2 * gain; // 0.12 at the default volume, as before
  const start = ac.currentTime + 0.01;
  notes.forEach((freq, i) => {
    const t = start + i * 0.09;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // A quick fade in and out, or the note clicks.
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.18);
  });
}

// --------------------------------------------------------- voice calls

/** After connecting, people already in the call are not announced. */
const SETTLE_MS = 2000;

/**
 * Join, leave and stream sounds for your call: when you connect or
 * leave, and when someone else joins, leaves, or starts or stops sharing
 * their screen (your own share too). Each participant is an account
 * (LiveKit identity), so the same person reconnecting quickly may chime
 * twice; that's honest.
 */
export function useVoiceSounds(snap: VoiceSnapshot | null): void {
  const prev = useRef<{ connected: boolean; channel: string | null; ids: Set<string>; sharing: Set<string>; since: number }>({
    connected: false, channel: null, ids: new Set(), sharing: new Set(), since: 0,
  });
  useEffect(() => {
    const was = prev.current;
    const connected = snap?.state === "connected";
    const channel = connected ? snap!.channelId : null;
    const people = connected ? snap!.participants : [];
    const ids = new Set(people.filter((p) => !p.isLocal).map((p) => p.id));
    const sharing = new Set(people.filter((p) => p.sharing).map((p) => p.id));

    let since = was.since;
    if (connected && (!was.connected || was.channel !== channel)) {
      void playSound("join");
      since = Date.now();
    } else if (!connected && was.connected) {
      void playSound("leave");
    } else if (connected && Date.now() - since > SETTLE_MS) {
      // (Right after connecting, the people already there arrive one by
      // one; they aren't joining, and shares already running aren't
      // starting.)
      const joined = [...ids].some((id) => !was.ids.has(id));
      const left = [...was.ids].some((id) => !ids.has(id));
      const started = [...sharing].some((id) => !was.sharing.has(id));
      // Someone who leaves mid-share gets the leave sound, not both.
      const present = new Set(people.map((p) => p.id));
      const stopped = [...was.sharing].some((id) => !sharing.has(id) && present.has(id));
      if (joined) void playSound("join");
      else if (left) void playSound("leave");
      else if (started) void playSound("streamStart");
      else if (stopped) void playSound("streamEnd");
    }
    prev.current = { connected, channel, ids, sharing, since };
  }, [snap]);
}

