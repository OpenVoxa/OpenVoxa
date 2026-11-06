// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The microphone's path through micWorklet.ts: input volume, voice
 * activation and Tap to Talk. Used in a call, as a LiveKit track
 * processor (LiveKit sends `output` instead of the raw microphone), and
 * by the mic test, which plays `output` back to the user.
 *
 * The worklet gets the microphone twice: the track itself (silent when
 * LiveKit mutes it, and the only thing sent) and a clone that is only
 * measured, so the level meter works while muted.
 *
 * Strong noise suppression (rnnoiseWorklet.ts) goes in front of it, both
 * paths, when switched on; it can come and go without a new capture.
 */

import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

export interface MicLevel {
  /** Smoothed level after the input volume, dBFS (-100 is silence). */
  db: number;
  /** The threshold in use: the manual one, or the automatic one. */
  thresholdDb: number;
  /** Over the threshold right now. */
  voice: boolean;
  /** The voice activation gate lets sound through. */
  gateOpen: boolean;
}

export interface MicConfig {
  mode?: "open" | "gate" | "tap";
  gain?: number;
  thresholdDb?: number;
  auto?: boolean;
  tapSilenceMs?: number;
}

/** What happened when Strong noise suppression was switched on. */
export type StrongNoiseResult = "on" | "unsupported" | "error";

const loaded = new WeakMap<AudioContext, Map<string, Promise<void>>>();

function loadModule(ctx: AudioContext, url: string): Promise<void> {
  let m = loaded.get(ctx);
  if (!m) loaded.set(ctx, (m = new Map()));
  let p = m.get(url);
  if (!p) {
    p = ctx.audioWorklet.addModule(url);
    m.set(url, p);
    p.catch(() => m!.delete(url)); // a failed download can be tried again
  }
  return p;
}

export class MicChain {
  readonly ctx: AudioContext;
  readonly #node: AudioWorkletNode;
  readonly #dest: MediaStreamAudioDestinationNode;
  #sources: MediaStreamAudioSourceNode[] = [];
  #rn: AudioWorkletNode | null = null;
  #rnWanted = false;
  #clone: MediaStreamTrack | null = null;
  #onLevel: ((l: MicLevel) => void) | null = null;
  #onTap: ((open: boolean) => void) | null = null;

  private constructor(ctx: AudioContext, node: AudioWorkletNode) {
    this.ctx = ctx;
    this.#node = node;
    this.#dest = ctx.createMediaStreamDestination();
    node.connect(this.#dest);
    node.port.onmessage = (e: MessageEvent<{ type: string } & MicLevel & { open: boolean }>) => {
      if (e.data.type === "level") this.#onLevel?.(e.data);
      else if (e.data.type === "tap") this.#onTap?.(e.data.open);
    };
  }

  static async create(ctx: AudioContext, workletUrl: string, config: MicConfig): Promise<MicChain> {
    await loadModule(ctx, workletUrl);
    const node = new AudioWorkletNode(ctx, "openvoxa-mic", {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    const chain = new MicChain(ctx, node);
    chain.configure(config);
    return chain;
  }

  /** What to send or play: the processed microphone. */
  get output(): MediaStreamTrack {
    return this.#dest.stream.getAudioTracks()[0]!;
  }

  /** Feeds a microphone track in, replacing any before it. */
  connect(track: MediaStreamTrack): void {
    this.disconnect();
    const clone = track.clone();
    clone.enabled = true; // measured even while the original is muted
    this.#clone = clone;
    const send = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const measure = this.ctx.createMediaStreamSource(new MediaStream([clone]));
    this.#sources = [send, measure];
    this.#wire();
    void this.ctx.resume().catch(() => {});
  }

  /** Sources straight into the mic worklet, or through RNNoise first. */
  #wire(): void {
    const [send, measure] = this.#sources;
    if (!send || !measure) return;
    send.disconnect();
    measure.disconnect();
    this.#rn?.disconnect();
    if (this.#rn) {
      send.connect(this.#rn, 0, 0);
      measure.connect(this.#rn, 0, 1);
      this.#rn.connect(this.#node, 0, 0);
      this.#rn.connect(this.#node, 1, 1);
    } else {
      send.connect(this.#node, 0, 0);
      measure.connect(this.#node, 0, 1);
    }
  }

  /**
   * Switches Strong noise suppression (RNNoise) on or off. The first time
   * on, it downloads rnnoiseWorklet (url). "unsupported": the audio
   * doesn't run at 48 kHz here; "error": it wouldn't load. Either way the
   * sound goes on unfiltered.
   */
  async setStrongNoise(on: boolean, url?: string): Promise<StrongNoiseResult | null> {
    this.#rnWanted = on;
    if (!on || !url) {
      this.#dropRn();
      return on ? "error" : null;
    }
    if (this.#rn) return "on";
    if (this.ctx.sampleRate !== 48000) return "unsupported";
    try {
      await loadModule(this.ctx, url);
    } catch {
      return "error";
    }
    if (!this.#rnWanted || this.#rn) return this.#rn ? "on" : null; // switched off, or on twice, meanwhile
    let node: AudioWorkletNode;
    try {
      node = new AudioWorkletNode(this.ctx, "openvoxa-rnnoise", {
        numberOfInputs: 2,
        numberOfOutputs: 2,
        outputChannelCount: [1, 1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
    } catch {
      return "error";
    }
    // The worklet says "ready" once RNNoise is up; a crash or silence is an error.
    const result = await new Promise<StrongNoiseResult>((resolve) => {
      const timer = setTimeout(() => resolve("error"), 10_000);
      node.onprocessorerror = () => resolve("error");
      node.port.onmessage = (e: MessageEvent<{ type: string }>) => {
        clearTimeout(timer);
        resolve(e.data.type === "ready" ? "on" : e.data.type === "unsupported" ? "unsupported" : "error");
      };
    });
    node.port.onmessage = null;
    if (result !== "on" || !this.#rnWanted || this.#rn) {
      node.port.postMessage("destroy");
      return result === "on" ? (this.#rn ? "on" : null) : result;
    }
    this.#rn = node;
    this.#wire();
    return "on";
  }

  #dropRn(): void {
    const rn = this.#rn;
    if (!rn) return;
    this.#rn = null;
    this.#wire();
    rn.disconnect();
    rn.port.postMessage("destroy");
  }

  disconnect(): void {
    for (const s of this.#sources) s.disconnect();
    this.#sources = [];
    this.#clone?.stop();
    this.#clone = null;
  }

  configure(c: MicConfig): void {
    this.#node.port.postMessage(c);
  }

  /** Tap to Talk: the key went down or up, or close now. */
  tap(t: "down" | "up" | "close"): void {
    this.#node.port.postMessage({ tap: t });
  }

  onLevel(cb: ((l: MicLevel) => void) | null): void {
    this.#onLevel = cb;
  }

  onTap(cb: ((open: boolean) => void) | null): void {
    this.#onTap = cb;
  }

  destroy(): void {
    this.#rnWanted = false;
    this.#dropRn();
    this.disconnect();
    this.#node.port.onmessage = null;
    this.#node.disconnect();
    this.output.stop();
  }

  /** The chain as a LiveKit track processor. LiveKit hands the raw track in and sends `output`. */
  processor(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
    const chain = this;
    return {
      name: "openvoxa-mic",
      processedTrack: chain.output,
      async init(opts) {
        chain.connect(opts.track);
      },
      async restart(opts) {
        chain.connect(opts.track);
      },
      async destroy() {
        chain.disconnect();
      },
    };
  }
}
