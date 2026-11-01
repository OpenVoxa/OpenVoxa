// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Join and leave tones for voice calls: two short notes made with
 * WebAudio, rising for a join and falling for a leave. No sound files.
 * Turned off with the "Join and leave sounds" setting (settings.ts).
 */

import { useEffect, useRef } from "react";
import type { VoiceSnapshot } from "@core/voice";
import { getToggle, VOICE_TONES } from "./settings";

let ctx: AudioContext | null = null;

/** After connecting, people already in the call are not announced. */
const SETTLE_MS = 2000;

export function playTone(kind: "join" | "leave"): void {
  if (!getToggle(VOICE_TONES)) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const notes = kind === "join" ? [523.25, 783.99] : [783.99, 523.25]; // C5, G5
    const start = ctx.currentTime + 0.01;
    notes.forEach((freq, i) => {
      const t = start + i * 0.09;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // A quick fade in and out, or the note clicks.
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  } catch {
    /* no WebAudio: stay quiet */
  }
}

/**
 * Plays a tone when you connect or leave, and when someone else joins or
 * leaves your call. Each participant is an account (LiveKit identity), so
 * the same person reconnecting quickly may chime twice; that's honest.
 */
export function useVoiceTones(snap: VoiceSnapshot | null): void {
  const prev = useRef<{ connected: boolean; channel: string | null; ids: Set<string>; since: number }>({
    connected: false, channel: null, ids: new Set(), since: 0,
  });
  useEffect(() => {
    const was = prev.current;
    const connected = snap?.state === "connected";
    const channel = connected ? snap!.channelId : null;
    const ids = new Set(connected ? snap!.participants.filter((p) => !p.isLocal).map((p) => p.id) : []);

    let since = was.since;
    if (connected && (!was.connected || was.channel !== channel)) {
      playTone("join");
      since = Date.now();
    } else if (!connected && was.connected) {
      playTone("leave");
    } else if (connected && Date.now() - since > SETTLE_MS) {
      // (Right after connecting, the people already there arrive one by
      // one; they aren't joining.)
      const joined = [...ids].some((id) => !was.ids.has(id));
      const left = [...was.ids].some((id) => !ids.has(id));
      if (joined) playTone("join");
      else if (left) playTone("leave");
    }
    prev.current = { connected, channel, ids, since };
  }, [snap]);
}
