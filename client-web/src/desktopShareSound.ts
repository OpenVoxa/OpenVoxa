// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Window share sound in the desktop app (decisions.md, "Per-app share
 * sound"). Browsers can't share one window's sound, and neither can
 * Electron on its own, so the app records the shared window's program
 * itself and hands this page the raw sound through its one preload call
 * (window.openvoxaDesktop). Here it becomes an ordinary audio track,
 * published as the share's sound (end-to-end encrypted like any other).
 * In a browser there is no bridge and this does nothing.
 */
import workletUrl from "./shareSoundWorklet.ts?worker&url";
import type { ShareSound } from "@core/voice";

interface DesktopBridge {
  startShareSound(onData: (pcm: Uint8Array) => void, onEnd: (reason: string) => void): Promise<boolean>;
  stopShareSound(): Promise<void>;
}

/**
 * The recording the app is running for this page, if any. The app runs
 * one per server: starting a new one ends the old one there, so after a
 * switch (VoiceClient.switchShare) the old sound must not tell the app
 * to stop, or it would stop the new one (and drop a pick still waiting
 * to start).
 */
let current: object | null = null;

export async function desktopShareSound(onFail: (reason: string) => void): Promise<ShareSound | null> {
  const bridge = (window as unknown as { openvoxaDesktop?: DesktopBridge }).openvoxaDesktop;
  if (!bridge) return null;
  const ctx = new AudioContext({ sampleRate: 48_000 });
  const me = {};
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (current === me) {
      current = null;
      void bridge.stopShareSound();
    }
    void ctx.close();
  };
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "openvoxa-share-sound", { numberOfInputs: 0, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    // The helper sends 16-bit stereo frames (4 bytes) in chunks cut
    // anywhere, so a partial frame waits for the next chunk.
    let rest = new Uint8Array(0);
    const ok = await bridge.startShareSound(
      (chunk) => {
        let bytes = chunk;
        if (rest.length) {
          bytes = new Uint8Array(rest.length + chunk.length);
          bytes.set(rest);
          bytes.set(chunk, rest.length);
        }
        const whole = bytes.length - (bytes.length % 4);
        rest = bytes.slice(whole);
        const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
        const samples = new Float32Array(whole / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        node.port.postMessage(samples, [samples.buffer]);
      },
      (reason) => {
        if (!stopped && reason !== "stopped") onFail(reason);
        stop();
      },
    );
    if (!ok) {
      stop();
      return null;
    }
    current = me;
    await ctx.resume();
    const [track] = dest.stream.getAudioTracks();
    return { track, stop };
  } catch (err) {
    stop();
    throw err;
  }
}
