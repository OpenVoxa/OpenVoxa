// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AudioWorklet for the microphone (micChain.ts; decisions.md Feature
 * decisions, "Voice activation and audio settings"). It runs on the audio
 * thread, so background tabs, whose timers browsers slow to once a
 * second, still open and close the mic on time.
 *
 * Two inputs, one mono output:
 *  - input 0 is what gets sent: the microphone as LiveKit holds it, which
 *    goes silent when LiveKit mutes (so a mute can never leak through
 *    here);
 *  - input 1 is a copy of the microphone that is never sent, only
 *    measured, so the level meter and the "you're muted" warning work
 *    while muted.
 *
 * Modes:
 *  - "open": everything passes (open mic, and push-to-talk, where
 *    LiveKit's mute does the gating);
 *  - "gate": voice activation. Passes while the level is over the
 *    threshold and for RELEASE_MS after; the sent audio runs PREROLL_MS
 *    behind the measurement so the first syllable gets through;
 *  - "tap": Tap to Talk. A key press opens, another closes; while open,
 *    it closes on its own after tapSilenceMs without voice (NO_VOICE_MS
 *    when nobody spoke at all). The main thread mutes and unmutes LiveKit
 *    when told; this node passes everything.
 *
 * The threshold is manual (dBFS) or automatic: a noise floor that follows
 * quiet stretches, plus a margin.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

const RELEASE_MS = 300;
const PREROLL_MS = 40;
const NO_VOICE_MS = 3000;
/** How often the level goes to the main thread. */
const REPORT_MS = 33;
/** Automatic threshold: this far over the noise floor, within these bounds. */
const AUTO_MARGIN_DB = 15;
const AUTO_MIN_DB = -65;
const AUTO_MAX_DB = -30;
const FLOOR_RISE_DB_PER_S = 1.5;
const SILENT_DB = -100;

type Mode = "open" | "gate" | "tap";

interface Config {
  mode?: Mode;
  gain?: number;
  thresholdDb?: number;
  auto?: boolean;
  tapSilenceMs?: number;
}

class Mic extends AudioWorkletProcessor {
  #mode: Mode = "gate";
  #gain = 1;
  #thresholdDb = -50;
  #auto = true;
  #tapSilenceMs = 1500;

  #env = SILENT_DB; // smoothed level, dBFS
  #floor = -70;
  #gateOpen = false;
  #holdLeft = 0; // samples the gate stays open after the voice stops
  #outGain = 0; // ramped towards 0 or the gain, to avoid clicks

  #delay = new Float32Array(Math.ceil(sampleRate * PREROLL_MS / 1000));
  #delayAt = 0;

  #tapOpen = false;
  #tapHeld = false;
  #tapVoice = false;
  #tapQuiet = 0; // ms

  #sinceReport = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Config | { tap: "down" | "up" | "close" }>) => {
      const m = e.data;
      if ("tap" in m) this.#onTap(m.tap);
      else this.#configure(m);
    };
  }

  #configure(c: Config): void {
    if (c.mode && c.mode !== this.#mode) {
      this.#mode = c.mode;
      this.#delay.fill(0);
      if (c.mode !== "tap") this.#setTap(false);
    }
    if (typeof c.gain === "number") this.#gain = Math.max(0, Math.min(4, c.gain));
    if (typeof c.thresholdDb === "number") this.#thresholdDb = c.thresholdDb;
    if (typeof c.auto === "boolean") this.#auto = c.auto;
    if (typeof c.tapSilenceMs === "number") this.#tapSilenceMs = c.tapSilenceMs;
  }

  #onTap(t: "down" | "up" | "close"): void {
    if (t === "close") {
      this.#tapHeld = false;
      this.#setTap(false);
    } else if (t === "down") {
      this.#tapHeld = true;
      if (this.#tapOpen) this.#setTap(false);
      else {
        this.#tapVoice = false;
        this.#tapQuiet = 0;
        this.#setTap(true);
      }
    } else {
      this.#tapHeld = false;
      this.#tapQuiet = 0;
    }
  }

  #setTap(open: boolean): void {
    if (open === this.#tapOpen) return;
    this.#tapOpen = open;
    this.port.postMessage({ type: "tap", open });
  }

  threshold(): number {
    if (!this.#auto) return this.#thresholdDb;
    return Math.min(AUTO_MAX_DB, Math.max(AUTO_MIN_DB, this.#floor + AUTO_MARGIN_DB));
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const send = inputs[0]?.[0];
    const measure = inputs[1]?.[0] ?? send;
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;
    const blockMs = (n / sampleRate) * 1000;

    // Level of this block, after the input volume.
    let sum = 0;
    if (measure) for (let i = 0; i < n; i++) sum += measure[i]! * measure[i]!;
    const rms = Math.sqrt(sum / n) * this.#gain;
    const db = rms > 0 ? Math.max(SILENT_DB, 20 * Math.log10(rms)) : SILENT_DB;
    // Rise at once, fall over about 100 ms.
    this.#env = db > this.#env ? db : this.#env + (db - this.#env) * (blockMs / 100);

    const threshold = this.threshold();
    const voice = this.#env > threshold;
    // The floor follows quiet stretches only, so talking doesn't raise it.
    if (db < this.#floor) this.#floor += (db - this.#floor) * Math.min(1, blockMs / 50);
    else if (!voice) this.#floor += FLOOR_RISE_DB_PER_S * blockMs / 1000;
    this.#floor = Math.max(SILENT_DB, Math.min(0, this.#floor));

    // Gate.
    if (voice) {
      this.#gateOpen = true;
      this.#holdLeft = (RELEASE_MS / 1000) * sampleRate;
    } else if (this.#gateOpen) {
      this.#holdLeft -= n;
      if (this.#holdLeft <= 0) this.#gateOpen = false;
    }

    // Tap to Talk: close after a quiet stretch once the key is up.
    if (this.#mode === "tap" && this.#tapOpen) {
      if (voice) {
        this.#tapVoice = true;
        this.#tapQuiet = 0;
      } else if (!this.#tapHeld) {
        this.#tapQuiet += blockMs;
        if (this.#tapQuiet >= (this.#tapVoice ? this.#tapSilenceMs : NO_VOICE_MS)) this.#setTap(false);
      }
    }

    // Output.
    const target = this.#mode !== "gate" || this.#gateOpen ? this.#gain : 0;
    const step = 1 / (sampleRate * 0.01); // a full ramp takes 10 ms (per unit of gain)
    const d = this.#delay;
    for (let i = 0; i < n; i++) {
      let x = send ? send[i]! : 0;
      if (this.#mode === "gate") {
        const y = d[this.#delayAt]!;
        d[this.#delayAt] = x;
        this.#delayAt = (this.#delayAt + 1) % d.length;
        x = y;
      }
      if (this.#outGain < target) this.#outGain = Math.min(target, this.#outGain + step);
      else if (this.#outGain > target) this.#outGain = Math.max(target, this.#outGain - step);
      const v = x * this.#outGain;
      out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }

    this.#sinceReport += blockMs;
    if (this.#sinceReport >= REPORT_MS) {
      this.#sinceReport = 0;
      this.port.postMessage({ type: "level", db: this.#env, thresholdDb: threshold, voice, gateOpen: target > 0 });
    }
    return true;
  }
}

registerProcessor("openvoxa-mic", Mic);
