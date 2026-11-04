// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AudioWorklet that plays the desktop app's window share sound (see
 * desktopShareSound.ts) into the share's audio track. Samples arrive as
 * interleaved stereo Float32Arrays from the helper's clock, which drifts
 * from the AudioContext's: a short buffer absorbs the jitter, an underrun
 * plays silence until 40 ms are buffered again, and anything over 200 ms
 * behind is dropped back to 60 ms, so the sound stays close to the
 * picture.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const RATE = 48_000;
const CAP = RATE * 2; // frames held at most (2 s)
const START = RATE * 0.04;
const MAX = RATE * 0.2;
const KEEP = RATE * 0.06;

class ShareSound extends AudioWorkletProcessor {
  #buf = new Float32Array(CAP * 2); // interleaved ring
  #read = 0; // frame index
  #count = 0; // frames held
  #playing = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Float32Array>) => this.#push(e.data);
  }

  #push(samples: Float32Array) {
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      if (this.#count === CAP) { // full: drop the oldest
        this.#read = (this.#read + 1) % CAP;
        this.#count--;
      }
      const w = ((this.#read + this.#count) % CAP) * 2;
      this.#buf[w] = samples[i * 2];
      this.#buf[w + 1] = samples[i * 2 + 1];
      this.#count++;
    }
    if (this.#count > MAX) {
      this.#read = (this.#read + this.#count - KEEP) % CAP;
      this.#count = KEEP;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0];
    const n = left.length;
    if (!this.#playing && this.#count >= START) this.#playing = true;
    if (!this.#playing || this.#count < n) {
      this.#playing = false; // underrun: silence until buffered again
      left.fill(0);
      right?.fill(0);
      return true;
    }
    for (let i = 0; i < n; i++) {
      const r = ((this.#read + i) % CAP) * 2;
      left[i] = this.#buf[r];
      if (right) right[i] = this.#buf[r + 1];
    }
    this.#read = (this.#read + n) % CAP;
    this.#count -= n;
    return true;
  }
}

registerProcessor("openvoxa-share-sound", ShareSound);
