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

const loaded = new WeakMap<AudioContext, Promise<void>>();

export class MicChain {
  readonly ctx: AudioContext;
  readonly #node: AudioWorkletNode;
  readonly #dest: MediaStreamAudioDestinationNode;
  #sources: MediaStreamAudioSourceNode[] = [];
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
    let p = loaded.get(ctx);
    if (!p) {
      p = ctx.audioWorklet.addModule(workletUrl);
      loaded.set(ctx, p);
    }
    await p;
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
    send.connect(this.#node, 0, 0);
    measure.connect(this.#node, 0, 1);
    this.#sources = [send, measure];
    void this.ctx.resume().catch(() => {});
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
