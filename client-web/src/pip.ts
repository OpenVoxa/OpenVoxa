// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Picture-in-picture for a screen share (decisions.md, Feature decisions,
 * "Picture-in-picture for streams"): the browser's own video PiP window,
 * always on top of other apps, with Mute and Leave buttons from the Media
 * Session API.
 *
 * Why video PiP and not Document PiP (our own HTML in the window): the
 * desktop app's Electron exposes documentPictureInPicture but never opens
 * the window (tested 2026-11-11), and a home-made always-on-top window
 * would freeze the stream when the app is minimised, because LiveKit only
 * keeps a hidden page's video running for a real PiP element.
 *
 * The video element is our own, outside React, so the PiP window survives
 * the tiles unmounting (another channel, Back to Chat). It sits invisible
 * (opacity 0) inside the viewport: off screen, LiveKit's adaptiveStream
 * would count it hidden and stop the video before PiP starts. LiveKit
 * also picks the quality layer from the element's size in the page, not
 * from the PiP window, so the element follows the PiP window's size.
 */

import { useSyncExternalStore } from "react";
import type { ScreenShare, VoiceClient, VoiceSnapshot } from "@core/voice";

/** Media Session's video-call actions (Chromium), not yet in TypeScript's DOM types. */
type CallMediaSession = Omit<MediaSession, "setActionHandler"> & {
  setActionHandler(action: "hangup" | "togglemicrophone", handler: (() => void) | null): void;
  setMicrophoneActive(active: boolean): void;
};

interface Open {
  voice: VoiceClient;
  shareId: string;
  el: HTMLVideoElement;
  off: () => void;
  done: boolean;
}

let current: Open | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Video PiP exists here (not in Firefox). */
export const pipSupported = typeof document !== "undefined" && document.pictureInPictureEnabled === true;

/** The share shown in PiP right now, or null. */
export function usePipShare(): string | null {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => current?.shareId ?? null,
  );
}

/** The PiP button: opens this share in PiP, or closes it if it's there already. */
export async function togglePip(voice: VoiceClient, share: ScreenShare): Promise<void> {
  if (current?.shareId === share.id) return closePip();
  if (current) await closePip();

  const el = document.createElement("video");
  el.className = "pip-source";
  el.autoplay = true;
  el.muted = true;
  el.playsInline = true;
  document.body.append(el);
  voice.attachScreen(share.id, el);
  const open: Open = { voice, shareId: share.id, el, off: () => {}, done: false };
  current = open;
  changed();
  // The buttons are set before the window opens, as tested.
  const stopControls = controls(open);
  open.off = stopControls;

  try {
    // PiP needs the picture's size first; someone else's share is only
    // received once an element shows it, so this can take a moment.
    if (el.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), 8000);
        el.addEventListener("loadedmetadata", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
    if (current !== open) return; // closed or replaced meanwhile
    const win = await el.requestPictureInPicture();
    if (open.done) { // closed while the window was opening
      void document.exitPictureInPicture().catch(() => {});
      return;
    }
    const stopFollowing = follow(open, win);
    open.off = () => (stopControls(), stopFollowing());
  } catch (err) {
    console.warn("picture-in-picture failed", err);
    cleanUp(open);
  }
}

export async function closePip(): Promise<void> {
  const open = current;
  if (!open) return;
  if (document.pictureInPictureElement === open.el) {
    await document.exitPictureInPicture().catch(() => {});
  }
  if (current === open) cleanUp(open); // leavepictureinpicture may have done it
}

function cleanUp(open: Open) {
  if (open.done) return;
  open.done = true;
  open.off();
  open.voice.detachScreen(open.shareId, open.el);
  open.el.remove();
  if (current === open) {
    current = null;
    changed();
  }
}

/** Keeps the element the PiP window's size; closing the window ends it. */
function follow(open: Open, win: PictureInPictureWindow): () => void {
  const { el } = open;
  const size = () => {
    el.style.width = `${win.width}px`;
    el.style.height = `${win.height}px`;
  };
  size();
  win.addEventListener("resize", size);
  // Its X, or "back to tab".
  const left = () => cleanUp(open);
  el.addEventListener("leavepictureinpicture", left, { once: true });
  return () => {
    win.removeEventListener("resize", size);
    el.removeEventListener("leavepictureinpicture", left);
  };
}

/**
 * Leave and Mute in the PiP window, and closing it when the share ends
 * or the call does.
 */
function controls(open: Open): () => void {
  const { voice } = open;
  const ms = navigator.mediaSession as unknown as CallMediaSession;
  ms.setActionHandler("hangup", () => void voice.leave());

  // The mic button follows the voice bar's: shown only when the mute
  // button there works (not server-muted, not in push-to-talk).
  let micShown: boolean | null = null;
  const sync = (snap: VoiceSnapshot) => {
    if (snap.state === "idle" || !snap.screens.some((s) => s.id === open.shareId)) {
      if (current === open) void closePip();
      return;
    }
    const canMute = snap.state === "connected" && snap.canPublish && !snap.serverMuted && !snap.pttMode;
    if (canMute !== micShown) {
      micShown = canMute;
      ms.setActionHandler("togglemicrophone", canMute ? () => {
        const s = voice.snapshot();
        // Shown as off while deafened too; turning it on undeafens (setMuted).
        void voice.setMuted(!(s.muted || s.deafened));
      } : null);
    }
    if (canMute) ms.setMicrophoneActive(!(snap.muted || snap.deafened));
  };
  sync(voice.snapshot());
  const unsubscribe = voice.on(() => sync(voice.snapshot()));

  return () => {
    unsubscribe();
    ms.setActionHandler("hangup", null);
    ms.setActionHandler("togglemicrophone", null);
  };
}
