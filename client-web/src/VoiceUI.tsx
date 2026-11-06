// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Voice and screen sharing UI (build order 13, M3): the voice bar above
 * the user panel, the people in each call in the sidebar, the stage that
 * shows screen shares, and the settings, share and per-person dialogs.
 * All media logic is client-core's VoiceClient (loaded on first join).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type {
  AudioDevices, AudioSettings, MicLevel, MicMode, ScreenShare, ShareSettings, VoiceClient, VoiceParticipant,
  VoiceSnapshot,
} from "@core/voice";
import type { ApiCall } from "@core/identity";
import { Modal } from "./ChannelDialogs";
import { localStore } from "./core";
import { ColouredName } from "./names";
import { PRESETS, presetAllowed, type ShareLimit } from "./shareLimit";

export function useVoiceSnapshot(voice: VoiceClient | null): VoiceSnapshot | null {
  const subscribe = useCallback((cb: () => void) => (voice ? voice.on(cb) : () => {}), [voice]);
  return useSyncExternalStore(subscribe, () => (voice ? voice.snapshot() : null));
}

// ------------------------------------------------------- push-to-talk

const PTT_KEY = "voice.pttKey";
const DEFAULT_PTT = "Backquote";

export function pttKey(): string {
  return localStore.get(PTT_KEY) || DEFAULT_PTT;
}

/** "Backquote" -> "`", "KeyV" -> "V", "ControlRight" -> "Right Ctrl". */
export function keyLabel(code: string): string {
  const named: Record<string, string> = {
    Backquote: "` (Backtick)", Space: "Space", ControlRight: "Right Ctrl", ControlLeft: "Left Ctrl",
    ShiftRight: "Right Shift", ShiftLeft: "Left Shift", AltRight: "Right Alt", AltLeft: "Left Alt",
    CapsLock: "Caps Lock", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
  };
  if (named[code]) return named[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

// ------------------------------------------------ on-screen talk button

/** auto: only where there is a touch screen; always; never. */
export type TalkButtonPref = "auto" | "always" | "never";
const TALK_BUTTON = "voice.talkButton";
const talkButtonListeners = new Set<() => void>();
const TOUCH = "(any-pointer: coarse)";

export function talkButtonPref(): TalkButtonPref {
  const v = localStore.get(TALK_BUTTON);
  return v === "always" || v === "never" ? v : "auto";
}

function setTalkButtonPref(v: TalkButtonPref): void {
  localStore.set(TALK_BUTTON, v);
  for (const l of talkButtonListeners) l();
}

/** Whether the voice bar shows the talk button: the setting, and for Auto whether there's a touch screen. */
function useTalkButtonShown(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    talkButtonListeners.add(cb);
    const mq = window.matchMedia(TOUCH);
    mq.addEventListener("change", cb);
    return () => {
      talkButtonListeners.delete(cb);
      mq.removeEventListener("change", cb);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => {
    const pref = talkButtonPref();
    return pref === "always" || (pref === "auto" && window.matchMedia(TOUCH).matches);
  });
}

/**
 * Push-to-Talk or Tap to Talk without a keyboard. It presses the same
 * "key" as usePushToTalk: held while a finger (or the mouse button) is
 * down, so in Tap to Talk a tap opens and the next tap closes. Pointer
 * capture keeps it held when the finger slides off the button; a
 * cancelled touch (the browser took it for a scroll) lets go.
 */
function TalkButton({ voice, snap }: { voice: VoiceClient; snap: VoiceSnapshot }) {
  const held = useRef(false);
  const blocked = snap.state !== "connected" || !snap.canPublish || snap.serverMuted || snap.deafened;
  const press = (on: boolean) => {
    // Some browsers (Safari) still deliver pointer events to a disabled button.
    if (on && blocked) return;
    if (held.current === on) return;
    held.current = on;
    voice.setPTTHeld(on);
  };
  // Let go if the bar goes away mid-press (left the call, mode changed).
  useEffect(() => () => {
    if (held.current) voice.setPTTHeld(false);
  }, [voice]);

  const tap = snap.micMode === "tap";
  const label = snap.pttHeld ? (tap ? "Talking: Tap to Stop" : "Talking") : tap ? "Tap to Talk" : "Hold to Talk";
  const why = !snap.canPublish ? "You can't speak here"
    : snap.serverMuted ? "A moderator has muted you"
    : snap.deafened ? "Undeafen to talk"
    : tap ? "Tap, then talk; it closes when you stop" : "Hold while you talk";
  return (
    <button className={`talk-btn${snap.pttHeld ? " talking" : ""}`} disabled={blocked} title={why}
      aria-pressed={snap.pttHeld}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        press(true);
      }}
      onPointerUp={() => press(false)}
      onPointerCancel={() => press(false)}
      onLostPointerCapture={() => press(false)}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          press(true);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") press(false);
      }}
      onBlur={() => press(false)}>
      {label}
    </button>
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && !["checkbox", "radio", "range", "button"].includes((el as HTMLInputElement).type));
}

/** A key that types a character: ignored for push-to-talk while typing. */
function typesCharacter(e: KeyboardEvent): boolean {
  return e.key.length === 1;
}

/**
 * Hold the push-to-talk key to talk. A web page only sees keys while its
 * tab is focused; the desktop app will add a global hotkey. While typing
 * in a text field, a key that types a character is left alone (pick a key
 * like F13 or Right Ctrl to talk while typing).
 */
export function usePushToTalk(voice: VoiceClient | null, snap: VoiceSnapshot | null) {
  const active = !!voice && snap?.state === "connected" && snap.pttMode && snap.canPublish;
  useEffect(() => {
    if (!active || !voice) return;
    const code = pttKey();
    const down = (e: KeyboardEvent) => {
      if (e.code !== code || e.repeat) return;
      if (isTyping(e.target) && typesCharacter(e)) return;
      e.preventDefault();
      voice.setPTTHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== code) return;
      voice.setPTTHeld(false);
    };
    // Releasing the key in another window never reaches us.
    const blur = () => voice.setPTTHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      voice.setPTTHeld(false);
    };
  }, [active, voice]);
}

// --------------------------------------------------------------- icons

/** locked: a big X instead of the slash, for a server mute (not the user's choice). */
export function MicIcon({ off, locked }: { off?: boolean; locked?: boolean }) {
  if (locked) {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <path fill="currentColor" opacity="0.45" d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1zM3.5 7a.75.75 0 0 1 .75.75 3.75 3.75 0 0 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.2V14.5h2a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5h2v-1.55a5.25 5.25 0 0 1-4.5-5.2A.75.75 0 0 1 3.5 7z" />
        <path stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" d="M2.5 2.5l11 11M13.5 2.5l-11 11" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1zM3.5 7a.75.75 0 0 1 .75.75 3.75 3.75 0 0 0 7.5 0 .75.75 0 0 1 1.5 0 5.25 5.25 0 0 1-4.5 5.2V14.5h2a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5h2v-1.55a5.25 5.25 0 0 1-4.5-5.2A.75.75 0 0 1 3.5 7z" />
      {off && <path stroke="currentColor" strokeWidth="1.6" d="M2 2l12 12" />}
    </svg>
  );
}

export function HeadphonesIcon({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M8 2a6 6 0 0 0-6 6v4.5A1.5 1.5 0 0 0 3.5 14H5a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1H3.5V8a4.5 4.5 0 0 1 9 0v1H11a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h1.5a1.5 1.5 0 0 0 1.5-1.5V8a6 6 0 0 0-6-6z" />
      {off && <path stroke="currentColor" strokeWidth="1.6" d="M2 2l12 12" />}
    </svg>
  );
}

function ScreenIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M2 3h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9.5v1.5H11V15H5v-1.5h1.5V12H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm.5 1.5v6h11v-6h-11z" />
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M8 5.5c2.6 0 5 .8 6.6 2.1.5.4.5 1 .1 1.5l-1.2 1.2c-.3.3-.8.4-1.2.2l-1.7-.8a1 1 0 0 1-.6-.9V7.4A9.6 9.6 0 0 0 8 7c-.7 0-1.4.1-2 .4v1.4a1 1 0 0 1-.6.9l-1.7.8c-.4.2-.9.1-1.2-.2L1.3 9.1c-.4-.5-.4-1.1.1-1.5C3 6.3 5.4 5.5 8 5.5z" />
    </svg>
  );
}

function CogIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M9.4 1l.3 1.8c.5.2.9.4 1.3.7l1.7-.7 1.4 2.4-1.4 1.1a5 5 0 0 1 0 1.5l1.4 1.1-1.4 2.4-1.7-.7c-.4.3-.8.5-1.3.7L9.4 15H6.6l-.3-1.8c-.5-.2-.9-.4-1.3-.7l-1.7.7-1.4-2.4 1.4-1.1a5 5 0 0 1 0-1.5L1.9 7.1l1.4-2.4 1.7.7c.4-.3.8-.5 1.3-.7L6.6 1h2.8zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />
    </svg>
  );
}

// ------------------------------------------------- sidebar participants

/**
 * The people in one voice channel, under it in the sidebar. For the call
 * you are in this is live (speaking, mic, sharing); for others it is the
 * server's list.
 */
export function VoiceRoster({ live, others, onWatch, onPerson }: {
  live: readonly VoiceParticipant[] | null;
  others: readonly { user_id: string; username: string }[];
  onWatch: (participantId: string) => void;
  onPerson: (p: VoiceParticipant, at: { x: number; y: number }) => void;
}) {
  if (live) {
    if (!live.length) return null;
    return (
      <ul className="roster">
        {live.map((p) => (
          <li key={p.id}
            className={`${p.speaking && !p.micOff ? "speaking" : ""}${p.localMuted ? " local-muted" : ""}`}
            onContextMenu={(e) => {
              if (p.isLocal) return;
              e.preventDefault();
              onPerson(p, { x: e.clientX, y: e.clientY });
            }}>
            <span className="avatar" aria-hidden>{p.name.slice(0, 1).toUpperCase()}</span>
            <button className="who" disabled={p.isLocal}
              title={p.isLocal ? undefined : "Volume (or right-click)"}
              onClick={(e) => !p.isLocal && onPerson(p, { x: e.clientX, y: e.clientY })}>
              <ColouredName userId={p.id}>{p.name}</ColouredName>{p.isLocal ? " (you)" : ""}
            </button>
            {!p.encrypted && <span className="warn small" title="Not encrypted yet">!</span>}
            {p.sharing && <button className="live" onClick={() => onWatch(p.id)} title="Watch">LIVE</button>}
            {p.serverMuted
              ? <span className="state server-muted" title="Muted by a moderator"><MicIcon locked /></span>
              : p.micOff && <span className="state" title={p.isLocal ? "Your mic is off" : "Mic off"}><MicIcon off /></span>}
            {!p.isLocal && p.localMuted && <span className="state" title="Muted for you"><HeadphonesIcon off /></span>}
          </li>
        ))}
      </ul>
    );
  }
  if (!others.length) return null;
  return (
    <ul className="roster">
      {others.map((p) => (
        <li key={p.user_id}>
          <span className="avatar" aria-hidden>{p.username.slice(0, 1).toUpperCase()}</span>
          <ColouredName userId={p.user_id} className="who">{p.username}</ColouredName>
        </li>
      ))}
    </ul>
  );
}

/** Server mute lengths, as Postgres intervals; "" lasts until unmuted. */
export const MUTE_DURATIONS: [string, string][] = [
  ["", "Until unmuted"],
  ["10 minutes", "10 minutes"],
  ["1 hour", "1 hour"],
  ["1 day", "1 day"],
];

/**
 * Volume and "mute for me" for one person, at the click position; for
 * holders of server_mute, the server mute too.
 */
export function PersonMenu({ voice, person, at, call, canServerMute, onClose }: {
  voice: VoiceClient;
  person: VoiceParticipant;
  at: { x: number; y: number };
  call: ApiCall;
  canServerMute: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [vol, setVol] = useState(Math.round(person.volume * 100));
  const [duration, setDuration] = useState("");
  const [busy, setBusy] = useState(false);
  const [muteError, setMuteError] = useState<string | null>(null);

  // The menu updates itself when LiveKit reports the new permission.
  async function serverMute(on: boolean) {
    setBusy(true);
    setMuteError(null);
    try {
      await call(`/api/v1/users/${person.id}/voice-mute`, on
        ? { method: "PUT", body: JSON.stringify({ duration }) }
        : { method: "DELETE" });
    } catch (err) {
      setMuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const share = voice.snapshot().screens.find((s) => s.participantId === person.id && s.hasAudio);
  const left = Math.min(at.x, window.innerWidth - 240);
  const top = Math.min(at.y, window.innerHeight - (canServerMute ? 330 : 140) - (share ? 32 : 0));
  return (
    <div ref={ref} className="menu" style={{ left, top }} role="dialog" aria-label={`${person.name} volume`}>
      <strong>{person.name}</strong>
      <label>
        Volume {vol}%
        <input type="range" min={0} max={100} value={vol}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVol(v);
            voice.setUserVolume(person.id, v / 100);
          }} />
      </label>
      <label className="check">
        <input type="checkbox" checked={person.localMuted}
          onChange={(e) => voice.setUserMuted(person.id, e.target.checked)} />
        <span>Mute for me</span>
      </label>
      <p className="muted small">Only on this device. Nobody else is told.</p>
      {share && (
        <label className="check">
          <input type="checkbox" checked={share.listening}
            onChange={(e) => voice.setShareListening(person.id, e.target.checked)} />
          <span>Listen to Share</span>
        </label>
      )}
      {canServerMute && (
        <div className="menu-section">
          <strong className="small">Server Mute</strong>
          {person.serverMuted ? (
            <>
              <p className="muted small">Muted by a moderator in every voice channel.</p>
              <button className="outline" disabled={busy} onClick={() => void serverMute(false)}>
                {busy ? "Unmuting…" : "Unmute"}
              </button>
            </>
          ) : (
            <>
              <label>
                For
                <select value={duration} onChange={(e) => setDuration(e.target.value)} disabled={busy}>
                  {MUTE_DURATIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </label>
              <button className="outline" disabled={busy} onClick={() => void serverMute(true)}>
                {busy ? "Muting…" : "Server Mute"}
              </button>
              <p className="muted small">Takes their microphone away in every voice channel, for everyone.</p>
            </>
          )}
          {muteError && <p className="error small" role="alert">{muteError}</p>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ voice bar

export function VoiceBar({ voice, snap, channelName, onShare, onSettings }: {
  voice: VoiceClient;
  snap: VoiceSnapshot;
  channelName: string;
  onShare: () => void;
  onSettings: () => void;
}) {
  const talkShown = useTalkButtonShown();
  if (snap.state === "idle") {
    return snap.lastEnd ? (
      <div className="voice-bar ended" role="status">
        <span className="small">{snap.lastEnd}</span>
      </div>
    ) : null;
  }
  const connecting = snap.state === "connecting";
  const status = connecting ? "Connecting…"
    : snap.serverMuted ? "Muted by a moderator"
    : snap.mutedTalking ? "You're muted"
    : snap.micMode === "ptt" ? (snap.pttHeld ? "Talking" : `Push-to-talk: hold ${keyLabel(pttKey())}`)
    : snap.micMode === "tap" ? (snap.pttHeld ? "Talking: stops when you do" : `Tap to Talk: press ${keyLabel(pttKey())}`)
    : !snap.micOpen ? "Voice connected (muted)"
    : snap.micMode === "voice" ? "Voice activity" : "Voice connected";
  return (
    <div className="voice-bar" aria-label="Voice controls">
      <div className="voice-status">
        <span className={`dot-status${connecting ? " pending" : ""}${snap.transmitting ? " talking" : ""}`} aria-hidden />
        <div className="voice-text">
          <strong className={`small${snap.mutedTalking ? " warn" : ""}`} role={snap.mutedTalking ? "alert" : undefined}>{status}</strong>
          <span className="muted small" title={snap.epoch !== null ? `End-to-end encrypted (key epoch ${snap.epoch})` : undefined}>
            {channelName}{snap.epoch !== null ? " · encrypted" : ""}
            {snap.forcePTT ? " · push-to-talk required" : ""}
          </span>
        </div>
      </div>
      {snap.audioBlocked && (
        <button className="primary small-btn" onClick={() => void voice.startAudio()}>Click to hear the call</button>
      )}
      {snap.pttMode && talkShown && <TalkButton voice={voice} snap={snap} />}
      <div className="voice-buttons">
        <button className={`vbtn${snap.serverMuted ? " locked" : !snap.pttMode && (snap.muted || snap.deafened) ? " on" : ""}`}
          disabled={connecting || !snap.canPublish || snap.serverMuted || snap.pttMode}
          onClick={() => void voice.setMuted(!snap.muted)}
          title={!snap.canPublish ? "You can't speak here" : snap.serverMuted ? "A moderator has muted you. You can't unmute until they unmute you." : snap.pttMode ? (snap.micMode === "tap" ? "Tap to Talk is on" : "Push-to-talk is on") : snap.muted ? "Unmute" : "Mute"}
          aria-pressed={snap.muted}>
          <MicIcon off={!snap.micOpen} locked={snap.serverMuted} />
        </button>
        <button className={`vbtn${snap.deafened ? " on" : ""}`} disabled={connecting}
          onClick={() => void voice.setDeafened(!snap.deafened)}
          title={snap.deafened ? "Undeafen" : "Deafen"} aria-pressed={snap.deafened}>
          <HeadphonesIcon off={snap.deafened} />
        </button>
        <button className={`vbtn${snap.sharing ? " on" : ""}`} disabled={connecting || !snap.canPublish}
          onClick={() => (snap.sharing ? void voice.stopShare() : onShare())}
          title={!snap.canPublish ? "You can't share here" : snap.sharing ? "Stop sharing" : "Share your screen"}
          aria-pressed={snap.sharing}>
          <ScreenIcon />
        </button>
        <button className="vbtn" onClick={onSettings} title="Voice settings"><CogIcon /></button>
        <button className="vbtn hang" onClick={() => void voice.leave()} title="Leave the call"><HangUpIcon /></button>
      </div>
      {snap.notices.length > 0 && <span className="muted small notice-line">{snap.notices[snap.notices.length - 1]}</span>}
    </div>
  );
}

// ---------------------------------------------------------- share dialog

const SHARE_PREFS = "voice.share";

export function ShareDialog({ voice, onClose }: { voice: VoiceClient; onClose: () => void }) {
  const saved = (() => {
    try {
      return JSON.parse(localStore.get(SHARE_PREFS) ?? "{}") as Partial<ShareSettings & { preset: number }>;
    } catch {
      return {};
    }
  })();
  const [preset, setPreset] = useState(saved.preset ?? 1);
  const [priority, setPriority] = useState<ShareSettings["priority"]>(saved.priority ?? "detail");
  const serverMuted = voice.snapshot().serverMuted;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // undefined while asking the server; null for no limit.
  const [limit, setLimit] = useState<ShareLimit | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    voice.shareLimit()
      .then((l) => {
        if (!live) return;
        setLimit(l);
        // A remembered preset above the limit falls back to the best one allowed.
        setPreset((cur) => {
          if (PRESETS[cur] && presetAllowed(PRESETS[cur], l)) return cur;
          for (let i = PRESETS.length - 1; i >= 0; i--) if (presetAllowed(PRESETS[i], l)) return i;
          return 0;
        });
      })
      .catch(() => live && setLimit(null)); // the server stays the judge either way
    return () => { live = false; };
  }, [voice]);
  const allowed = PRESETS.map((p) => presetAllowed(p, limit ?? null));
  const hidden = allowed.some((ok) => !ok);

  async function start() {
    const p = PRESETS[preset] ?? PRESETS[1];
    // Sound is always asked for: whether a share has it is chosen in the
    // picker (the desktop app's or the browser's), next to what is shared.
    // A server mute still turns it off (VoiceClient.startShare).
    const s: ShareSettings = { width: p.width, height: p.height, fps: p.fps, kbps: p.kbps, priority, audio: true };
    localStore.set(SHARE_PREFS, JSON.stringify({ preset, priority }));
    setBusy(true);
    setError(null);
    try {
      await voice.startShare(s);
      onClose();
    } catch (err) {
      // Cancelling the picker is not an error worth showing: browsers say
      // NotAllowedError, the desktop app's own picker "AbortError: Invalid
      // capture constraints" (Electron, found by experiment). The
      // operating system refusing (Chromium: "Permission denied by
      // system", e.g. macOS Screen Recording off) is worth showing: say why.
      const e = err as { name?: string; message?: string };
      const msg = e.message ?? "";
      if (e.name === "NotAllowedError" && /by system/i.test(msg)) {
        setError("Your computer blocked screen capture. Allow this app or browser to record the screen in your system's privacy settings, then try again.");
      } else if (e.name === "NotAllowedError" || (e.name === "AbortError" && /invalid capture constraints/i.test(msg))) {
        onClose();
      } else setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Share your screen" onClose={onClose}>
      <div className="modal-body">
        <label>
          Quality
          <select value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
            {PRESETS.map((p, i) => allowed[i] && <option key={p.label} value={i}>{p.label}</option>)}
          </select>
          {hidden && <span className="muted small block">Higher qualities are turned off on this server.</span>}
        </label>
        <label>
          Optimise for
          <select value={priority} onChange={(e) => setPriority(e.target.value as ShareSettings["priority"])}>
            <option value="detail">Detail: text and documents stay sharp</option>
            <option value="motion">Motion: games and video stay smooth</option>
          </select>
        </label>
        {serverMuted && <p className="muted small">A moderator has muted you, so your share won't have sound.</p>}
        <p className="muted small">Your browser asks what to share next. Encrypted end to end, like voice.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void start()} disabled={busy || limit === undefined}>{busy ? "Starting…" : "Choose what to share"}</button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------- settings dialog

/** The Voice tab of the Settings dialog (SettingsDialog.tsx). */
export function VoiceSettings({ voice, snap }: {
  voice: VoiceClient;
  snap: VoiceSnapshot | null;
}) {
  const [devices, setDevices] = useState<AudioDevices | null>(null);
  const [input, setInput] = useState(voice.inputDevice);
  const [output, setOutput] = useState(voice.outputDevice);
  const [key, setKey] = useState(pttKey());
  const [binding, setBinding] = useState(false);
  const [pin, setPin] = useState(voice.pinQuality);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    voice.listDevices().then(setDevices).catch((err) => setError(String(err?.message ?? err)));
  }, [voice]);

  useEffect(() => {
    if (!binding) return;
    const grab = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== "Escape") {
        localStore.set(PTT_KEY, e.code);
        setKey(e.code);
      }
      setBinding(false);
    };
    window.addEventListener("keydown", grab, true);
    return () => window.removeEventListener("keydown", grab, true);
  }, [binding]);

  const named = (list: MediaDeviceInfo[], d: MediaDeviceInfo, i: number) =>
    d.label || (d.deviceId === "default" ? "System default" : `Device ${i + 1}`);

  return (
    <>
        <h3 className="settings-head">Devices</h3>
        <label>
          Microphone
          <select value={input} onChange={(e) => {
            setInput(e.target.value);
            voice.setInputDevice(e.target.value).catch((err) => setError(String(err?.message ?? err)));
          }}>
            {!devices?.inputs.some((d) => d.deviceId === "default") && <option value="default">System default</option>}
            {devices?.inputs.map((d, i, l) => <option key={d.deviceId} value={d.deviceId}>{named(l, d, i)}</option>)}
          </select>
        </label>
        <label>
          Speaker
          <select value={output} disabled={devices ? !devices.canPickOutput : true} onChange={(e) => {
            setOutput(e.target.value);
            voice.setOutputDevice(e.target.value).catch((err) => setError(String(err?.message ?? err)));
          }}>
            {!devices?.outputs.some((d) => d.deviceId === "default") && <option value="default">System default</option>}
            {devices?.outputs.map((d, i, l) => <option key={d.deviceId} value={d.deviceId}>{named(l, d, i)}</option>)}
          </select>
        </label>
        {devices && !devices.canPickOutput && <p className="muted small">This browser always uses the system's speaker.</p>}
        {devices && !devices.named && (
          <div className="key-row">
            <span className="muted small">Your browser only shows your devices once this site may use the microphone.</span>
            <button className="outline" onClick={() => {
              voice.listDevices(true).then(setDevices).catch(() =>
                setError("The microphone wasn't allowed. Allow it in your browser's site settings (the icon left of the address), then try again."));
            }}>Show My Devices</button>
          </div>
        )}

        <MicSettings voice={voice} snap={snap} keyName={binding ? "…" : keyLabel(key)}
          bindKey={() => setBinding(true)} binding={binding} />

        <h3 className="settings-head">Screen Share</h3>
        <label className="check">
          <input type="checkbox" checked={pin} onChange={(e) => {
            setPin(e.target.checked);
            voice.setPinQuality(e.target.checked);
          }} />
          <span>
            Always watch screen shares at full quality
            <span className="muted small block">Otherwise quality follows the size of the video on screen. Applies next time you join.</span>
          </span>
        </label>
        <ShareDucking voice={voice} />

        {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// ------------------------------------------------------ mic settings

const MODES: { id: MicMode; label: string; help: string }[] = [
  { id: "voice", label: "Voice Activity", help: "Your mic opens when you talk. Set how loud that has to be below." },
  { id: "ptt", label: "Push-to-Talk", help: "Hold a key to talk." },
  { id: "tap", label: "Tap to Talk (Experimental)",
    help: "Press the key once and talk; the mic closes on its own when you stop. Press again to close it sooner." },
  { id: "open", label: "Open Mic", help: "Always sending while unmuted. Only the browser's noise filter in between." },
];

/** Input mode, sensitivity, volumes, the mic test and the browser's processing: the rest of the Voice tab. */
function MicSettings({ voice, snap, keyName, bindKey, binding }: {
  voice: VoiceClient;
  snap: VoiceSnapshot | null;
  keyName: string;
  bindKey: () => void;
  binding: boolean;
}) {
  const [a, setA] = useState<AudioSettings>(voice.audioSettings);
  const [testError, setTestError] = useState<string | null>(null);
  const [talkPref, setTalkPref] = useState(talkButtonPref);
  const forced = !!snap?.forcePTT && snap.state !== "idle";
  const inCall = !!snap && snap.state !== "idle";
  const mode: MicMode = forced ? "ptt" : a.mode;
  const set = (change: Partial<AudioSettings>) => {
    setA((x) => ({ ...x, ...change }));
    const { mode: m, ...rest } = change;
    if (m) void voice.setMicMode(m);
    if (Object.keys(rest).length) void voice.setAudioSettings(rest);
  };
  useEffect(() => () => void voice.stopMicTest(), [voice]);

  return (
    <>
      <h3 className="settings-head">Input Mode</h3>
      {forced && <p className="muted small">This channel requires push-to-talk.</p>}
      <div className="radio-list" role="radiogroup" aria-label="Input mode">
        {MODES.map((m) => (
          <label key={m.id} className="check">
            <input type="radio" name="mic-mode" checked={mode === m.id} disabled={forced && m.id !== "ptt"}
              onChange={() => set({ mode: m.id })} />
            <span>
              {m.label}
              <span className="muted small block">{m.help}</span>
            </span>
          </label>
        ))}
      </div>

      {(mode === "ptt" || mode === "tap") && (
        <>
          <div className="key-field-row">
            <span className="small">{mode === "tap" ? "Tap to Talk key" : "Push-to-talk key"}</span>
            <button className={`key-field${binding ? " binding" : ""}`} onClick={bindKey}
              title="Click, then press the key you want" aria-label={`${mode === "tap" ? "Tap to Talk" : "Push-to-talk"} key: ${keyName}. Click to change.`}>
              {binding ? "Press a key… (Esc cancels)" : keyName}
            </button>
          </div>
          <label className="inline-select">
            <span className="small">On-screen button</span>
            <select value={talkPref} onChange={(e) => {
              const v = e.target.value as TalkButtonPref;
              setTalkPref(v);
              setTalkButtonPref(v);
            }}>
              <option value="auto">Touch screens only</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </select>
          </label>
          <p className="muted small">
            The button sits in the voice bar, above Mute; {mode === "tap" ? "tap it instead of pressing the key" : "hold it instead of the key"}.
            The key only works while this tab is focused; the desktop app will add a global key. While typing in the message
            box, keys that type a letter don't trigger it: pick a key like Right Ctrl or F13 to talk while typing.
          </p>
        </>
      )}
      {mode === "ptt" && (
        <Slider label="Release delay" value={a.pttReleaseMs} min={0} max={1000} step={50}
          text={`${a.pttReleaseMs} ms`} onChange={(v) => set({ pttReleaseMs: v })}
          help="Keeps the mic open this long after you let go, so your last word isn't cut off." />
      )}
      {mode === "tap" && (
        <Slider label="Close after silence" value={a.tapSilenceMs} min={500} max={5000} step={100}
          text={`${(a.tapSilenceMs / 1000).toFixed(1)} s`} onChange={(v) => set({ tapSilenceMs: v })}
          help="How long you can pause before the mic closes. If you press the key and don't talk, it closes after 3 s." />
      )}

      {(mode === "voice" || mode === "tap") && (
        <>
          <h3 className="settings-head">Sensitivity</h3>
          <label className="check">
            <input type="checkbox" checked={a.vadAuto} onChange={(e) => set({ vadAuto: e.target.checked })} />
            <span>
              Set Automatically
              <span className="muted small block">Follows the noise around you. Untick to set the level yourself.</span>
            </span>
          </label>
          <LevelMeter voice={voice} threshold={a.vadAuto ? null : a.vadThresholdDb}
            onThreshold={a.vadAuto ? undefined : (v) => set({ vadThresholdDb: v })} />
          <p className="muted small">
            {inCall || voice.micTesting
              ? "The bar shows your mic; it turns green when you'd be heard. Talk normally and set the marker just below that."
              : "Join a call or use Let's Check below to see your mic level."}
          </p>
        </>
      )}

      <h3 className="settings-head">Volume</h3>
      <Slider label="Input volume" value={Math.round(a.inputGain * 100)} min={0} max={200} step={5}
        text={`${Math.round(a.inputGain * 100)}%`} onChange={(v) => set({ inputGain: v / 100 })} />
      <Slider label="Output volume" value={Math.round(a.outputVolume * 100)} min={0} max={100} step={5}
        text={`${Math.round(a.outputVolume * 100)}%`} onChange={(v) => set({ outputVolume: v / 100 })}
        help="Everyone in the call, on top of each person's own volume (right-click them in a call)." />

      <h3 className="settings-head">Mic Test</h3>
      <div className="key-row">
        <span className="muted small">
          {inCall ? "You're in a call: the level above shows your mic there." : "Hear yourself as others would."}
        </span>
        <button className="outline" disabled={inCall} onClick={() => {
          setTestError(null);
          (voice.micTesting ? voice.stopMicTest() : voice.startMicTest())
            .then(() => setA({ ...voice.audioSettings }))
            .catch((err) => setTestError(err?.name === "NotAllowedError"
              ? "The microphone wasn't allowed. Allow it in your browser's site settings, then try again."
              : String(err?.message ?? err)));
        }}>{voice.micTesting ? "Stop Checking" : "Let's Check"}</button>
      </div>
      {!inCall && (mode === "voice" || mode === "tap") && voice.micTesting && <LevelMeterHint />}
      {testError && <p className="error small" role="alert">{testError}</p>}

      <h3 className="settings-head">Processing</h3>
      <p className="muted small">The browser's own filters. Turn them off for music, or with a good headset.</p>
      <label className="check">
        <input type="checkbox" checked={a.noiseSuppression} onChange={(e) => set({ noiseSuppression: e.target.checked })} />
        <span>Noise suppression</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={a.echoCancellation} onChange={(e) => set({ echoCancellation: e.target.checked })} />
        <span>
          Echo cancellation
          <span className="muted small block">Stops others hearing themselves through your speakers. Keep it on without headphones.</span>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={a.autoGainControl} onChange={(e) => set({ autoGainControl: e.target.checked })} />
        <span>
          Automatic gain
          <span className="muted small block">Evens out your volume. Off: Input volume alone sets it.</span>
        </span>
      </label>
    </>
  );
}

/** Ducking: share sound goes down while other people talk. */
function ShareDucking({ voice }: { voice: VoiceClient }) {
  const [on, setOn] = useState(voice.audioSettings.duckShare);
  const [level, setLevel] = useState(Math.round(voice.audioSettings.duckLevel * 100));
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => {
          setOn(e.target.checked);
          void voice.setAudioSettings({ duckShare: e.target.checked });
        }} />
        <span>
          Lower screen share sound while others talk
          <span className="muted small block">So a shared video doesn't drown out the people in the call. Your own voice doesn't count.</span>
        </span>
      </label>
      <Slider disabled={!on} label="Share sound while others talk" value={level} min={0} max={90} step={5}
        text={level === 0 ? "Silent" : `${level}%`} onChange={(v) => {
          setLevel(v);
          void voice.setAudioSettings({ duckLevel: v / 100 });
        }}
        help="How loud share sound stays while someone talks. Lower is a stronger effect." />
    </>
  );
}

function LevelMeterHint() {
  return <p className="muted small">Voice activation applies in the test too: you only hear yourself when the bar is green.</p>;
}

function Slider({ label, value, min, max, step, text, help, disabled, onChange }: {
  label: string; value: number; min: number; max: number; step: number; text: string; help?: string;
  disabled?: boolean; onChange: (v: number) => void;
}) {
  return (
    <label className={`slider-row${disabled ? " disabled" : ""}`}>
      <span className="slider-head"><span className="small">{label}</span><span className="muted small">{text}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} />
      {help && <span className="muted small">{help}</span>}
    </label>
  );
}

/** dBFS shown on the meter: -80 at the left, 0 at the right. */
const METER_MIN_DB = -80;
const pct = (db: number) => Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100));

/**
 * The live mic level with the threshold marker. threshold null: automatic
 * (the marker follows what the worklet reports). With onThreshold the
 * marker is a slider.
 */
function LevelMeter({ voice, threshold, onThreshold }: {
  voice: VoiceClient;
  threshold: number | null;
  onThreshold?: (db: number) => void;
}) {
  const [level, setLevel] = useState<MicLevel | null>(null);
  useEffect(() => voice.onMicLevel(setLevel), [voice]);
  const mark = threshold ?? level?.thresholdDb ?? null;
  return (
    <div className="level-meter-wrap">
      <div className={`level-meter${level ? "" : " idle"}`} aria-hidden>
        <div className={`level-fill${level?.voice ? " voice" : ""}`} style={{ width: `${level ? pct(level.db) : 0}%` }} />
        {mark !== null && <div className="level-mark" style={{ left: `${pct(mark)}%` }} />}
      </div>
      <input type="range" className="level-range" min={METER_MIN_DB} max={0} step={1}
        value={threshold ?? Math.round(level?.thresholdDb ?? -50)} disabled={!onThreshold}
        aria-label="Voice activation threshold" title={onThreshold ? `${threshold} dB` : "Set automatically"}
        onChange={(e) => onThreshold?.(Number(e.target.value))} />
    </div>
  );
}

// ----------------------------------------------------------------- stage

/** Screen shares in the main pane: a grid, or one focused. */
/**
 * One click and a double click on the same element: the single click
 * waits 250 ms, so a double click (fullscreen) doesn't also run it.
 */
function useClickOrDouble(single: () => void, double: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    onClick: () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(single, 250);
    },
    onDoubleClick: () => {
      clearTimeout(timer.current);
      double();
    },
  };
}

export function Stage({ voice, screens, focus, setFocus, onBack, backLabel }: {
  voice: VoiceClient;
  screens: readonly ScreenShare[];
  focus: string | null;
  setFocus: (id: string | null) => void;
  onBack: () => void;
  /** "Back to Call" when the call view is underneath, else "Back to Chat". */
  backLabel: string;
}) {
  const [stats, setStats] = useState(false);
  const shown = focus ? screens.filter((s) => s.id === focus) : screens;
  const others = focus ? screens.filter((s) => s.id !== focus) : [];
  // Esc goes back, like a click on a lone share (fullscreen takes Esc first).
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.fullscreenElement) return;
      // An open dialog or menu takes Esc for itself; so does typing.
      if (document.querySelector(".modal-backdrop, .menu")) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select")) return;
      onBack();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onBack]);
  return (
    <section className="stage" aria-label="Screen shares">
      <header className="pane-head">
        <button className="secondary" onClick={onBack}>{backLabel}</button>
        <h1>{screens.length === 1 ? `${screens[0].name}'s screen` : `${screens.length} screens`}</h1>
        {focus && screens.length > 1 && <button className="link small" onClick={() => setFocus(null)}>Show all</button>}
        <label className="check small stats-toggle">
          <input type="checkbox" checked={stats} onChange={(e) => setStats(e.target.checked)} />
          <span>Stats</span>
        </label>
      </header>
      {!screens.length ? (
        <div className="pane-empty muted">Nobody is sharing right now.</div>
      ) : (
        <div className={`tiles${shown.length > 1 ? " grid" : ""}`}>
          {shown.map((s) => (
            <ScreenTile key={s.id} voice={voice} share={s} stats={stats}
              onClick={shown.length > 1 ? () => setFocus(s.id) : onBack} />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="strip">
          {others.map((s) => (
            <button key={s.id} className="secondary" onClick={() => setFocus(s.id)}>{s.name}</button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------- call view

/**
 * The call you are in, as one tile per person (decisions.md, "Voice
 * channel view"). A sharer's tile shows their share from its half-size
 * copy (adaptiveStream picks that layer from the tile's size), with
 * Watch, Listen, Fullscreen and Hide. Letter circles until avatars exist.
 */
export function CallView({ voice, snap, channelName, onWatch }: {
  voice: VoiceClient;
  snap: VoiceSnapshot;
  channelName: string;
  onWatch: (shareId: string) => void;
}) {
  // Hidden shares, by track SID: a new share is a new track, so it shows again.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const setHide = (id: string, on: boolean) => setHidden((cur) => {
    const next = new Set(cur);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  return (
    <section className="call-view" aria-label="Call">
      <header className="pane-head">
        <h1>{channelName}</h1>
      </header>
      {snap.state === "connecting" && !snap.participants.length ? (
        <div className="pane-empty muted">Joining…</div>
      ) : (
        <div className="call-tiles">
          {snap.participants.map((p) => {
            const share = snap.screens.find((x) => x.participantId === p.id) ?? null;
            return (
              <PersonTile key={p.id} voice={voice} person={p} share={share}
                mutedTalking={p.isLocal && snap.mutedTalking}
                hidden={!!share && hidden.has(share.id)}
                onHide={(on) => share && setHide(share.id, on)}
                onWatch={() => share && onWatch(share.id)} />
            );
          })}
        </div>
      )}
    </section>
  );
}

function PersonTile({ voice, person, share, mutedTalking, hidden, onHide, onWatch }: {
  voice: VoiceClient;
  person: VoiceParticipant;
  /** You're talking while muted: say so on your own tile. */
  mutedTalking: boolean;
  share: ScreenShare | null;
  hidden: boolean;
  onHide: (on: boolean) => void;
  onWatch: () => void;
}) {
  const fig = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const showing = share && !hidden ? share : null;

  useEffect(() => {
    const el = video.current;
    if (!el || !showing) return;
    voice.attachScreen(showing.id, el);
    return () => voice.detachScreen(showing.id, el);
  }, [voice, showing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function fullscreen() {
    const f = fig.current;
    if (!f) return;
    if (document.fullscreenElement === f) void document.exitFullscreen();
    else f.requestFullscreen?.().catch(() => {
      (video.current as unknown as { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.();
    });
  }

  // One click opens the big view, a double click goes fullscreen.
  const clicks = useClickOrDouble(onWatch, fullscreen);
  const speaking = person.speaking && !person.micOff;
  return (
    <figure ref={fig} className={`person-tile${speaking ? " speaking" : ""}${showing ? " sharing" : ""}`}>
      {showing
        ? <video ref={video} autoPlay playsInline muted {...clicks} />
        : <span className="avatar" aria-hidden>{person.name.slice(0, 1).toUpperCase()}</span>}
      {mutedTalking && (
        <div className="tile-banner" role="alert">
          <MicIcon off /> You're muted
          <button className="outline" onClick={() => void voice.setMuted(false)}>Unmute</button>
        </div>
      )}
      <figcaption>
        {share && <span className="live">LIVE</span>}
        <span className="who"><ColouredName userId={person.id}>{person.name}</ColouredName>{person.isLocal ? " (you)" : ""}</span>
        {person.serverMuted
          ? <span className="state server-muted" title="Muted by a moderator"><MicIcon locked /></span>
          : person.micOff && <span className="state" title={person.isLocal ? "Your mic is off" : "Mic off"}><MicIcon off /></span>}
        {!person.isLocal && person.localMuted && <span className="state" title="Muted for you"><HeadphonesIcon off /></span>}
      </figcaption>
      {showing && (
        <div className="tile-actions">
          <button className="secondary" onClick={onWatch}>Watch</button>
          {showing.hasAudio && (
            <button className={showing.listening ? "primary" : "secondary"} aria-pressed={showing.listening}
              onClick={() => voice.setShareListening(showing.participantId, !showing.listening)}>
              {showing.listening ? "Stop Listening" : "Listen"}
            </button>
          )}
          <button className="secondary" onClick={fullscreen}>Fullscreen</button>
          {/* Hiding a share means not following it: its sound stops too. */}
          <button className="secondary" onClick={() => {
            if (showing.listening) voice.setShareListening(showing.participantId, false);
            onHide(true);
          }}>Hide</button>
        </div>
      )}
      {share && hidden && (
        <div className="tile-actions always">
          <button className="outline" onClick={() => onHide(false)}>Show Share</button>
        </div>
      )}
    </figure>
  );
}

function ScreenTile({ voice, share, stats, onClick }: {
  voice: VoiceClient;
  share: ScreenShare;
  stats: boolean;
  onClick: () => void;
}) {
  const fig = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [line, setLine] = useState<ReactNode>("measuring…");

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    voice.attachScreen(share.id, el);
    return () => voice.detachScreen(share.id, el);
  }, [voice, share.id]);

  useEffect(() => {
    if (!stats) return;
    const t = setInterval(async () => {
      const s = await voice.screenStats(share.id, video.current ?? undefined);
      setLine(`${s.width}×${s.height} · ${s.fps ?? "?"} fps · ${s.kbps ?? "?"} kbps` +
        (s.dropped ? ` · ${s.dropped} dropped` : "") + (share.isLocal ? " (sending)" : ""));
    }, 1000);
    return () => clearInterval(t);
  }, [stats, voice, share.id, share.isLocal]);

  function fullscreen() {
    const f = fig.current;
    if (!f) return;
    if (document.fullscreenElement === f) void document.exitFullscreen();
    else f.requestFullscreen?.().catch(() => {
      // iOS Safari only allows fullscreen on the video itself.
      (video.current as unknown as { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.();
    });
  }

  const clicks = useClickOrDouble(onClick, fullscreen);
  return (
    <figure ref={fig} className="tile">
      <video ref={video} autoPlay playsInline muted {...clicks} />
      <figcaption>
        <span>{share.name}{share.isLocal ? " (you)" : ""}</span>
        {stats && <span className="muted small">{line}</span>}
        {/* A share's sound is off until asked for, and stays on after
            going back to chat (stop it here or in the person's menu). */}
        {share.hasAudio && (
          <button className={share.listening ? "primary" : "secondary"} aria-pressed={share.listening}
            onClick={() => voice.setShareListening(share.participantId, !share.listening)}>
            {share.listening ? "Stop Listening" : "Listen"}
          </button>
        )}
        <button className="secondary" onClick={fullscreen}>Fullscreen</button>
      </figcaption>
    </figure>
  );
}
