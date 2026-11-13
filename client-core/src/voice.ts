// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Voice and screen sharing (build order 13, M3), ported from the debug
 * page so every client shares one implementation. No UI here: a
 * `VoiceClient` reports a snapshot and the client draws it.
 *
 * Voice and screen share are always end-to-end encrypted (decisions.md,
 * feature decision 5). Each voice channel has its own MLS group; the frame
 * key is that group's exporter secret, fed to LiveKit's E2EE worker, so
 * the SFU only relays ciphertext. Keys live in a ring of 16 slots (epoch
 * mod 16) so members who apply a commit a moment apart can still hear
 * each other; old slots are overwritten with junk after a short handover
 * so a removed device stops being audible.
 *
 * LiveKit is imported here and nowhere else in client-core's index, so a
 * web client can load this module lazily, on first join.
 */

import {
  BaseKeyProvider,
  DisconnectReason,
  KeyProviderEvent,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  VideoPreset,
  VideoQuality,
  createLocalAudioTrack,
  createLocalScreenTracks,
  isE2EESupported,
  LocalAudioTrack,
  type AudioCaptureOptions,
  type LocalTrack,
  type LocalVideoTrack,
  type TrackPublishOptions,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { MicChain, type MicLevel } from "./micChain.js";
import type { ApiCall } from "./identity.js";
import type { Session } from "./index.js";
import type { KeyValueStore } from "./chat.js";

// ----------------------------------------------------------------- types

export interface VoiceParticipant {
  /** Account ID (LiveKit identity). */
  readonly id: string;
  readonly name: string;
  readonly isLocal: boolean;
  readonly speaking: boolean;
  /** Not sending audio (muted, push-to-talk released, or listen-only). */
  readonly micOff: boolean;
  /** LiveKit's own view: every track goes through the frame encryptor. */
  readonly encrypted: boolean;
  readonly sharing: boolean;
  /** Local playback volume, 0..1 (remote participants only). */
  readonly volume: number;
  /** Silenced on this device only. */
  readonly localMuted: boolean;
  /** A moderator took their microphone away (server mute). */
  readonly serverMuted: boolean;
}

export interface ScreenShare {
  /** Track SID; pass to attachScreen. */
  readonly id: string;
  readonly participantId: string;
  readonly name: string;
  readonly isLocal: boolean;
  /** The share has sound (someone else's: yours is never played back). */
  readonly hasAudio: boolean;
  /** You chose Listen: its sound plays. Off for every new share. */
  readonly listening: boolean;
}

/**
 * How the microphone opens (decisions.md Feature decisions, "Voice
 * activation and audio settings"): when you talk (the default), while a
 * key is held, from one tap of the key until you stop talking
 * (experimental), or always.
 */
export type MicMode = "voice" | "ptt" | "tap" | "open";

/** Remembered audio choices, for the Voice tab. */
export interface AudioSettings {
  mode: MicMode;
  /** Input volume, 0..2. */
  inputGain: number;
  /** Voice activation picks its own threshold. */
  vadAuto: boolean;
  /** The manual threshold, dBFS (-80..0). */
  vadThresholdDb: number;
  /** Tap to Talk closes after this long without voice. */
  tapSilenceMs: number;
  /** Push-to-talk stays open this long after the key is let go. */
  pttReleaseMs: number;
  /** Everyone's volume on this device, 0..1, on top of each person's own. */
  outputVolume: number;
  /** Turn screen-share sound down while someone else talks. */
  duckShare: boolean;
  /** How loud share sound plays while ducked, 0..0.9 of its volume. */
  duckLevel: number;
  echoCancellation: boolean;
  /** Off; Standard: the browser's filter; Strong: RNNoise (rnnoiseWorklet.ts) instead. */
  noise: NoiseMode;
  autoGainControl: boolean;
}

export type NoiseMode = "off" | "standard" | "strong";

export type { MicLevel } from "./micChain.js";

export interface VoiceSnapshot {
  readonly state: "idle" | "connecting" | "connected";
  readonly channelId: string | null;
  readonly participants: readonly VoiceParticipant[];
  readonly screens: readonly ScreenShare[];
  /** May speak and share (post permission in the channel). */
  readonly canPublish: boolean;
  /** A moderator server-muted this account: no mic, no screen audio. */
  readonly serverMuted: boolean;
  /** The mute button (ignored in push-to-talk mode). */
  readonly muted: boolean;
  readonly deafened: boolean;
  /** A key opens the mic (push-to-talk or Tap to Talk, or the channel forces it). */
  readonly pttMode: boolean;
  /** The mode in effect: push-to-talk when the channel forces it. */
  readonly micMode: MicMode;
  /** Voice activation (or Tap to Talk) is letting sound through right now. */
  readonly transmitting: boolean;
  /** Talking while muted: show a "you're muted" hint. */
  readonly mutedTalking: boolean;
  /** The channel requires push-to-talk. */
  readonly forcePTT: boolean;
  /** Push-to-talk key held right now (Tap to Talk: the mic is open). */
  readonly pttHeld: boolean;
  /** This device is sending audio right now. */
  readonly micOpen: boolean;
  readonly sharing: boolean;
  /** The shared window closed and the share waits for the next one (desktop app). */
  readonly sharePaused: boolean;
  /** The running share's quality (after the server's limit), or null. */
  readonly share: ShareSettings | null;
  /** Media key epoch, once encryption is up. */
  readonly epoch: number | null;
  /** The browser blocked audio until the user interacts; call startAudio. */
  readonly audioBlocked: boolean;
  /** Why the last call ended, or why joining failed. */
  readonly lastEnd: string | null;
  readonly notices: readonly string[];
}

export interface ShareSettings {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  /** "detail" keeps text sharp, "motion" keeps the frame rate. */
  priority: "detail" | "motion";
  audio: boolean;
  /**
   * "vp8" (the default): a full copy and a half-size one for tiles.
   * "h264": one full copy. Both encode on the CPU in Chromium today
   * (decisions.md, "Why Hardware (H.264) still encodes in software").
   * Fixed for the length of a share.
   */
  codec: ShareCodec;
}

export type ShareCodec = "h264" | "vp8";

/** A share's stats line (screenStats). Max values: your own share only. */
export interface ScreenStats {
  fps: number | null;
  maxFps: number | null;
  kbps: number | null;
  maxKbps: number | null;
  /** H.264, VP8, ... */
  codec: string | null;
  /** The browser's encoder or decoder, e.g. OpenH264, libvpx, or a graphics card's. */
  coder: string | null;
  /** Whether that runs on dedicated hardware (null: the browser doesn't say). */
  hardware: boolean | null;
  /** The codec's SDP parameters (for H.264, which profile was agreed). */
  fmtp: string | null;
  dropped: number;
}

/**
 * The server's screen share quality limit (null: none). res is the "p"
 * of a preset, the shorter side of the picture; kbps is the best layer's
 * bitrate. The server stops shares that declare more (sharelimit.go).
 */
export interface ShareLimit {
  res: number;
  fps: number;
  kbps: number;
}

/** Whether a preset fits within a limit (always, with no limit). */
export function presetAllowed(p: { width: number; height: number; fps: number; kbps: number }, limit: ShareLimit | null): boolean {
  return !limit || (Math.min(p.width, p.height) <= limit.res && p.fps <= limit.fps && p.kbps <= limit.kbps);
}

/** LiveKit's TrackSource values (protocol enum). */
const SOURCE_MICROPHONE = 2;
const SOURCE_SCREEN_SHARE = 3;
const SOURCE_SCREEN_SHARE_AUDIO = 4;

/**
 * Server-muted: the server's allowed-sources list leaves the microphone
 * out (voicemute.go). An empty list means every source.
 */
function micTakenAway(p: Participant): boolean {
  const sources = p.permissions?.canPublishSources ?? [];
  return sources.length > 0 && !sources.includes(SOURCE_MICROPHONE);
}

const SHARE_BLOCKED =
  "Screen sharing is blocked until you rejoin the call: your last share was above this server's quality limit.";

// A share's sound leaves out this page's own sound (the call's voices),
// so the others never hear themselves back. In the desktop app on
// Windows this keeps the whole app out of the "all system sound"
// capture (RO1, decisions.md "Per-app share sound", option C).
// Browsers that don't know restrictOwnAudio ignore it. Not yet in
// TypeScript's or LiveKit's types, hence the cast.
const SHARE_AUDIO = { restrictOwnAudio: true } as AudioCaptureOptions;

export const SHARE_PRESETS: readonly { label: string; width: number; height: number; fps: number; kbps: number }[] = [
  { label: "720p 30fps", width: 1280, height: 720, fps: 30, kbps: 2500 },
  { label: "1080p 30fps", width: 1920, height: 1080, fps: 30, kbps: 4000 },
  { label: "1080p 60fps", width: 1920, height: 1080, fps: 60, kbps: 8000 },
  { label: "1440p 60fps", width: 2560, height: 1440, fps: 60, kbps: 14000 },
  { label: "4K 30fps", width: 3840, height: 2160, fps: 30, kbps: 20000 },
];

export interface VoiceOptions {
  call: ApiCall;
  userId: string;
  /** Builds LiveKit's E2EE worker: same origin, same build as the library. */
  createWorker: () => Worker;
  /** Remembered choices (devices, volumes, push-to-talk). */
  store: KeyValueStore;
  /**
   * The desktop app's window share sound: asked for after a share that
   * wanted sound came back without any (a window share). Null when there
   * is none (a browser, or Share Sound unticked). onFail reports the
   * sound stopping on its own mid-share.
   */
  windowShareSound?: (onFail: (reason: string) => void) => Promise<ShareSound | null>;
  /**
   * The desktop app's Smart Switch (decisions.md, "Smart Switch"). With it,
   * a shared window that closes pauses the share instead of ending it.
   * Absent in browsers and older desktop apps.
   */
  desktopShare?: DesktopShare;
  /** The mic AudioWorklet (micWorklet.ts), built by the app. Without it the mic is sent as captured. */
  micWorkletUrl?: string;
  /** Strong noise suppression's AudioWorklet (rnnoiseWorklet.ts); downloaded when first used. */
  rnnoiseWorkletUrl?: string;
}

/** The desktop app's share signals (VoiceOptions.desktopShare). */
export interface DesktopShare {
  /** The app asks for a switch: the next getDisplayMedia is answered by the app. */
  onSwitch(cb: () => void): void;
  /** The shared window closed: the app answers the next getDisplayMedia (the game's other window, or its picker). */
  gone(): void;
  /** The share ended. */
  stopped(): void;
  /** A still picture shown to viewers while the share waits for its next window. */
  pausedTrack(): MediaStreamTrack;
}

/** A share's sound from outside getDisplayMedia (the desktop app). */
export interface ShareSound {
  track: MediaStreamTrack;
  /** Stops the recording behind the track. */
  stop: () => void;
}

/** Which audio devices exist; labels are empty until mic permission. */
export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  /** The browser can route output to a chosen device (not Safari). */
  canPickOutput: boolean;
  /** Device names are visible (the page may use the microphone). */
  named: boolean;
}

/**
 * Scale a capture down so its shorter side fits the limit. LiveKit asks
 * the browser for the preset size only as an "ideal", so a bigger screen
 * or window can come through at full size; max constraints, worked out
 * from the captured aspect ratio, hold it inside the limit.
 */
async function capToLimit(track: LocalTrack, limit: ShareLimit): Promise<void> {
  const { width, height } = track.mediaStreamTrack.getSettings();
  if (!width || !height || Math.min(width, height) <= limit.res) return;
  const f = limit.res / Math.min(width, height);
  try {
    await track.mediaStreamTrack.applyConstraints({
      width: { max: Math.floor(width * f) },
      height: { max: Math.floor(height * f) },
      frameRate: { max: limit.fps },
    });
  } catch (err) {
    console.warn("couldn't scale the share to the server's limit:", err);
  }
}

/** Share settings held to the server's limit (frame rate and bitrate; the size by capToLimit). */
function heldToLimit(s: ShareSettings, limit: ShareLimit | null): ShareSettings {
  return limit ? { ...s, fps: Math.min(s.fps, limit.fps), kbps: Math.min(s.kbps, limit.kbps) } : s;
}

const WEBKIT = typeof navigator !== "undefined" &&
  /AppleWebKit/.test(navigator.userAgent) && !/(Chrome|Chromium|Android)\//.test(navigator.userAgent);

/** Whether this browser can send an H.264 share. */
function canShareH264(): boolean {
  try {
    return RTCRtpSender.getCapabilities?.("video")?.codecs.some((c) => /h264/i.test(c.mimeType)) ?? false;
  } catch {
    return false;
  }
}

/** The encoder a share really uses: the one asked for when this browser can send it. */
function shareCodec(asked: ShareCodec): ShareCodec {
  if (WEBKIT) return "h264";
  return asked === "h264" && canShareH264() ? "h264" : "vp8";
}

/** The capture size asked for, as LiveKit asks it (Safari: max, others: ideal). */
function captureSize(s: ShareSettings): MediaTrackConstraints {
  return WEBKIT
    ? { width: { max: s.width }, height: { max: s.height }, frameRate: s.fps }
    : { width: { ideal: s.width }, height: { ideal: s.height }, frameRate: s.fps };
}

/** How a share's picture is published, also when its quality changes live. */
function shareOptions(s: ShareSettings): TrackPublishOptions {
  // Safari (iPad, CV5) sends only the small VP8 copy of a share: viewers
  // asking for the full one got 0 kbps, a black Watch view. Safari and
  // every other WebKit browser send one full H.264 copy instead
  // (hardware-encoded), so their shares cost viewers' tiles more.
  const codec = shareCodec(s.codec);
  const encoding = { maxBitrate: s.kbps * 1000, maxFramerate: s.fps };
  return {
    // Screen-share tracks read screenShareEncoding, NOT videoEncoding;
    // setting only the latter leaves 1080p15 at 1.5 Mbps in place.
    screenShareEncoding: encoding,
    videoEncoding: encoding,
    // H.264: one full copy, because H.264 simulcast is
    // poorly supported; tiles download the full picture too.
    // VP8: two layers, full quality and half resolution, which the call
    // view's tiles show (adaptiveStream picks it from their size) and
    // anyone who can't keep up falls back to. Both at the chosen frame
    // rate: a 30 fps cap here made a 60 fps game share look locked at 30
    // whenever every viewer was on a tile (2026-11-08). VP8, because H.264
    // simulcast is poorly supported (decisions.md, "Voice channel
    // view"); watching costs a little more CPU where VP8 isn't
    // hardware-decoded.
    simulcast: codec === "vp8",
    screenShareSimulcastLayers: [
      new VideoPreset(Math.round(s.width / 2), Math.round(s.height / 2),
        Math.round(s.kbps * 1000 * 0.3), s.fps),
    ],
    // No backup codec: LiveKit only adds one without E2EE (checked in
    // livekit-client 2.23.0), so an H.264 share is exactly one copy.
    videoCodec: codec,
    degradationPreference: s.priority === "motion" ? "maintain-framerate" : "maintain-resolution",
  };
}

// ------------------------------------------------------------ media keys

const MEDIA_KEYRING = 16;
/** How long the previous epoch's media key keeps working after a change. */
const MEDIA_KEY_HANDOVER_MS = 10_000;

/** Ducking share sound: fade step, full fade down / up, hold after the talking stops. */
const DUCK_STEP_MS = 30;
const DUCK_ATTACK_MS = 150;
const DUCK_RELEASE_MS = 600;
const DUCK_HOLD_MS = 400;

class MlsMediaKeys extends BaseKeyProvider {
  #current = -1;
  #retire: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super({
      sharedKey: true, // one group key, not one per participant
      ratchetWindowSize: 0, // never ratchet: keys come only from MLS
      failureTolerance: -1, // a failed frame never invalidates a key
      keyringSize: MEDIA_KEYRING,
    });
  }

  async setEpochKey(epoch: number, bytes: Uint8Array): Promise<void> {
    // HKDF input material; LiveKit derives the AES-GCM frame key from it.
    const material = await crypto.subtle.importKey(
      "raw", bytes as BufferSource, "HKDF", false, ["deriveBits", "deriveKey"]);
    this.onSetEncryptionKey(material, undefined, epoch % MEDIA_KEYRING);
    this.#current = epoch;

    // Old keys stay usable only for the handover. Afterwards every other
    // slot is overwritten, or a removed device (which can only encrypt
    // under an old key) stays audible (found on Docker 2026-10-31).
    clearTimeout(this.#retire);
    this.#retire = setTimeout(() => {
      if (this.#current === epoch) this.#retireOld(epoch).catch(() => {});
    }, MEDIA_KEY_HANDOVER_MS);
  }

  async #retireOld(epoch: number): Promise<void> {
    for (let slot = 0; slot < MEDIA_KEYRING; slot++) {
      if (slot === epoch % MEDIA_KEYRING) continue;
      const junk = await crypto.subtle.importKey(
        "raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, ["deriveBits", "deriveKey"]);
      if (this.#current !== epoch) return; // a newer key arrived meanwhile
      this.#overwriteSlot(junk, slot);
    }
  }

  // Replace one slot's key WITHOUT making it the slot this device encrypts
  // with. onSetEncryptionKey cannot: it also moves LiveKit's current key
  // index, which left every device encrypting with junk (Docker
  // 2026-10-31, D4). keyInfoMap is TypeScript-private, a plain property
  // at runtime, and is what LiveKit re-sends to the worker on reconnect.
  #overwriteSlot(material: CryptoKey, slot: number): void {
    const info = { key: material, participantIdentity: undefined, keyIndex: slot };
    (this as unknown as { keyInfoMap: Map<string, unknown> }).keyInfoMap.set(`shared-${slot}`, info);
    (this as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(KeyProviderEvent.SetKey, info, false);
  }

  stop(): void {
    clearTimeout(this.#retire);
  }
}

function isRemoved(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "RemovedFromGroup" || name === "GroupReset";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --------------------------------------------------------------- client

export class VoiceClient {
  readonly #session: Session;
  readonly #opts: VoiceOptions;
  #listeners = new Set<() => void>();
  #snapshot: VoiceSnapshot | null = null;

  #state: VoiceSnapshot["state"] = "idle";
  #channelId: string | null = null;
  #room: Room | null = null;
  #keys: MlsMediaKeys | null = null;
  #worker: Worker | null = null;
  #epoch: number | null = null;
  #poll: ReturnType<typeof setInterval> | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  /** Mic publish/release, one at a time (separate from group operations). */
  #micChain: Promise<unknown> = Promise.resolve();
  #offAuto: (() => void) | null = null;
  /** Per person: when the current run of decryption errors began, and the last one. */
  #decryptErrors = new Map<string, { since: number; last: number; told: boolean }>();

  #mic: LocalAudioTrack | null = null;
  #screenTracks: LocalTrack[] = [];
  /** A share's sound, taken down by a server mute and kept for the unmute
   * (screen capture audio can't be reopened without the browser's picker). */
  #heldShareAudio: LocalTrack | null = null;
  /** Stops the desktop app's window share sound, if one runs. */
  #stopWindowSound: (() => void) | null = null;
  /** What the running share was asked for (held to the limit). */
  #share: ShareSettings | null = null;
  /** A switch or quality change is under way (one at a time). */
  #shareBusy = false;
  /** The shared window closed; viewers see desktopShare.pausedTrack. */
  #sharePaused = false;
  /**
   * The capture ended on its own: the browser's "Stop sharing" bar, or the
   * shared window closed. In the desktop app (which has no such bar) the
   * share then waits for the next window instead of ending.
   */
  #onShareEnded = (e: Event) => {
    const video = this.#shareVideo();
    if (this.#opts.desktopShare && video && e.target === video.mediaStreamTrack) void this.#shareGone();
    else void this.stopShare();
  };
  #canPublish = false;
  #muted = false;
  #deafened = false;
  #mode: MicMode;
  #forcePTT = false;
  #pttHeld = false;
  #pttRelease: ReturnType<typeof setTimeout> | undefined;
  /** Tap to Talk: open between a tap and the end of talking. */
  #tapOpen = false;
  /** The mic's processing (micChain.ts), one per published mic. */
  #proc: MicChain | null = null;
  #ctx: AudioContext | null = null;
  #ctx48Refused = false;
  #strongProblem: "unsupported" | "error" | null = null;
  #gateOpen = false;
  #mutedTalking = false;
  #voiceSince: number | null = null;
  #quietSince: number | null = null;
  #levelListeners = new Set<(l: MicLevel | null) => void>();
  #test: { stream: MediaStream; chain: MicChain; el: HTMLAudioElement } | null = null;
  #audioBlocked = false;
  #endReason: string | null = null;
  /** Replaces the end-of-call line when we know better (a moderator
   * disconnected you), whatever LiveKit gives as the reason. */
  #endNote: string | null = null;
  /** The call that ended last, so a late explanation finds it. */
  #endedChannel: string | null = null;
  #lastEnd: string | null = null;
  #notices: string[] = [];
  #audioEls = new Map<string, HTMLMediaElement>();
  /**
   * Nothing of a share is received until asked for (autoSubscribe off):
   * its picture while a tile shows it (attachScreen), its sound only
   * after Listen. Otherwise every share's sound played for everyone in
   * the call, and everyone downloaded every share.
   */
  #screenEls = new Map<string, Set<HTMLVideoElement>>();
  /** Pending unsubscribes, so a tile handing over to the big view (or
   * back) doesn't stop and restart the download. */
  #unwatch = new Map<string, ReturnType<typeof setTimeout>>();
  #listening = new Set<string>(); // participant identities
  #stats = new Map<string, { bytes: number; at: number; droppedBase: number }>();

  constructor(session: Session, opts: VoiceOptions) {
    this.#session = session;
    this.#opts = opts;
    // Smart Switch: the app saw the game's other window come or go.
    opts.desktopShare?.onSwitch(() => {
      if (this.#screenTracks.length) this.switchShare().catch(() => { /* nothing to switch to */ });
    });
    const saved = opts.store.get("voice.mode");
    this.#mode = saved === "voice" || saved === "ptt" || saved === "tap" || saved === "open" ? saved
      // Before voice activation there were two: push-to-talk or an open mic.
      : opts.store.get("voice.ptt") === "1" ? "ptt" : "voice";
  }

  // ---------------------------------------------------------- snapshots

  on(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): VoiceSnapshot {
    if (!this.#snapshot) {
      const room = this.#room;
      const people: VoiceParticipant[] = [];
      const screens: ScreenShare[] = [];
      if (room && this.#state !== "idle") {
        const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
        for (const p of all) {
          const local = p === room.localParticipant;
          const audioOn = [...p.audioTrackPublications.values()]
            .some((pub) => pub.source === Track.Source.Microphone && pub.track && !pub.isMuted);
          // Remote shares are listed whether or not they are received.
          const vids = [...p.videoTrackPublications.values()]
            .filter((pub) => pub.source === Track.Source.ScreenShare && (!local || pub.track));
          const shareAudio = !local && [...p.audioTrackPublications.values()]
            .some((pub) => pub.source === Track.Source.ScreenShareAudio);
          people.push({
            id: p.identity,
            name: p.name || p.identity,
            isLocal: local,
            speaking: p.isSpeaking,
            micOff: local ? !this.#micOpen() : !audioOn,
            encrypted: p.isEncrypted,
            sharing: vids.length > 0,
            volume: local ? 1 : this.#volumeOf(p.identity),
            localMuted: !local && this.#localMutedOf(p.identity),
            serverMuted: (local ? this.#canPublish : !!p.permissions?.canPublish) && micTakenAway(p),
          });
          for (const pub of vids) {
            screens.push({
              id: pub.trackSid, participantId: p.identity, name: p.name || p.identity, isLocal: local,
              hasAudio: shareAudio, listening: shareAudio && this.#listening.has(p.identity),
            });
          }
        }
      }
      this.#snapshot = {
        state: this.#state,
        channelId: this.#channelId,
        participants: people,
        screens,
        canPublish: this.#canPublish,
        serverMuted: this.#serverMuted(),
        muted: this.#muted,
        deafened: this.#deafened,
        pttMode: this.#keyMode(),
        micMode: this.#effectiveMode(),
        transmitting: this.#micOpen() && (this.#effectiveMode() !== "voice" || !this.#proc || this.#gateOpen),
        mutedTalking: this.#mutedTalking,
        forcePTT: this.#forcePTT,
        pttHeld: this.#canTalk() && (this.#effectiveMode() === "tap" ? this.#tapOpen : this.#pttHeld),
        micOpen: this.#micOpen(),
        sharing: this.#screenTracks.length > 0,
        sharePaused: this.#screenTracks.length > 0 && this.#sharePaused,
        share: this.#screenTracks.length ? this.#share : null,
        epoch: this.#epoch,
        audioBlocked: this.#audioBlocked,
        lastEnd: this.#lastEnd,
        notices: this.#notices,
      };
    }
    return this.#snapshot;
  }

  #changed = (): void => {
    this.#snapshot = null;
    for (const l of this.#listeners) {
      try {
        l();
      } catch (err) {
        console.warn("voice listener failed:", err);
      }
    }
  };

  /** A line for the voice bar; it goes away by itself after a while. */
  /** Show a line under the voice bar, as the call's own notices are. */
  showNotice(text: string): void {
    this.#notice(text);
  }

  #notice(text: string): void {
    this.#notices = [...this.#notices.slice(-4), text];
    this.#changed();
    setTimeout(() => {
      const i = this.#notices.indexOf(text);
      if (i < 0) return;
      this.#notices = this.#notices.filter((_, j) => j !== i);
      this.#changed();
    }, 15_000);
  }

  // -------------------------------------------------------- encryption

  /** Every group operation on the voice channel, one at a time. */
  #task<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  /** Apply pending commits and load the current epoch's key. */
  #syncKey(): Promise<void> {
    return this.#task(async () => {
      const id = this.#channelId;
      if (!id || !this.#keys) return;
      await this.#session.groups.catchUp(id);
      const { epoch, key } = await this.#session.groups.mediaKey(id);
      try {
        if (epoch === this.#epoch) return;
        await this.#keys.setEpochKey(epoch, key);
      } finally {
        key.fill(0);
      }
      this.#epoch = epoch;
      this.#changed();
    });
  }

  #syncSoon(): void {
    this.#syncKey().catch((err) => {
      if (isRemoved(err)) this.#removedFromGroup(err);
      else this.#notice(`Voice key: ${errorText(err)}`);
    });
  }

  #removedFromGroup(err: unknown): void {
    this.#endReason = (err as { name?: string }).name === "GroupReset"
      ? "the voice channel's encryption group was replaced; join again"
      : "this device was removed from the voice channel's encryption";
    void this.#room?.disconnect();
  }

  // ------------------------------------------------------- join, leave

  /**
   * Join a voice channel (leaving any other call first). Resolves once
   * connected; on failure the reason is in snapshot().lastEnd.
   */
  async join(channelId: string): Promise<void> {
    if (this.#state !== "idle") await this.leave();
    await this.stopMicTest(); // the call's mic takes over
    this.#lastEnd = null;
    this.#endReason = null;
    this.#endNote = null;
    this.#endedChannel = null;
    this.#notices = [];

    if (!isE2EESupported()) {
      this.#fail("This browser can't encrypt voice, and voice is always encrypted.");
      return;
    }
    this.#state = "connecting";
    this.#channelId = channelId;
    this.#changed();

    try {
      // Keys first: joining unencrypted and switching later would put the
      // first moments of audio through the SFU in the clear. A device not
      // yet in the group joins from the published GroupInfo, so nobody
      // needs to be in the call already.
      const groups = this.#session.groups;
      const result = await groups.open(channelId);
      if (!groups.isMember(channelId)) {
        throw new Error(result.detail || "couldn't open the voice channel's encryption");
      }
      if (result.replaced) this.#notice("This voice channel's encryption group was replaced.");

      this.#keys = new MlsMediaKeys();
      await this.#syncKey();
      if (this.#epoch === null) throw new Error("couldn't derive the voice key");

      const data = (await this.#opts.call(`/api/v1/channels/${channelId}/voice-token`, { method: "POST" })) as {
        url: string; token: string; can_publish: boolean; force_ptt: boolean;
      };
      if (this.#channelId !== channelId) return; // left meanwhile

      const pinned = this.#opts.store.get("voice.pinQuality") === "1";
      const output = this.#opts.store.get("voice.output") ?? undefined;
      this.#worker = this.#opts.createWorker();
      const room = new Room({
        // adaptiveStream picks a layer from the on-screen video size;
        // pinned quality always takes the highest (applies at join).
        adaptiveStream: !pinned,
        dynacast: true,
        encryption: { keyProvider: this.#keys, worker: this.#worker },
        audioOutput: output ? { deviceId: output } : undefined,
        // LiveKit would otherwise stop a capture whenever the server
        // takes its track away, and a share's sound can't be reopened.
        // Every place that should stop a track does so itself.
        stopLocalTrackOnUnpublish: false,
      });
      this.#room = room;
      // Before connect, so nothing is ever published unencrypted.
      await room.setE2EEEnabled(true);
      this.#wire(room, pinned);

      // Microphones are subscribed by #subscribeWanted, shares on demand.
      await room.connect(data.url, data.token, { autoSubscribe: false });
      this.#subscribeWanted(room);
      this.#canPublish = data.can_publish;
      this.#forcePTT = data.force_ptt;
      this.#state = "connected";
      this.#audioBlocked = !room.canPlaybackAudio;

      if (data.can_publish) {
        if (this.#serverMuted()) this.#notice("A moderator has muted you on this server: you can listen but not speak.");
        await this.#syncMic(room);
      } else {
        this.#notice("Listen-only: you can't speak in this channel.");
      }

      // Commits for the voice group arrive on no socket of ours, so the
      // group is polled while in a call; the same poll drives automatic
      // membership (a device waiting to join cannot send anything).
      groups.reconcileSoon(channelId);
      this.#poll = setInterval(() => {
        this.#syncSoon();
        if (this.#channelId && groups.isMember(this.#channelId)) groups.reconcileSoon(this.#channelId);
      }, 5000);
      this.#offAuto = groups.onAuto((ev) => {
        if (ev.channelId !== this.#channelId) return;
        if (ev.kind === "removed") {
          this.#endReason = ev.replaced
            ? "the voice channel's encryption group was replaced; join again"
            : "this device was removed from the voice channel's encryption";
          void this.#room?.disconnect();
        } else if (ev.kind === "reconciled" && (ev.result.added.length || ev.result.removed.length)) {
          this.#syncSoon();
        }
      });
      this.#hint(channelId);
      this.#changed();
    } catch (err) {
      const room = this.#room;
      this.#cleanup();
      try {
        await room?.disconnect();
      } catch {
        /* never connected */
      }
      this.#fail(`Couldn't join voice: ${errorText(err)}`);
    }
  }

  /** Whether a moderator has taken this account's microphone away. */
  #serverMuted(): boolean {
    const room = this.#room;
    return !!room && this.#canPublish && micTakenAway(room.localParticipant);
  }

  /**
   * Have a published microphone exactly when allowed to speak: published
   * at join, released while server-muted (LiveKit unpublishes it, and the
   * device is let go), published again on unmute.
   */
  #syncMic(room: Room): Promise<void> {
    const run = this.#micChain.then(async () => {
      if (this.#room !== room) return;
      const allowed = this.#canPublish && !this.#serverMuted();
      if (!allowed && this.#mic) {
        const mic = this.#mic;
        this.#mic = null;
        try {
          await room.localParticipant.unpublishTrack(mic, true);
        } catch {
          /* LiveKit already took it down */
        }
        mic.stop();
        this.#dropProc();
      } else if (allowed && !this.#mic) {
        const mic = await createLocalAudioTrack(this.#captureOptions());
        if (this.#room !== room) {
          mic.stop(); // left meanwhile
          return;
        }
        this.#mic = mic;
        // Muted while publishing, so push-to-talk never leaks a moment of
        // audio; opened once the processor is on. Muted through LiveKit,
        // not by disabling the track by hand: unmute() does nothing to a
        // track LiveKit doesn't think is muted, and the mic stayed silent.
        await mic.mute();
        await room.localParticipant.publishTrack(mic);
        await this.#attachProc(mic);
        if (this.#micOpen()) await mic.unmute();
      }
      this.#changed();
    });
    this.#micChain = run.catch(() => {});
    return run;
  }

  #fail(why: string): void {
    this.#state = "idle";
    this.#channelId = null;
    this.#setLastEnd(why);
  }

  /** Why the call ended, shown for a while and then cleared. */
  #setLastEnd(why: string | null): void {
    this.#lastEnd = why;
    this.#changed();
    if (!why) return;
    setTimeout(() => {
      if (this.#lastEnd === why && this.#state === "idle") {
        this.#lastEnd = null;
        this.#changed();
      }
    }, 20_000);
  }

  /**
   * A moderator disconnected you from a call: end it (if the server
   * hasn't already) and say who did it instead of the usual reason.
   * Ignored for a call you are not in.
   */
  async endedBy(channelId: string, text: string): Promise<void> {
    if (this.#state !== "idle" && this.#channelId === channelId) {
      this.#endNote = text;
      await this.leave();
      return;
    }
    // The server's removal can beat the event here: fix the line shown.
    if (this.#state === "idle" && this.#endedChannel === channelId && this.#lastEnd) {
      this.#setLastEnd(text);
    }
  }

  /** Leave the call. */
  async leave(): Promise<void> {
    const room = this.#room;
    if (!room) {
      this.#cleanup();
      this.#changed();
      return;
    }
    await room.disconnect(); // the Disconnected handler cleans up
  }

  /** Tell other clients to refresh who is in this call. Best effort; a
   * leave is sent a moment later so LiveKit has dropped us by then. */
  #hint(channelId: string, delay = 0): void {
    setTimeout(() => {
      this.#opts.call(`/api/v1/channels/${channelId}/voice/changed`, { method: "POST" }).catch(() => {});
    }, delay);
  }

  #cleanup(): void {
    clearInterval(this.#poll);
    this.#poll = undefined;
    this.#offAuto?.();
    this.#offAuto = null;
    for (const t of this.#screenTracks) t.stop();
    this.#screenTracks = [];
    this.#heldShareAudio?.stop();
    this.#heldShareAudio = null;
    this.#stopWindowSound?.();
    this.#stopWindowSound = null;
    this.#share = null;
    this.#mic?.stop();
    this.#mic = null;
    this.#dropProc();
    for (const el of this.#audioEls.values()) el.remove();
    this.#audioEls.clear();
    this.#screenEls.clear();
    for (const t of this.#unwatch.values()) clearTimeout(t);
    this.#unwatch.clear();
    this.#listening.clear();
    this.#stats.clear();
    this.#decryptErrors.clear();
    this.#worker?.terminate(); // LiveKit leaves the worker to its owner
    this.#worker = null;
    this.#keys?.stop();
    this.#keys = null;
    this.#epoch = null;
    this.#room = null;
    if (this.#duckTimer) clearInterval(this.#duckTimer);
    this.#duckTimer = null;
    this.#duckGain = this.#duckTarget = 1;
    this.#duckReleaseAt = 0;
    this.#state = "idle";
    this.#channelId = null;
    this.#canPublish = false;
    this.#forcePTT = false;
    this.#pttHeld = false;
    clearTimeout(this.#pttRelease);
    this.#tapOpen = false;
    this.#audioBlocked = false;
  }

  #describeEnd(reason?: DisconnectReason): string {
    if (this.#endNote) return this.#endNote;
    if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
      return "You were removed from the call (no longer allowed in this channel).";
    }
    if (this.#endReason) return `You were removed from the call: ${this.#endReason}.`;
    if (reason === DisconnectReason.DUPLICATE_IDENTITY) return "Disconnected: you joined this call from somewhere else.";
    if (reason === DisconnectReason.SERVER_SHUTDOWN || reason === DisconnectReason.ROOM_DELETED) {
      return "Disconnected: the voice server closed the call.";
    }
    if (reason === undefined || reason === DisconnectReason.CLIENT_INITIATED) return "";
    return `Disconnected from voice (reason ${reason}).`;
  }

  #wire(room: Room, pinned: boolean): void {
    room
      .on(RoomEvent.ParticipantConnected, () => {
        // Whoever joined was probably just added: new epoch, new key.
        this.#syncSoon();
        this.#changed();
      })
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        for (const [sid, el] of this.#audioEls) {
          if (el.dataset.identity === p.identity) {
            el.remove();
            this.#audioEls.delete(sid);
          }
        }
        this.#updateDuck(); // they may have left mid-sentence
        this.#changed();
      })
      .on(RoomEvent.ParticipantEncryptionStatusChanged, this.#changed)
      .on(RoomEvent.ActiveSpeakersChanged, () => {
        this.#updateDuck();
        this.#changed();
      })
      .on(RoomEvent.TrackMuted, this.#changed)
      .on(RoomEvent.TrackUnmuted, this.#changed)
      .on(RoomEvent.LocalTrackPublished, this.#changed)
      .on(RoomEvent.LocalTrackUnpublished, (pub: { track?: Track }) => {
        const track = pub.track as LocalTrack | undefined;
        if (track && this.#screenTracks.includes(track)) {
          if (track.source === Track.Source.ScreenShareAudio && this.#screenTracks.length > 1) {
            // A server mute takes only the share's sound: the picture goes
            // on, and the sound is kept to publish again on unmute.
            this.#screenTracks = this.#screenTracks.filter((t) => t !== track);
            this.#heldShareAudio = track;
          } else {
            // The server (or LiveKit) took a share down without us: release
            // the capture too, or the browser goes on sharing to nobody.
            void this.stopShare();
          }
        }
        this.#changed();
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (prev: { canPublishSources?: number[] } | undefined, p: Participant) => {
        if (p !== room.localParticipant) {
          this.#changed();
          return;
        }
        if (this.#shareBlocked(room)) {
          if (this.#screenTracks.length) void this.stopShare();
          this.#notice("Your screen share was stopped: it was above this server's quality limit. Rejoin the call to share again.");
        }
        const was = (prev?.canPublishSources?.length ?? 0) > 0 && !prev!.canPublishSources!.includes(SOURCE_MICROPHONE);
        const now = this.#serverMuted();
        if (now && !was) {
          this.#notice("A moderator has muted you on this server: you can listen but not speak.");
          this.#letGo(); // so the mic doesn't come back open on unmute
        }
        if (!now && was) this.#notice("A moderator has unmuted you: you can speak again.");
        void this.#syncMic(room).catch((err) => this.#notice(`Couldn't turn your microphone back on: ${errorText(err)}`));
        void this.#restoreShareAudio(room);
        this.#changed();
      })
      .on(RoomEvent.TrackPublished, () => {
        this.#subscribeWanted(room);
        this.#changed();
      })
      .on(RoomEvent.TrackUnpublished, (_pub: RemoteTrackPublication, p: RemoteParticipant) => {
        // Listen lasts for one share: a new share starts silent again.
        const stillSharing = [...p.trackPublications.values()].some((x) => x.source === Track.Source.ScreenShare);
        if (!stillSharing) this.#listening.delete(p.identity);
        this.#changed();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        this.#audioBlocked = !room.canPlaybackAudio;
        this.#changed();
      })
      .on(RoomEvent.EncryptionError, (err: Error, participant?: Participant) => {
        // Usually a frame under a key we don't have yet: someone joined
        // or left and the commit hasn't reached every device. That is
        // normal for a moment, so only a run of errors lasting longer
        // than the key handover is worth telling anyone about.
        this.#syncSoon();
        const who = participant?.identity ?? "";
        const now = Date.now();
        const run = this.#decryptErrors.get(who);
        if (!run || now - run.last > 3000) {
          this.#decryptErrors.set(who, { since: now, last: now, told: false });
        } else {
          run.last = now;
          if (!run.told && now - run.since > MEDIA_KEY_HANDOVER_MS) {
            run.told = true;
            this.#notice(`Can't decrypt ${participant ? participant.name || participant.identity : "someone"}'s audio ` +
              `(${err?.message ?? String(err)}). Their device may be behind; it usually recovers on its own.`);
          }
        }
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          // Remote audio needs an element in the page to play.
          const el = track.attach();
          el.dataset.identity = p.identity;
          el.style.display = "none";
          document.body.appendChild(el);
          this.#audioEls.set(track.sid ?? pub.trackSid, el);
          this.#applyVolume(p);
        } else if (track.source === Track.Source.ScreenShare) {
          // Tiles that asked before the picture arrived get it now.
          for (const el of this.#screenEls.get(pub.trackSid) ?? []) {
            el.muted = true;
            el.playsInline = true;
            track.attach(el);
          }
          if (pinned) {
            // With adaptiveStream off nothing picks a layer: ask for the top.
            try {
              pub.setVideoQuality(VideoQuality.HIGH);
            } catch {
              /* not simulcast */
            }
          }
        }
        this.#changed();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
        // Only our own hidden audio elements are removed; video elements
        // belong to the page (removing one left a black Watch view).
        const els = track.detach();
        if (track.kind === Track.Kind.Audio) els.forEach((el) => el.remove());
        const sid = track.sid ?? pub.trackSid;
        this.#audioEls.get(sid)?.remove();
        this.#audioEls.delete(sid);
        this.#stats.delete(sid);
        this.#changed();
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (this.#room !== room) return;
        const channelId = this.#channelId;
        const why = this.#describeEnd(reason) || null;
        this.#endReason = null;
        this.#endNote = null;
        this.#endedChannel = channelId;
        this.#cleanup();
        if (channelId) this.#hint(channelId, 1000);
        this.#setLastEnd(why);
      });
  }

  /**
   * Received audio per person, for diagnostics: bytes received and the
   * decoded audio energy. Energy that stops growing while bytes keep
   * arriving means frames arrive but don't decrypt or decode.
   */
  async audioStats(): Promise<Record<string, { bytes: number; energy: number }>> {
    const out: Record<string, { bytes: number; energy: number }> = {};
    for (const p of this.#room?.remoteParticipants.values() ?? []) {
      for (const pub of p.audioTrackPublications.values()) {
        const t = pub.track as unknown as { getRTCStatsReport?: () => Promise<RTCStatsReport | undefined> } | undefined;
        const report = await t?.getRTCStatsReport?.().catch(() => undefined);
        report?.forEach((r: { type: string; kind?: string; bytesReceived?: number; totalAudioEnergy?: number }) => {
          if (r.type !== "inbound-rtp" || r.kind !== "audio") return;
          const cur = out[p.identity] ?? { bytes: 0, energy: 0 };
          cur.bytes += r.bytesReceived ?? 0;
          cur.energy += r.totalAudioEnergy ?? 0;
          out[p.identity] = cur;
        });
      }
    }
    return out;
  }

  /** Let the browser play audio after it blocked autoplay. Call from a click. */
  async startAudio(): Promise<void> {
    await this.#room?.startAudio();
    this.#audioBlocked = !(this.#room?.canPlaybackAudio ?? true);
    this.#changed();
  }

  // ---------------------------------------------- mic, PTT and deafen

  /** The mode in effect: the channel forcing push-to-talk rules out the others (Tap to Talk too). */
  #effectiveMode(): MicMode {
    return this.#forcePTT ? "ptt" : this.#mode;
  }

  #keyMode(): boolean {
    const m = this.#effectiveMode();
    return m === "ptt" || m === "tap";
  }

  /**
   * Whether the mic could open at all: published (not server-muted, not
   * listen-only) and not deafened. A push-to-talk press while it can't is
   * ignored, so nothing claims "Talking" over a mic that's gone.
   */
  #canTalk(): boolean {
    return !!this.#mic && this.#canPublish && !this.#deafened;
  }

  /** Whether LiveKit's mic is unmuted. In voice activation the gate still decides what is sent. */
  #micOpen(): boolean {
    if (!this.#canTalk()) return false;
    switch (this.#effectiveMode()) {
      case "ptt": return this.#pttHeld;
      case "tap": return this.#tapOpen;
      default: return !this.#muted;
    }
  }

  /**
   * Bring LiveKit's mute in line with the mode. The screen updates first
   * and again afterwards, whatever happens: a mute or unmute that stalls
   * or fails (a background window) must not leave the old state showing,
   * such as a channel's forced push-to-talk after it was lifted.
   */
  async #applyMic(): Promise<void> {
    this.#changed();
    const mic = this.#mic;
    if (!mic) return;
    try {
      const open = this.#micOpen();
      if (open && mic.isMuted) await mic.unmute();
      else if (!open && !mic.isMuted) await mic.mute();
    } catch (err) {
      this.#notice(`Couldn't switch the microphone: ${errorText(err)}`);
    } finally {
      this.#changed();
    }
  }

  setMuted(muted: boolean): Promise<void> {
    this.#muted = muted;
    // Unmuting while deafened undeafens, as people expect.
    if (!muted && this.#deafened) return this.setDeafened(false);
    return this.#applyMic();
  }

  /** Silence everyone and close the mic; undeafen restores both. */
  setDeafened(deafened: boolean): Promise<void> {
    this.#deafened = deafened;
    if (deafened) this.#letGo();
    for (const p of this.#room?.remoteParticipants.values() ?? []) this.#applyVolume(p);
    this.#updateDuck();
    return this.#applyMic();
  }

  /** Pick how the mic opens. Remembered; a channel that forces push-to-talk overrides it. */
  setMicMode(mode: MicMode): Promise<void> {
    this.#mode = mode;
    this.#opts.store.set("voice.mode", mode);
    this.#pttHeld = false;
    clearTimeout(this.#pttRelease);
    this.#tapOpen = false;
    this.#configureChains();
    return this.#applyMic();
  }

  /** The push-to-talk key went down (true) or up (false). In Tap to Talk a press opens or closes. */
  setPTTHeld(held: boolean): void {
    if (held && !this.#canTalk()) return;
    const mode = this.#effectiveMode();
    if (mode === "tap") {
      if (held === this.#pttHeld) return;
      this.#pttHeld = held;
      if (this.#proc) this.#proc.tap(held ? "down" : "up");
      else if (held) {
        // No processing to hear the silence: a plain toggle.
        this.#tapOpen = !this.#tapOpen;
        void this.#applyMic();
      }
      return;
    }
    clearTimeout(this.#pttRelease);
    if (held) {
      if (this.#pttHeld) return;
      this.#pttHeld = true;
      void this.#applyMic();
      return;
    }
    if (!this.#pttHeld) return;
    const release = () => {
      this.#pttHeld = false;
      void this.#applyMic();
    };
    const ms = this.audioSettings.pttReleaseMs;
    if (ms > 0) this.#pttRelease = setTimeout(release, ms);
    else release();
  }

  /** Release push-to-talk and close Tap to Talk, as if the key went up and the silence ran out. */
  #letGo(): void {
    this.#pttHeld = false;
    clearTimeout(this.#pttRelease);
    this.#tapOpen = false;
    this.#proc?.tap("close");
  }

  /** The channel's settings changed (force push-to-talk). */
  setForcePTT(force: boolean): void {
    if (this.#state === "idle" || force === this.#forcePTT) return;
    this.#forcePTT = force;
    this.#pttHeld = false;
    this.#tapOpen = false;
    this.#proc?.tap("close");
    this.#configureChains();
    void this.#applyMic();
  }

  // ---------------------------------------------- audio settings

  #num(key: string, fallback: number, min: number, max: number): number {
    const raw = this.#opts.store.get(key);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  }

  #flag(key: string, fallback: boolean): boolean {
    const raw = this.#opts.store.get(key);
    return raw === null ? fallback : raw === "1";
  }

  get audioSettings(): AudioSettings {
    return {
      mode: this.#mode,
      inputGain: this.#num("voice.inputGain", 1, 0, 2),
      vadAuto: this.#flag("voice.vadAuto", true),
      vadThresholdDb: this.#num("voice.vadThreshold", -50, -80, 0),
      tapSilenceMs: this.#num("voice.tapSilence", 1500, 500, 5000),
      pttReleaseMs: this.#num("voice.pttRelease", 200, 0, 1000),
      outputVolume: this.#num("voice.outputVolume", 1, 0, 1),
      duckShare: this.#flag("voice.duckShare", true),
      duckLevel: this.#num("voice.duckLevel", 0.3, 0, 0.9),
      echoCancellation: this.#flag("voice.echoCancellation", true),
      noise: this.#noiseMode(),
      autoGainControl: this.#flag("voice.autoGainControl", true),
    };
  }

  /** Change remembered audio settings; applies at once, in a call and in the mic test. */
  async setAudioSettings(change: Partial<Omit<AudioSettings, "mode">>): Promise<void> {
    const str = (v: number | boolean | string) => typeof v === "boolean" ? (v ? "1" : "0") : String(v);
    const keys: Record<string, string> = {
      inputGain: "voice.inputGain", vadAuto: "voice.vadAuto", vadThresholdDb: "voice.vadThreshold",
      tapSilenceMs: "voice.tapSilence", pttReleaseMs: "voice.pttRelease", outputVolume: "voice.outputVolume",
      echoCancellation: "voice.echoCancellation", noise: "voice.noise",
      autoGainControl: "voice.autoGainControl", duckShare: "voice.duckShare", duckLevel: "voice.duckLevel",
    };
    for (const [k, v] of Object.entries(change)) {
      if (v !== undefined && keys[k]) this.#opts.store.set(keys[k], str(v));
    }
    this.#configureChains();
    if ("outputVolume" in change) {
      for (const p of this.#room?.remoteParticipants.values() ?? []) this.#applyVolume(p);
    }
    if ("duckShare" in change || "duckLevel" in change) this.#updateDuck();
    if ("noise" in change) this.#strongProblem = null; // picking again tries again
    if ("noise" in change) {
      if (this.#proc) await this.#applyStrong(this.#proc);
      if (this.#test) await this.#applyStrong(this.#test.chain);
    }
    if ("echoCancellation" in change || "noise" in change || "autoGainControl" in change) {
      // The browser applies these when capturing: capture again.
      await this.#recapture();
      if (this.#test) {
        await this.stopMicTest();
        await this.startMicTest();
      }
    }
    this.#changed();
  }

  #captureOptions() {
    const a = this.audioSettings;
    return {
      deviceId: this.#opts.store.get("voice.input") ?? undefined,
      echoCancellation: a.echoCancellation,
      // The browser's filter for Standard, and in place of Strong where Strong can't run.
      noiseSuppression: a.noise === "standard" || (a.noise === "strong" && this.#strongProblem !== null),
      autoGainControl: a.autoGainControl,
    };
  }

  /**
   * Captures the call's mic again with the current filters (echo
   * cancellation, noise suppression, automatic gain): unpublished and
   * published fresh, the path a join (and a server unmute) takes. Not
   * LiveKit's restartTrack: in the desktop app (Electron 45, Windows) the
   * restarted capture came back dead, meter included, until a rejoin
   * (RN7), even with the chain's clone let go first. Others see the mic
   * drop for a moment.
   */
  async #recapture(): Promise<void> {
    const room = this.#room;
    if (!room || !this.#mic) return;
    const run = this.#micChain.then(async () => {
      const mic = this.#mic;
      if (this.#room !== room || !mic) return;
      this.#mic = null;
      try {
        await room.localParticipant.unpublishTrack(mic, true);
      } catch {
        /* already down */
      }
      mic.stop();
      this.#dropProc();
    });
    this.#micChain = run.catch(() => {});
    try {
      await run;
      await this.#syncMic(room);
    } catch (err) {
      this.#notice(`Couldn't restart the microphone: ${errorText(err)}. Leave and rejoin the call.`);
    }
  }

  /** For the console (openvoxaVoice.micInfo()): the call's capture as the browser sees it. */
  micInfo(): Record<string, unknown> {
    const raw = (this.#mic as unknown as { _mediaStreamTrack?: MediaStreamTrack } | null)?._mediaStreamTrack;
    return {
      published: !!this.#mic,
      livekitMuted: this.#mic?.isMuted ?? null,
      track: raw ? { state: raw.readyState, enabled: raw.enabled, muted: raw.muted, label: raw.label, settings: raw.getSettings() } : null,
      context: this.#ctx ? { state: this.#ctx.state, sampleRate: this.#ctx.sampleRate } : null,
      chain: !!this.#proc,
      noise: this.audioSettings.noise,
      strongProblem: this.#strongProblem,
    };
  }

  #noiseMode(): NoiseMode {
    const v = this.#opts.store.get("voice.noise");
    if (v === "off" || v === "standard" || v === "strong") return v;
    return this.#flag("voice.noiseSuppression", true) ? "standard" : "off"; // the old on/off switch
  }

  /** Strong noise suppression couldn't run here: "unsupported" (not 48 kHz) or "error" (didn't load). */
  get strongNoiseProblem(): "unsupported" | "error" | null {
    return this.#strongProblem;
  }

  /**
   * Puts RNNoise in front of a chain, or takes it out, as the setting
   * says. Where it can't run, says so once and captures again with the
   * browser's filter (#captureOptions), so Strong is never worse than
   * Standard.
   */
  async #applyStrong(chain: MicChain): Promise<void> {
    const want = this.audioSettings.noise === "strong";
    const r = await chain.setStrongNoise(want && this.#strongProblem === null, this.#opts.rnnoiseWorkletUrl);
    if (!want || this.#strongProblem !== null || (r !== "unsupported" && r !== "error")) return;
    this.#strongProblem = r;
    this.#notice(r === "unsupported"
      ? "Strong noise suppression needs 48 kHz audio, which this browser didn't give. Using the browser's noise suppression instead."
      : "Strong noise suppression didn't load. Using the browser's noise suppression instead.");
    this.#changed();
    if (chain === this.#proc) await this.#recapture();
    else if (chain === this.#test?.chain) {
      await this.stopMicTest();
      await this.startMicTest();
    }
  }

  #chainConfig() {
    const a = this.audioSettings;
    const m = this.#effectiveMode();
    return {
      mode: m === "voice" ? "gate" as const : m === "tap" ? "tap" as const : "open" as const,
      gain: a.inputGain,
      auto: a.vadAuto,
      thresholdDb: a.vadThresholdDb,
      tapSilenceMs: a.tapSilenceMs,
    };
  }

  #configureChains(): void {
    const c = this.#chainConfig();
    this.#proc?.configure(c);
    // The mic test previews voice activation, whatever key mode is picked.
    this.#test?.chain.configure({ ...c, mode: c.mode === "gate" ? "gate" : "open" });
  }

  /**
   * The mic's AudioContext, at 48 kHz where the browser allows it (RNNoise
   * needs it; it is Opus's rate anyway). Firefox may refuse a mic at a
   * different rate from its context: then the context goes back to the
   * browser's own rate, and Strong noise suppression can't run.
   */
  #audioContext(track: MediaStreamTrack): AudioContext {
    const make = (rate?: number) => new AudioContext({ latencyHint: "interactive", sampleRate: rate });
    let ctx = this.#ctx;
    if (!ctx || ctx.state === "closed") {
      try {
        ctx = this.#ctx48Refused ? make() : make(48000);
      } catch {
        ctx = make();
      }
      this.#ctx = ctx;
    }
    try {
      ctx.createMediaStreamSource(new MediaStream([track])).disconnect();
    } catch {
      this.#ctx48Refused = true;
      void ctx.close().catch(() => {});
      ctx = this.#ctx = make();
    }
    return ctx;
  }

  /** Puts the processing between the mic and LiveKit. Without it the mic goes out as captured. */
  async #attachProc(mic: LocalAudioTrack): Promise<void> {
    const url = this.#opts.micWorkletUrl;
    if (!url) return;
    try {
      const ctx = this.#audioContext(mic.mediaStreamTrack);
      const chain = await MicChain.create(ctx, url, this.#chainConfig());
      chain.onLevel((l) => this.#onLevel(l));
      chain.onTap((open) => {
        if (this.#effectiveMode() !== "tap") return;
        this.#tapOpen = open;
        void this.#applyMic();
      });
      await mic.setAudioContext(ctx);
      await mic.setProcessor(chain.processor());
      this.#proc = chain;
      await this.#applyStrong(chain);
    } catch (err) {
      this.#notice(`Voice activation isn't available in this browser (${errorText(err)}). Your mic is open while unmuted.`);
    }
  }

  #dropProc(): void {
    this.#proc?.destroy();
    this.#proc = null;
    this.#gateOpen = false;
    this.#tapOpen = false;
    this.#mutedTalking = false;
    this.#voiceSince = this.#quietSince = null;
    if (!this.#test) for (const cb of this.#levelListeners) cb(null);
  }

  #onLevel(l: MicLevel): void {
    if (!this.#test) for (const cb of this.#levelListeners) cb(l);
    let changed = false;
    if (l.gateOpen !== this.#gateOpen) {
      this.#gateOpen = l.gateOpen;
      changed = this.#effectiveMode() === "voice";
    }
    // "You're muted": voice for a moment while the mute button is on.
    const m = this.#effectiveMode();
    const muted = (m === "voice" || m === "open") && this.#muted && !this.#deafened && this.#canPublish;
    const now = performance.now();
    if (muted && l.voice) {
      this.#quietSince = null;
      this.#voiceSince ??= now;
      if (!this.#mutedTalking && now - this.#voiceSince > 300) {
        this.#mutedTalking = true;
        changed = true;
      }
    } else {
      this.#voiceSince = null;
      this.#quietSince ??= now;
      if (this.#mutedTalking && (!muted || now - this.#quietSince > 2000)) {
        this.#mutedTalking = false;
        changed = true;
      }
    }
    if (changed) this.#changed();
  }

  /** The mic level as voice activation sees it, about 30 times a second, from the call or the mic test; null when neither runs. */
  onMicLevel(cb: (l: MicLevel | null) => void): () => void {
    this.#levelListeners.add(cb);
    return () => this.#levelListeners.delete(cb);
  }

  get micTesting(): boolean {
    return !!this.#test;
  }

  /**
   * Mic test: plays the processed mic back on the chosen speakers, so you
   * hear what others would. Not during a call (the meter shows the call's
   * mic there).
   */
  async startMicTest(): Promise<void> {
    if (this.#test || this.#state !== "idle") return;
    const url = this.#opts.micWorkletUrl;
    const o = this.#captureOptions();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: o.deviceId && o.deviceId !== "default" ? { exact: o.deviceId } : undefined,
        echoCancellation: o.echoCancellation,
        noiseSuppression: o.noiseSuppression,
        autoGainControl: o.autoGainControl,
      },
    });
    const ctx = this.#audioContext(stream.getAudioTracks()[0]!);
    let chain: MicChain;
    try {
      if (!url) throw new Error("no mic worklet");
      chain = await MicChain.create(ctx, url, {});
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
    chain.connect(stream.getAudioTracks()[0]!);
    chain.onLevel((l) => {
      for (const cb of this.#levelListeners) cb(l);
    });
    const el = new Audio();
    el.srcObject = new MediaStream([chain.output]);
    el.volume = this.audioSettings.outputVolume;
    const out = this.#opts.store.get("voice.output");
    if (out && "setSinkId" in el) await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(out).catch(() => {});
    this.#test = { stream, chain, el };
    this.#configureChains();
    await el.play().catch(() => {});
    await this.#applyStrong(chain); // may start the test again, with the browser's filter
    this.#changed();
  }

  async stopMicTest(): Promise<void> {
    const t = this.#test;
    if (!t) return;
    this.#test = null;
    t.el.pause();
    t.el.srcObject = null;
    t.chain.destroy();
    t.stream.getTracks().forEach((x) => x.stop());
    for (const cb of this.#levelListeners) cb(null);
    this.#changed();
  }

  // ---------------------------------------------- per-person playback

  #volumeOf(id: string): number {
    const v = Number(this.#opts.store.get(`voice.volume.${id}`));
    return Number.isFinite(v) && this.#opts.store.get(`voice.volume.${id}`) !== null ? Math.min(1, Math.max(0, v)) : 1;
  }

  #localMutedOf(id: string): boolean {
    return this.#opts.store.get(`voice.localMute.${id}`) === "1";
  }

  #applyVolume(p: RemoteParticipant): void {
    const v = this.#deafened || this.#localMutedOf(p.identity) ? 0
      : this.#volumeOf(p.identity) * this.audioSettings.outputVolume;
    p.setVolume(v, Track.Source.Microphone);
    p.setVolume(v * this.#duckGain, Track.Source.ScreenShareAudio);
  }

  // ---------------------------------------------- ducking share sound

  /** Share sound's current multiplier: 1, or down to duckLevel while others talk. */
  #duckGain = 1;
  #duckTarget = 1;
  #duckReleaseAt = 0;
  #duckTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Someone else talking (as LiveKit's speaking signal says, the one behind
   * the speaking rings) turns every share's sound down on this device. Only
   * people this device can hear count: not locally muted ones, nobody while
   * deafened, never yourself. Fades down fast and back up slowly, after a
   * short hold, so gaps between words don't pump the volume.
   */
  #updateDuck(): void {
    const room = this.#room;
    const a = this.audioSettings;
    const talking = !!room && a.duckShare && !this.#deafened && room.activeSpeakers.some((s) =>
      s !== room.localParticipant && room.remoteParticipants.has(s.identity)
      && !this.#localMutedOf(s.identity) && this.#volumeOf(s.identity) > 0);
    if (talking) {
      this.#duckTarget = a.duckLevel;
      this.#duckReleaseAt = 0;
    } else if (this.#duckTarget < 1 && !this.#duckReleaseAt) {
      this.#duckReleaseAt = Date.now() + DUCK_HOLD_MS;
    }
    if (!room || !a.duckShare) {
      this.#duckTarget = 1;
      this.#duckReleaseAt = 0;
    }
    if (!this.#duckTimer && (this.#duckGain !== this.#duckTarget || this.#duckReleaseAt)) {
      this.#duckTimer = setInterval(() => this.#duckStep(), DUCK_STEP_MS);
    }
    this.#duckStep();
  }

  #duckStep(): void {
    if (this.#duckReleaseAt && Date.now() >= this.#duckReleaseAt) {
      this.#duckReleaseAt = 0;
      this.#duckTarget = 1;
    }
    const target = this.#duckTarget;
    const before = this.#duckGain;
    // Linear steps over the whole range: down in DUCK_ATTACK_MS, up in DUCK_RELEASE_MS.
    this.#duckGain = target < before
      ? Math.max(target, before - DUCK_STEP_MS / DUCK_ATTACK_MS)
      : Math.min(target, before + DUCK_STEP_MS / DUCK_RELEASE_MS);
    if (this.#duckGain !== before) {
      for (const p of this.#room?.remoteParticipants.values() ?? []) this.#applyVolume(p);
    }
    if (this.#duckGain === this.#duckTarget && !this.#duckReleaseAt && this.#duckTimer) {
      clearInterval(this.#duckTimer);
      this.#duckTimer = null;
    }
  }

  /** This device's playback volume for one person, 0..1. Remembered. */
  setUserVolume(id: string, volume: number): void {
    this.#opts.store.set(`voice.volume.${id}`, String(Math.min(1, Math.max(0, volume))));
    const p = this.#room?.remoteParticipants.get(id);
    if (p) this.#applyVolume(p);
    this.#updateDuck();
    this.#changed();
  }

  /** Silence one person on this device only. Remembered. */
  setUserMuted(id: string, muted: boolean): void {
    this.#opts.store.set(`voice.localMute.${id}`, muted ? "1" : "0");
    const p = this.#room?.remoteParticipants.get(id);
    if (p) this.#applyVolume(p);
    this.#updateDuck();
    this.#changed();
  }

  // ------------------------------------------------------------ devices

  /**
   * Until the page may use the microphone, browsers hide device names
   * and list one unnamed placeholder per kind. `ask` asks for the
   * microphone (the browser's prompt; the mic is released straight
   * away) so the real list comes back.
   */
  async listDevices(ask = false): Promise<AudioDevices> {
    const inputs = await Room.getLocalDevices("audioinput", ask);
    const outputs = await Room.getLocalDevices("audiooutput", false);
    const real = (l: MediaDeviceInfo[]) => l.filter((d) => d.deviceId !== "");
    return {
      inputs: real(inputs),
      outputs: real(outputs),
      named: inputs.some((d) => d.label !== ""),
      canPickOutput: typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
    };
  }

  get inputDevice(): string {
    return this.#opts.store.get("voice.input") ?? "default";
  }

  get outputDevice(): string {
    return this.#opts.store.get("voice.output") ?? "default";
  }

  async setInputDevice(id: string): Promise<void> {
    this.#opts.store.set("voice.input", id);
    if (this.#room && this.#mic) await this.#room.switchActiveDevice("audioinput", id);
    if (this.#test) {
      await this.stopMicTest();
      await this.startMicTest();
    }
  }

  async setOutputDevice(id: string): Promise<void> {
    this.#opts.store.set("voice.output", id);
    if (this.#room) await this.#room.switchActiveDevice("audiooutput", id);
  }

  get pinQuality(): boolean {
    return this.#opts.store.get("voice.pinQuality") === "1";
  }

  /** Always take the highest stream layer when watching. Applies on next join. */
  setPinQuality(on: boolean): void {
    this.#opts.store.set("voice.pinQuality", on ? "1" : "0");
  }

  // -------------------------------------------------------- screen share

  /**
   * Share a screen or window; the browser shows its own picker (a page
   * cannot preselect what to share). Rejects with NotAllowedError when
   * the picker is cancelled.
   */
  async startShare(s: ShareSettings): Promise<void> {
    const room = this.#room;
    if (!room || !this.#canPublish) throw new Error("you can't share here");
    if (this.#screenTracks.length) return;
    if (this.#shareBlocked(room)) throw new Error(SHARE_BLOCKED);
    // Held to the server's limit whatever was asked for, so an honest
    // client is never the one the server has to stop.
    const limit = await this.shareLimit();
    s = heldToLimit({ ...s, codec: shareCodec(s.codec) }, limit);
    const cap = await this.#capture(s, limit);
    if (this.#room !== room) {
      cap.release(); // left the call meanwhile
      return;
    }
    this.#stopWindowSound = cap.windowSound?.stop ?? null;
    this.#share = s;
    const tracks = cap.audio ? [cap.video, cap.audio] : [cap.video];
    this.#screenTracks = tracks;
    try {
      for (const track of tracks) {
        await room.localParticipant.publishTrack(track, track === cap.video ? shareOptions(s) : undefined);
        track.mediaStreamTrack.addEventListener("ended", this.#onShareEnded);
        // LiveKit (2.23) unpublishes a share whose capture ends, before
        // #onShareEnded could pause it: in the desktop app the picture's
        // end is ours to handle (checked by experiment, 2026-11-13).
        if (track === cap.video && this.#opts.desktopShare) track.removeAllListeners(TrackEvent.Ended);
      }
    } catch (err) {
      await this.stopShare();
      if (this.#shareBlocked(room)) throw new Error(SHARE_BLOCKED);
      throw err;
    }
    this.#changed();
  }

  /**
   * Share something else without ending the share (decisions.md, "Switch
   * stream"): the browser's (or the app's) picker opens again, and the new
   * capture replaces the old one inside the published track, so viewers
   * keep watching: same track, same Watch, same Listen. The sound follows
   * the new pick. Cancelling the picker leaves the share as it was
   * (rejects like startShare).
   */
  async switchShare(): Promise<void> {
    const room = this.#room;
    const video = this.#shareVideo();
    if (!room || !video || !this.#share) throw new Error("you aren't sharing");
    if (this.#shareBusy) return;
    this.#shareBusy = true;
    try {
      const limit = await this.shareLimit();
      const s = heldToLimit(this.#share, limit);
      const cap = await this.#capture(s, limit);
      if (this.#room !== room || this.#shareVideo() !== video) {
        cap.release(); // stopped or left meanwhile
        return;
      }
      // Picture: the old capture is stopped by LiveKit once replaced, and
      // the encodings are worked out again for the new size.
      const mst = cap.video.mediaStreamTrack;
      video.mediaStreamTrack.removeEventListener("ended", this.#onShareEnded);
      await video.replaceTrack(mst, { userProvidedTrack: false });
      mst.addEventListener("ended", this.#onShareEnded);
      this.#sharePaused = false;

      // Sound: swapped in place, added or taken down, as the new pick has it.
      const oldAudio = this.#screenTracks.find((t) => t.kind === Track.Kind.Audio) ?? null;
      // Server-muted: the old source's held sound is no use any more.
      this.#heldShareAudio?.stop();
      this.#heldShareAudio = null;
      if (cap.audio && oldAudio) {
        oldAudio.mediaStreamTrack.removeEventListener("ended", this.#onShareEnded);
        await oldAudio.replaceTrack(cap.audio.mediaStreamTrack, { userProvidedTrack: false });
        oldAudio.mediaStreamTrack.addEventListener("ended", this.#onShareEnded);
      } else if (oldAudio) {
        // Out of the list first, or the unpublish reads as a server mute.
        this.#screenTracks = this.#screenTracks.filter((t) => t !== oldAudio);
        try {
          await room.localParticipant.unpublishTrack(oldAudio, true);
        } catch {
          /* already gone */
        }
        oldAudio.stop();
      } else if (cap.audio) {
        try {
          await room.localParticipant.publishTrack(cap.audio);
          cap.audio.mediaStreamTrack.addEventListener("ended", this.#onShareEnded);
          this.#screenTracks = [...this.#screenTracks, cap.audio];
        } catch (err) {
          cap.audio.stop();
          this.#notice(`Couldn't share the new sound: ${errorText(err)}`);
        }
      }
      // Window sound: the new recording runs before the old one is let go
      // (desktopShareSound.ts: the old one then leaves the app alone).
      const oldStop = this.#stopWindowSound;
      this.#stopWindowSound = cap.windowSound?.stop ?? null;
      oldStop?.();
      this.#share = s;
    } finally {
      this.#shareBusy = false;
      this.#changed();
    }
  }

  /**
   * Change the running share's quality (preset size, frame rate, bitrate,
   * Detail or Motion) without ending it: the capture is asked for the new
   * size and the encoder for the new limits, in place. Held to the
   * server's limit like a new share.
   */
  async setShareQuality(q: ShareSettings): Promise<void> {
    const video = this.#shareVideo();
    if (!video || !this.#share) throw new Error("you aren't sharing");
    if (this.#shareBusy) throw new Error("the share is still changing; try again");
    this.#shareBusy = true;
    try {
      const limit = await this.shareLimit();
      // The encoder can't change while sharing (it would end the track).
      const s = heldToLimit({ ...q, audio: this.#share.audio, codec: this.#share.codec }, limit);
      if (this.#shareVideo() !== video) return;
      const mst = video.mediaStreamTrack;
      try {
        await mst.applyConstraints(captureSize(s));
      } catch (err) {
        console.warn("couldn't resize the share:", err);
      }
      if (limit) await capToLimit(video, limit);
      mst.contentHint = s.priority === "motion" ? "motion" : "detail";
      // LiveKit works the encodings out again when the track is "replaced"
      // (with itself here), from its publish options; forgetting the last
      // size makes it do so even when the size stayed the same (checked by
      // experiment: bitrate and frame rate change live, viewers stay).
      video.publishOptions = { ...video.publishOptions, ...shareOptions(s) };
      video.lastEncodedDimensions = undefined;
      await video.replaceTrack(mst, { userProvidedTrack: false });
      await video.setDegradationPreference(s.priority === "motion" ? "maintain-framerate" : "maintain-resolution");
      this.#share = s;
    } finally {
      this.#shareBusy = false;
      this.#changed();
    }
  }

  /** Which share encoders this browser can use (WebKit: H.264 only, see shareOptions). */
  shareEncoders(): Record<ShareCodec, boolean> {
    return { h264: WEBKIT || canShareH264(), vp8: !WEBKIT };
  }

  /** The running share's picture track. */
  #shareVideo(): LocalVideoTrack | undefined {
    return this.#screenTracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
  }

  /**
   * Opens the picker and captures what is chosen, with its sound: the
   * browser's, or in the desktop app a window's from the app's helper.
   * Server-muted: picture only (LiveKit would refuse the sound). Nothing
   * is published yet.
   */
  async #capture(s: ShareSettings, limit: ShareLimit | null): Promise<{
    video: LocalVideoTrack;
    audio: LocalTrack | null;
    windowSound: ShareSound | null;
    release: () => void;
  }> {
    const audioWanted = s.audio && !this.#serverMuted();
    const tracks = await createLocalScreenTracks({
      audio: audioWanted ? SHARE_AUDIO : false,
      resolution: { width: s.width, height: s.height, frameRate: s.fps },
    });
    const video = tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack;
    let audio: LocalTrack | null = tracks.find((t) => t.kind === Track.Kind.Audio) ?? null;
    // A window share in the desktop app: its sound comes separately.
    let windowSound: ShareSound | null = null;
    if (audioWanted && !audio && this.#opts.windowShareSound) {
      try {
        windowSound = await this.#opts.windowShareSound((reason) => {
          if (this.#stopWindowSound === windowSound?.stop && !this.#sharePaused) this.#notice(`Your share's sound stopped: ${reason}`);
        });
      } catch (err) {
        this.#notice(`Couldn't share the window's sound: ${errorText(err)}`);
      }
      if (windowSound) {
        audio = new LocalAudioTrack(windowSound.track, undefined, false);
        audio.source = Track.Source.ScreenShareAudio;
      }
    }
    if (limit) await capToLimit(video, limit);
    // Browsers tag screen capture "detail", which pins games near 15 fps
    // whatever the bitrate; "motion" flips the tradeoff.
    video.mediaStreamTrack.contentHint = s.priority === "motion" ? "motion" : "detail";
    return {
      video, audio, windowSound,
      release: () => {
        video.stop();
        audio?.stop();
        windowSound?.stop();
      },
    };
  }

  /** The server's screen share limit, asked afresh each time. */
  async shareLimit(): Promise<ShareLimit | null> {
    const data = (await this.#opts.call("/api/v1/voice/share-limit")) as { limit: ShareLimit | null };
    return data.limit ?? null;
  }

  /** The server took away screen sharing for this call (over the limit). */
  #shareBlocked(room: Room): boolean {
    const sources = room.localParticipant.permissions?.canPublishSources ?? [];
    return sources.length > 0 && !sources.includes(SOURCE_SCREEN_SHARE);
  }

  /** Unmuted mid-share: send the share's sound again. */
  async #restoreShareAudio(room: Room): Promise<void> {
    const track = this.#heldShareAudio;
    if (!track || this.#room !== room || !this.#screenTracks.length) return;
    const sources = room.localParticipant.permissions?.canPublishSources ?? [];
    if (sources.length && !sources.includes(SOURCE_SCREEN_SHARE_AUDIO)) return;
    this.#heldShareAudio = null;
    try {
      await room.localParticipant.publishTrack(track);
      this.#screenTracks = [...this.#screenTracks, track];
    } catch (err) {
      track.stop();
      this.#notice(`Couldn't turn your share's sound back on: ${errorText(err)}`);
    }
    this.#changed();
  }

  /**
   * The shared window closed (desktop app): viewers get a still "paused"
   * picture, and the app answers the next pick itself, with the game's
   * other window (Smart Switch) or its picker. Cancelling the picker ends
   * the share.
   */
  async #shareGone(): Promise<void> {
    const video = this.#shareVideo();
    const ds = this.#opts.desktopShare;
    if (!video || !ds || this.#sharePaused) return;
    this.#sharePaused = true;
    video.mediaStreamTrack.removeEventListener("ended", this.#onShareEnded);
    try {
      await video.replaceTrack(ds.pausedTrack(), { userProvidedTrack: false });
    } catch (err) {
      console.warn("couldn't show the paused picture:", err);
    }
    this.#changed();
    if (this.#shareVideo() !== video) return; // stopped meanwhile
    ds.gone();
    try {
      // While another switch runs this returns at once; that one ends the pause.
      await this.switchShare();
    } catch {
      if (this.#sharePaused && this.#shareVideo() === video) await this.stopShare();
    }
  }

  async stopShare(): Promise<void> {
    const tracks = this.#screenTracks;
    this.#screenTracks = [];
    if (tracks.length) this.#opts.desktopShare?.stopped();
    this.#sharePaused = false;
    this.#heldShareAudio?.stop();
    this.#heldShareAudio = null;
    this.#stopWindowSound?.();
    this.#stopWindowSound = null;
    this.#share = null;
    for (const t of tracks) {
      try {
        await this.#room?.localParticipant.unpublishTrack(t, true);
      } catch {
        /* already gone */
      }
      t.stop();
    }
    this.#changed();
  }

  #screenTrack(id: string): Track | undefined {
    const room = this.#room;
    if (!room) return undefined;
    for (const p of [room.localParticipant as Participant, ...room.remoteParticipants.values()]) {
      const pub = p.trackPublications.get(id);
      if (pub?.track) return pub.track;
    }
    return undefined;
  }

  /** Show a screen share in a video element. Your own is muted locally. */
  /**
   * Shows a share in a video element. Someone else's share is received
   * only while at least one element shows it.
   */
  attachScreen(id: string, el: HTMLVideoElement): void {
    clearTimeout(this.#unwatch.get(id));
    this.#unwatch.delete(id);
    let els = this.#screenEls.get(id);
    if (!els) this.#screenEls.set(id, (els = new Set()));
    els.add(el);
    // Asked for every time (it may have been let go a moment ago); if the
    // picture isn't here yet, TrackSubscribed attaches it.
    this.#remoteScreenPub(id)?.setSubscribed(true);
    const t = this.#screenTrack(id);
    if (!t) return;
    el.muted = true;
    el.playsInline = true;
    t.attach(el);
  }

  detachScreen(id: string, el: HTMLVideoElement): void {
    this.#screenTrack(id)?.detach(el);
    const els = this.#screenEls.get(id);
    els?.delete(el);
    if (!els || els.size > 0) return;
    clearTimeout(this.#unwatch.get(id));
    this.#unwatch.set(id, setTimeout(() => {
      this.#unwatch.delete(id);
      if (this.#screenEls.get(id)?.size) return;
      this.#screenEls.delete(id);
      this.#remoteScreenPub(id)?.setSubscribed(false);
    }, 1500));
  }

  /** Plays or silences someone's share sound (Listen). */
  setShareListening(participantId: string, on: boolean): void {
    if (on) this.#listening.add(participantId);
    else this.#listening.delete(participantId);
    if (this.#room) this.#subscribeWanted(this.#room);
    this.#changed();
  }

  #remoteScreenPub(id: string): RemoteTrackPublication | undefined {
    for (const p of this.#room?.remoteParticipants.values() ?? []) {
      const pub = p.trackPublications.get(id);
      if (pub && pub.source === Track.Source.ScreenShare) return pub;
    }
    return undefined;
  }

  /**
   * Subscribes to what should be playing: every microphone, and the share
   * sound of people you chose to listen to. Pictures are handled by
   * attachScreen. Safe to call any time.
   */
  #subscribeWanted(room: Room): void {
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        let want: boolean | null = null;
        if (pub.source === Track.Source.Microphone) want = true;
        else if (pub.source === Track.Source.ScreenShareAudio) want = this.#listening.has(p.identity);
        else if (pub.source === Track.Source.ScreenShare) want = this.#screenEls.has(pub.trackSid);
        else if (pub.kind === Track.Kind.Audio) want = true; // unknown audio: as before
        if (want !== null && pub.isSubscribed !== want) pub.setSubscribed(want);
      }
    }
  }

  /**
   * Bytes the call has sent and received so far, all media and control
   * traffic, from WebRTC's transport statistics (what actually went over
   * the network, encryption and packet headers included). Null when not
   * in a call. The totals restart with each call; callers measure rates
   * between calls to this, about once a second.
   */
  async trafficBytes(): Promise<{ sent: number; received: number } | null> {
    const pcs = (this.#room as unknown as { engine?: { pcManager?: { publisher?: Stats; subscriber?: Stats } } } | null)
      ?.engine?.pcManager;
    if (!pcs) return null;
    let sent = 0;
    let received = 0;
    // One peer connection or two, depending on LiveKit's mode.
    const seen = new Set<Stats>();
    for (const pc of [pcs.publisher, pcs.subscriber]) {
      if (!pc || seen.has(pc)) continue;
      seen.add(pc);
      try {
        const report = await pc.getStats();
        report?.forEach((r: { type: string; bytesSent?: number; bytesReceived?: number }) => {
          if (r.type !== "transport") return;
          sent += r.bytesSent ?? 0;
          received += r.bytesReceived ?? 0;
        });
      } catch {
        /* closed mid-read */
      }
    }
    return { sent, received };
  }

  /**
   * What a share is actually doing, for the stats line, sent (your own)
   * or received: frame rate and bitrate (with your own share's caps), the
   * encoder or decoder, and frames dropped since the stats were first
   * asked for. Call about once a second; bitrates are measured between
   * calls.
   */
  async screenStats(id: string, el?: HTMLVideoElement): Promise<ScreenStats> {
    const t = this.#screenTrack(id);
    const out: ScreenStats = { fps: null, maxFps: null, kbps: null, maxKbps: null, codec: null, coder: null, hardware: null, fmtp: null, dropped: 0 };
    if (!t) return out;
    const local = t === this.#shareVideo();
    if (local) {
      // Caps over every copy: the best frame rate and the total bitrate.
      for (const e of (t as LocalTrack).sender?.getParameters().encodings ?? []) {
        if (e.maxFramerate) out.maxFps = Math.max(out.maxFps ?? 0, Math.round(e.maxFramerate));
        if (e.maxBitrate) out.maxKbps = (out.maxKbps ?? 0) + Math.round(e.maxBitrate / 1000);
      }
    }
    let bytes = 0;
    let dropped = 0;
    let captured = 0;
    let encoded = 0;
    let best = -1; // frame width of the copy the encoder line describes
    type Rtp = {
      type: string; kind?: string; codecId?: string; mimeType?: string; sdpFmtpLine?: string; id: string;
      bytesSent?: number; bytesReceived?: number; framesPerSecond?: number; frameWidth?: number;
      frames?: number; framesEncoded?: number; framesDropped?: number;
      encoderImplementation?: string; decoderImplementation?: string;
      powerEfficientEncoder?: boolean; powerEfficientDecoder?: boolean;
    };
    try {
      const report = await (t as unknown as { getRTCStatsReport?: () => Promise<RTCStatsReport | undefined> }).getRTCStatsReport?.();
      const codecs = new Map<string, { mime: string; fmtp: string | null }>();
      report?.forEach((r: Rtp) => {
        if (r.type === "codec" && r.mimeType) codecs.set(r.id, { mime: r.mimeType, fmtp: r.sdpFmtpLine ?? null });
      });
      // Simulcast reports one outbound-rtp per copy: bytes add up, the
      // frame rate and the encoder are the best copy's.
      report?.forEach((r: Rtp) => {
        if (r.kind !== "video") return;
        if (r.type === "media-source") captured = r.frames ?? 0;
        if (r.type !== "outbound-rtp" && r.type !== "inbound-rtp") return;
        bytes += (r.type === "outbound-rtp" ? r.bytesSent : r.bytesReceived) ?? 0;
        if (r.framesPerSecond !== undefined) out.fps = Math.max(out.fps ?? 0, Math.round(r.framesPerSecond));
        if (r.type === "outbound-rtp") encoded = Math.max(encoded, r.framesEncoded ?? 0);
        else dropped += r.framesDropped ?? 0;
        const w = r.frameWidth ?? 0;
        if (w > best) {
          best = w;
          const c = r.codecId ? codecs.get(r.codecId) : undefined;
          out.codec = c ? codecName(c.mime) : out.codec;
          out.fmtp = c?.fmtp ?? out.fmtp;
          // Chrome only names these to a page that is capturing (the mic
          // in a call; found by experiment): otherwise they stay null.
          out.coder = r.encoderImplementation ?? r.decoderImplementation ?? null;
          out.hardware = r.powerEfficientEncoder ?? r.powerEfficientDecoder ?? null;
        }
      });
    } catch {
      /* stats unavailable in this browser */
    }
    // Dropped: your own share, captured frames the encoder skipped (CPU or
    // bandwidth); someone else's, frames the decoder or the screen dropped.
    if (local) dropped = Math.max(0, captured - encoded);
    else dropped += el?.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
    const now = performance.now();
    const prev = this.#stats.get(id);
    if (prev && now > prev.at) {
      const secs = (now - prev.at) / 1000;
      out.kbps = Math.max(0, Math.round(((bytes - prev.bytes) * 8) / secs / 1000));
    }
    const base = prev?.droppedBase ?? dropped;
    out.dropped = Math.max(0, dropped - base);
    this.#stats.set(id, { bytes, at: now, droppedBase: base });
    return out;
  }
}

/** "video/H264" as people know it: H.264, VP8, VP9, AV1. */
function codecName(mime: string): string {
  const n = mime.replace(/^video\//i, "");
  return /^h264$/i.test(n) ? "H.264" : n.toUpperCase();
}

type Stats = { getStats(): Promise<RTCStatsReport> | undefined };
