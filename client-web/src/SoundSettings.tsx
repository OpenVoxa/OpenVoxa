// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Sounds tab of the Settings dialog: for each event, on/off, which
 * sound (Kenney pack, Classic tone, or the user's own file), play, choose
 * file, reset and volume. See sounds.ts.
 */

import { useRef, useState } from "react";
import {
  isDefault, KENNEY, kenneyLabel, playSound, resetSound, setCustomFile, setSoundChoice, setSoundOn,
  setSoundVolume, SOUND_EVENTS, useSound, type SoundInfo,
} from "./sounds";

/** Kenney's sounds grouped by the word in their names: "glass" -> [glass_001, ...]. */
const GROUPS: [string, string[]][] = (() => {
  const m = new Map<string, string[]>();
  for (const n of KENNEY) {
    const word = n.split("_")[0];
    m.set(word, [...(m.get(word) ?? []), n]);
  }
  return [...m];
})();

export function SoundSettings() {
  return (
    <>
      <p className="muted small">
        Saved in this browser only. Your own files stay on this device: MP3, OGG or WAV, up to 1 MB and 5 seconds.
      </p>
      {SOUND_EVENTS.map((s) => <SoundRow key={s.id} s={s} />)}
      <p className="muted small">
        Built-in sounds: <a href="https://kenney.nl/assets/interface-sounds" target="_blank" rel="noreferrer">
        Interface Sounds</a> by Kenney (CC0).
      </p>
    </>
  );
}

function SoundRow({ s }: { s: SoundInfo }) {
  const set = useSound(s.id);
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const off = !set.on;

  async function choose(f: File | undefined) {
    setError(null);
    if (!f) return;
    try {
      await setCustomFile(s.id, f);
      void playSound(s.id, { choice: "custom" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const option = (value: string, label: string) => (
    <option key={value} value={value}>{label}{value === s.fallback ? " (default)" : ""}</option>
  );

  return (
    <div className="sound-row">
      <label className="check">
        <input type="checkbox" checked={set.on} onChange={(e) => setSoundOn(s.id, e.target.checked)} />
        <span>
          {s.label}
          <span className="muted small block">
            {s.help}{s.pending ? " Not played yet: coming in the next update." : ""}
          </span>
        </span>
      </label>
      <div className="sound-controls">
        <select value={set.choice} disabled={off} aria-label={`${s.label} sound`}
          onChange={(e) => {
            setError(null);
            setSoundChoice(s.id, e.target.value);
            void playSound(s.id, { choice: e.target.value });
          }}>
          <optgroup label="Other">
            {option("classic", "Classic tone")}
            {set.customName && <option value="custom">Your file: {set.customName}</option>}
          </optgroup>
          {GROUPS.map(([word, names]) => (
            <optgroup key={word} label={kenneyLabel(`${word}_1`).replace(/ 1$/, "")}>
              {names.map((n) => option(`kenney/${n}`, kenneyLabel(n)))}
            </optgroup>
          ))}
        </select>
        <button className="secondary" disabled={off} onClick={() => void playSound(s.id, { choice: set.choice })}>
          Play
        </button>
        <button className="secondary" disabled={off} onClick={() => file.current?.click()}>Choose file…</button>
        <button className="secondary" disabled={isDefault(s.id)} onClick={() => { setError(null); void resetSound(s.id); }}>
          Reset
        </button>
        <input ref={file} type="file" hidden accept=".mp3,.ogg,.wav,audio/mpeg,audio/ogg,audio/wav"
          onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      <div className="sound-volume">
        <span className="small">Volume</span>
        <input type="range" min={0} max={100} step={5} value={set.volume} disabled={off}
          aria-label={`${s.label} volume`}
          onChange={(e) => setSoundVolume(s.id, Number(e.target.value))}
          onPointerUp={() => void playSound(s.id, { choice: set.choice })}
          onKeyUp={() => void playSound(s.id, { choice: set.choice })} />
        <span className="small sound-pct">{set.volume}%</span>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}
