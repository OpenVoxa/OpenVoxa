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
  AudioDevices, ScreenShare, ShareSettings, VoiceClient, VoiceParticipant, VoiceSnapshot,
} from "@core/voice";
import { Modal } from "./ChannelDialogs";
import { localStore } from "./core";
import { setToggle, useToggle, VOICE_TONES } from "./settings";
import { ColouredName } from "./names";

// The presets are duplicated from client-core's SHARE_PRESETS so this
// file needs no runtime import of the (lazy) voice module.
const PRESETS = [
  { label: "720p 30fps", width: 1280, height: 720, fps: 30, kbps: 2500 },
  { label: "1080p 30fps", width: 1920, height: 1080, fps: 30, kbps: 4000 },
  { label: "1080p 60fps", width: 1920, height: 1080, fps: 60, kbps: 8000 },
  { label: "1440p 60fps", width: 2560, height: 1440, fps: 60, kbps: 14000 },
  { label: "4K 30fps", width: 3840, height: 2160, fps: 30, kbps: 20000 },
];

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
    Backquote: "`", Space: "Space", ControlRight: "Right Ctrl", ControlLeft: "Left Ctrl",
    ShiftRight: "Right Shift", ShiftLeft: "Left Shift", AltRight: "Right Alt", AltLeft: "Left Alt",
    CapsLock: "Caps Lock", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
  };
  if (named[code]) return named[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
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

export function MicIcon({ off }: { off?: boolean }) {
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
            {p.micOff && <span className="state" title={p.isLocal ? "Your mic is off" : "Mic off"}><MicIcon off /></span>}
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

/** Volume and "mute for me" for one person, at the click position. */
export function PersonMenu({ voice, person, at, onClose }: {
  voice: VoiceClient;
  person: VoiceParticipant;
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [vol, setVol] = useState(Math.round(person.volume * 100));
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
  const left = Math.min(at.x, window.innerWidth - 240);
  const top = Math.min(at.y, window.innerHeight - 140);
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
  if (snap.state === "idle") {
    return snap.lastEnd ? (
      <div className="voice-bar ended" role="status">
        <span className="small">{snap.lastEnd}</span>
      </div>
    ) : null;
  }
  const connecting = snap.state === "connecting";
  const status = connecting ? "Connecting…"
    : snap.pttMode ? (snap.pttHeld ? "Talking" : `Push-to-talk: hold ${keyLabel(pttKey())}`)
    : snap.micOpen ? "Voice connected" : "Voice connected (muted)";
  return (
    <div className="voice-bar" aria-label="Voice controls">
      <div className="voice-status">
        <span className={`dot-status${connecting ? " pending" : ""}${snap.micOpen ? " talking" : ""}`} aria-hidden />
        <div className="voice-text">
          <strong className="small">{status}</strong>
          <span className="muted small" title={snap.epoch !== null ? `End-to-end encrypted (key epoch ${snap.epoch})` : undefined}>
            {channelName}{snap.epoch !== null ? " · encrypted" : ""}
            {snap.forcePTT ? " · push-to-talk required" : ""}
          </span>
        </div>
      </div>
      {snap.audioBlocked && (
        <button className="primary small-btn" onClick={() => void voice.startAudio()}>Click to hear the call</button>
      )}
      <div className="voice-buttons">
        <button className={`vbtn${!snap.pttMode && (snap.muted || snap.deafened) ? " on" : ""}`}
          disabled={connecting || !snap.canPublish || snap.pttMode}
          onClick={() => void voice.setMuted(!snap.muted)}
          title={!snap.canPublish ? "You can't speak here" : snap.pttMode ? "Push-to-talk is on" : snap.muted ? "Unmute" : "Mute"}
          aria-pressed={snap.muted}>
          <MicIcon off={!snap.micOpen} />
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
  const [audio, setAudio] = useState(saved.audio ?? true);
  const [codec, setCodec] = useState<ShareSettings["codec"]>(saved.codec ?? "h264");
  const [simulcast, setSimulcast] = useState(saved.simulcast ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    const p = PRESETS[preset] ?? PRESETS[1];
    const s: ShareSettings = { width: p.width, height: p.height, fps: p.fps, kbps: p.kbps, priority, audio, codec, simulcast };
    localStore.set(SHARE_PREFS, JSON.stringify({ preset, priority, audio, codec, simulcast }));
    setBusy(true);
    setError(null);
    try {
      await voice.startShare(s);
      onClose();
    } catch (err) {
      // Cancelling the browser's picker is not an error worth showing.
      if ((err as { name?: string }).name === "NotAllowedError") onClose();
      else setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Share your screen" onClose={onClose}>
      <div className="modal-body">
        <label>
          Quality
          <select value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
            {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
          </select>
        </label>
        <label>
          Optimise for
          <select value={priority} onChange={(e) => setPriority(e.target.value as ShareSettings["priority"])}>
            <option value="detail">Detail: text and documents stay sharp</option>
            <option value="motion">Motion: games and video stay smooth</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          <span>Share audio too <span className="muted small block">When the browser offers it (tab audio in most browsers).</span></span>
        </label>
        <details>
          <summary className="small">Advanced</summary>
          <div className="advanced">
            <label>
              Codec
              <select value={codec} onChange={(e) => setCodec(e.target.value as ShareSettings["codec"])}>
                <option value="h264">H.264 (hardware-decoded almost everywhere)</option>
                <option value="vp8">VP8</option>
                <option value="vp9">VP9</option>
                <option value="av1">AV1</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={simulcast} onChange={(e) => setSimulcast(e.target.checked)} />
              <span>Simulcast <span className="muted small block">Also send a lower layer so weaker devices don't stutter.</span></span>
            </label>
          </div>
        </details>
        <p className="muted small">Your browser asks what to share next. Encrypted end to end, like voice.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void start()} disabled={busy}>{busy ? "Starting…" : "Choose what to share"}</button>
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
  const [ptt, setPtt] = useState(snap?.pttMode ?? localStore.get("voice.ptt") === "1");
  const [key, setKey] = useState(pttKey());
  const [binding, setBinding] = useState(false);
  const [pin, setPin] = useState(voice.pinQuality);
  const [error, setError] = useState<string | null>(null);
  const tones = useToggle(VOICE_TONES);

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
        {devices && devices.inputs.every((d) => !d.label) && (
          <p className="muted small">Device names appear once you've allowed the microphone (join a call once).</p>
        )}

        <label className="check">
          <input type="checkbox" checked={ptt || !!snap?.forcePTT} disabled={!!snap?.forcePTT} onChange={(e) => {
            setPtt(e.target.checked);
            void voice.setPTTMode(e.target.checked);
          }} />
          <span>
            Push-to-talk
            <span className="muted small block">
              {snap?.forcePTT ? "This channel requires it. " : ""}
              Only works while this tab is focused; the desktop app will add a global key.
            </span>
          </span>
        </label>
        <div className="key-row">
          <span className="small">Push-to-talk key</span>
          <button className={`secondary${binding ? " binding" : ""}`} onClick={() => setBinding(true)}>
            {binding ? "Press a key… (Esc cancels)" : keyLabel(key)}
          </button>
        </div>
        <p className="muted small">
          While typing in the message box, keys that type a letter don't trigger it; pick a key like Right Ctrl or F13
          to talk while typing.
        </p>

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
        <label className="check">
          <input type="checkbox" checked={tones} onChange={(e) => setToggle(VOICE_TONES, e.target.checked)} />
          <span>
            Join and leave sounds
            <span className="muted small block">A short tone when you or someone else joins or leaves your call.</span>
          </span>
        </label>

        {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

// ----------------------------------------------------------------- stage

/** Screen shares in the main pane: a grid, or one focused. */
export function Stage({ voice, screens, focus, setFocus, onBack }: {
  voice: VoiceClient;
  screens: readonly ScreenShare[];
  focus: string | null;
  setFocus: (id: string | null) => void;
  onBack: () => void;
}) {
  const [stats, setStats] = useState(false);
  const shown = focus ? screens.filter((s) => s.id === focus) : screens;
  const others = focus ? screens.filter((s) => s.id !== focus) : [];
  return (
    <section className="stage" aria-label="Screen shares">
      <header className="pane-head">
        <button className="secondary" onClick={onBack}>Back to chat</button>
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
              onClick={() => setFocus(focus === s.id ? null : s.id)} />
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

  return (
    <figure ref={fig} className="tile">
      <video ref={video} autoPlay playsInline muted onClick={onClick} onDoubleClick={fullscreen} />
      <figcaption>
        <span>{share.name}{share.isLocal ? " (you)" : ""}</span>
        {stats && <span className="muted small">{line}</span>}
        <button className="secondary" onClick={fullscreen}>Fullscreen</button>
      </figcaption>
    </figure>
  );
}
