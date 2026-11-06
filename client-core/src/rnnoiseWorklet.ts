// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AudioWorklet for Strong noise suppression (decisions.md Feature
 * decisions, "Voice activation and audio settings"): RNNoise 0.2, from
 * @jitsi/rnnoise-wasm (pinned; the "sync" build has the WebAssembly
 * inlined, the only way to load it on the audio thread, which has no
 * fetch). Loaded only when someone picks Strong: the file is ~1.9 MB.
 *
 * It sits in front of micWorklet.ts and mirrors its two inputs: input 0
 * (what gets sent) comes out on output 0, input 1 (only measured) on
 * output 1, each with its own RNNoise state, so voice activation judges
 * the cleaned sound too and a keyboard clack doesn't open the gate.
 *
 * RNNoise takes 10 ms frames (480 samples at 48 kHz); the audio thread
 * hands over 128 at a time. Output runs a fixed DELAY samples behind the
 * input: the smallest delay at which every 128-sample block can be filled
 * from finished frames (the largest leftover of 128k mod 480 is 448),
 * 9 ms. RNNoise adds a frame of its own (its windows overlap): about
 * 19 ms in all, measured 2026-11-06 (906 samples).
 *
 * RNNoise only works at 48 kHz. At any other rate (micChain asks for a
 * 48 kHz context; Firefox may refuse it) this passes sound through
 * untouched and says so, and the client goes back to the browser's filter.
 */

import "./rnnoiseShim.js"; // first: see there
import createRNNWasmModuleSync from "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js";

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

const FRAME = 480;
const BLOCK = 128;
const DELAY = 448;
/** Ring of cleaned samples: a whole number of frames, more than DELAY + BLOCK. */
const RING = FRAME * 4;
/** RNNoise works on 16-bit sample values, Web Audio on -1..1. */
const SCALE = 32768;

interface Wasm {
  HEAPF32: Float32Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _rnnoise_create(model: number): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, out: number, input: number): number;
}

/** One RNNoise state and its buffers, for one input. */
class Lane {
  readonly #w: Wasm;
  readonly #state: number;
  readonly #inPtr: number;
  readonly #outPtr: number;
  readonly #frame = new Float32Array(FRAME);
  #fill = 0;
  readonly #ring = new Float32Array(RING);
  #done = 0; // cleaned samples written to the ring, in total
  #taken = 0; // input samples taken, in total

  constructor(w: Wasm) {
    this.#w = w;
    this.#state = w._rnnoise_create(0);
    this.#inPtr = w._malloc(FRAME * 4);
    this.#outPtr = w._malloc(FRAME * 4);
  }

  /** One block in, one block out (DELAY samples later). A missing input counts as silence. */
  run(input: Float32Array | undefined, output: Float32Array): void {
    for (let i = 0; i < BLOCK; i++) {
      this.#frame[this.#fill++] = (input ? input[i]! : 0) * SCALE;
      if (this.#fill === FRAME) {
        this.#fill = 0;
        const heap = this.#w.HEAPF32; // re-read: a grown heap is a new buffer
        heap.set(this.#frame, this.#inPtr >> 2);
        this.#w._rnnoise_process_frame(this.#state, this.#outPtr, this.#inPtr);
        const out = this.#w.HEAPF32.subarray(this.#outPtr >> 2, (this.#outPtr >> 2) + FRAME);
        this.#ring.set(out, this.#done % RING); // RING is a multiple of FRAME: never wraps mid-frame
        this.#done += FRAME;
      }
    }
    const start = this.#taken - DELAY;
    this.#taken += BLOCK;
    for (let i = 0; i < BLOCK; i++) {
      const s = start + i;
      output[i] = s < 0 ? 0 : this.#ring[s % RING]! / SCALE;
    }
  }

  destroy(): void {
    this.#w._rnnoise_destroy(this.#state);
    this.#w._free(this.#inPtr);
    this.#w._free(this.#outPtr);
  }
}

class Rnnoise extends AudioWorkletProcessor {
  #lanes: Lane[] = [];
  #alive = true;

  constructor() {
    super();
    if (sampleRate !== 48000) {
      this.port.postMessage({ type: "unsupported", sampleRate });
    } else {
      try {
        const w = createRNNWasmModuleSync() as Wasm;
        this.#lanes = [new Lane(w), new Lane(w)];
        this.port.postMessage({ type: "ready" });
      } catch (err) {
        this.port.postMessage({ type: "error", message: String((err as Error)?.message ?? err) });
      }
    }
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === "destroy") {
        for (const l of this.#lanes) l.destroy();
        this.#lanes = [];
        this.#alive = false;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.#alive) return false;
    for (let k = 0; k < 2; k++) {
      const out = outputs[k]?.[0];
      if (!out) continue;
      const input = inputs[k]?.[0];
      const lane = this.#lanes[k];
      if (lane && out.length === BLOCK) lane.run(input, out);
      else if (input) out.set(input); // unsupported: pass through
    }
    return true;
  }
}

registerProcessor("openvoxa-rnnoise", Rnnoise);
