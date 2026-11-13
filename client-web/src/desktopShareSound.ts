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
import type { DesktopShare, ShareSound } from "@core/voice";

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

interface FollowBridge {
  onShareSwitch(cb: () => void): Promise<void>;
  shareGone(): Promise<void>;
  shareStopped(): Promise<void>;
}

/**
 * The desktop app's Smart Switch (decisions.md, "Smart Switch"): the app
 * follows a game between its client and game windows, and a shared
 * window that closes pauses the share instead of ending it. Null in a
 * browser and in desktop apps from before Smart Switch.
 */
export function desktopShare(): DesktopShare | null {
  const bridge = (window as unknown as { openvoxaDesktop?: Partial<FollowBridge> }).openvoxaDesktop;
  if (!bridge?.onShareSwitch || !bridge.shareGone || !bridge.shareStopped) return null;
  const b = bridge as FollowBridge;
  return {
    onSwitch: (cb) => void b.onShareSwitch(cb),
    gone: () => void b.shareGone(),
    stopped: () => void b.shareStopped(),
    pausedTrack,
  };
}

/**
 * What viewers see while the share waits for its next window: the app's
 * colours, "Paused", redrawn twice a second so frames keep flowing (a
 * canvas only sends a frame when it is drawn).
 */
function pausedTrack(): MediaStreamTrack {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const g = canvas.getContext("2d")!;
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const bg = color("--bg", "#333333");
  const text = color("--text", "#ffffff");
  const muted = color("--muted", "#bdbdbd");
  const font = getComputedStyle(document.body).fontFamily || "sans-serif";
  const draw = () => {
    g.fillStyle = bg;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.textAlign = "center";
    g.fillStyle = text;
    g.font = `600 64px ${font}`;
    g.fillText("Paused", 640, 350);
    g.fillStyle = muted;
    g.font = `28px ${font}`;
    g.fillText("Switching windows…", 640, 410);
  };
  draw();
  const [track] = canvas.captureStream(2).getVideoTracks();
  const timer = setInterval(() => {
    if (track.readyState === "ended") clearInterval(timer);
    else draw();
  }, 500);
  return track;
}
