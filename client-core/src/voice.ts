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
  VideoPreset,
  VideoQuality,
  createLocalAudioTrack,
  createLocalScreenTracks,
  isE2EESupported,
  type LocalAudioTrack,
  type LocalTrack,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
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
}

export interface ScreenShare {
  /** Track SID; pass to attachScreen. */
  readonly id: string;
  readonly participantId: string;
  readonly name: string;
  readonly isLocal: boolean;
}

export interface VoiceSnapshot {
  readonly state: "idle" | "connecting" | "connected";
  readonly channelId: string | null;
  readonly participants: readonly VoiceParticipant[];
  readonly screens: readonly ScreenShare[];
  /** May speak and share (post permission in the channel). */
  readonly canPublish: boolean;
  /** The mute button (ignored in push-to-talk mode). */
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly pttMode: boolean;
  /** The channel requires push-to-talk. */
  readonly forcePTT: boolean;
  /** Push-to-talk key held right now. */
  readonly pttHeld: boolean;
  /** This device is sending audio right now. */
  readonly micOpen: boolean;
  readonly sharing: boolean;
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
  codec: "h264" | "vp8" | "vp9" | "av1";
  simulcast: boolean;
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

/** LiveKit's TrackSource.SCREEN_SHARE (protocol enum value). */
const SOURCE_SCREEN_SHARE = 3;

const SHARE_BLOCKED =
  "Screen sharing is blocked until you rejoin the call: your last share was above this server's quality limit.";

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
}

/** Which audio devices exist; labels are empty until mic permission. */
export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  /** The browser can route output to a chosen device (not Firefox/Safari). */
  canPickOutput: boolean;
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

// ------------------------------------------------------------ media keys

const MEDIA_KEYRING = 16;
/** How long the previous epoch's media key keeps working after a change. */
const MEDIA_KEY_HANDOVER_MS = 10_000;

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
  #offAuto: (() => void) | null = null;
  /** Per person: when the current run of decryption errors began, and the last one. */
  #decryptErrors = new Map<string, { since: number; last: number; told: boolean }>();

  #mic: LocalAudioTrack | null = null;
  #screenTracks: LocalTrack[] = [];
  #canPublish = false;
  #muted = false;
  #deafened = false;
  #pttMode: boolean;
  #forcePTT = false;
  #pttHeld = false;
  #audioBlocked = false;
  #endReason: string | null = null;
  #lastEnd: string | null = null;
  #notices: string[] = [];
  #audioEls = new Map<string, HTMLMediaElement>();
  #stats = new Map<string, { bytes: number; frames: number; at: number }>();

  constructor(session: Session, opts: VoiceOptions) {
    this.#session = session;
    this.#opts = opts;
    this.#pttMode = opts.store.get("voice.ptt") === "1";
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
          const vids = [...p.videoTrackPublications.values()]
            .filter((pub) => pub.source === Track.Source.ScreenShare && pub.track);
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
          });
          for (const pub of vids) {
            screens.push({ id: pub.trackSid, participantId: p.identity, name: p.name || p.identity, isLocal: local });
          }
        }
      }
      this.#snapshot = {
        state: this.#state,
        channelId: this.#channelId,
        participants: people,
        screens,
        canPublish: this.#canPublish,
        muted: this.#muted,
        deafened: this.#deafened,
        pttMode: this.#pttMode || this.#forcePTT,
        forcePTT: this.#forcePTT,
        pttHeld: this.#pttHeld,
        micOpen: this.#micOpen(),
        sharing: this.#screenTracks.length > 0,
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
    this.#lastEnd = null;
    this.#endReason = null;
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
      });
      this.#room = room;
      // Before connect, so nothing is ever published unencrypted.
      await room.setE2EEEnabled(true);
      this.#wire(room, pinned);

      await room.connect(data.url, data.token);
      this.#canPublish = data.can_publish;
      this.#forcePTT = data.force_ptt;
      this.#state = "connected";
      this.#audioBlocked = !room.canPlaybackAudio;

      if (data.can_publish) {
        const input = this.#opts.store.get("voice.input") ?? undefined;
        this.#mic = await createLocalAudioTrack({
          deviceId: input,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
        // Silent while publishing, so push-to-talk never leaks a moment of
        // audio; then muted properly (which also tells the others) or opened.
        this.#mic.mediaStreamTrack.enabled = false;
        await room.localParticipant.publishTrack(this.#mic);
        if (this.#micOpen()) this.#mic.mediaStreamTrack.enabled = true;
        else await this.#mic.mute();
        this.#changed();
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
    this.#mic?.stop();
    this.#mic = null;
    for (const el of this.#audioEls.values()) el.remove();
    this.#audioEls.clear();
    this.#stats.clear();
    this.#decryptErrors.clear();
    this.#worker?.terminate(); // LiveKit leaves the worker to its owner
    this.#worker = null;
    this.#keys?.stop();
    this.#keys = null;
    this.#epoch = null;
    this.#room = null;
    this.#state = "idle";
    this.#channelId = null;
    this.#canPublish = false;
    this.#forcePTT = false;
    this.#pttHeld = false;
    this.#audioBlocked = false;
  }

  #describeEnd(reason?: DisconnectReason): string {
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
        this.#changed();
      })
      .on(RoomEvent.ParticipantEncryptionStatusChanged, this.#changed)
      .on(RoomEvent.ActiveSpeakersChanged, this.#changed)
      .on(RoomEvent.TrackMuted, this.#changed)
      .on(RoomEvent.TrackUnmuted, this.#changed)
      .on(RoomEvent.LocalTrackPublished, this.#changed)
      .on(RoomEvent.LocalTrackUnpublished, (pub: { track?: Track }) => {
        // The server (or LiveKit) took a share down without us: release
        // the capture too, or the browser goes on sharing to nobody.
        if (pub.track && this.#screenTracks.includes(pub.track as LocalTrack)) {
          void this.stopShare();
        }
        this.#changed();
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev: unknown, p: Participant) => {
        if (p !== room.localParticipant) return;
        if (this.#shareBlocked(room)) {
          if (this.#screenTracks.length) void this.stopShare();
          this.#notice("Your screen share was stopped: it was above this server's quality limit. Rejoin the call to share again.");
        }
        this.#changed();
      })
      .on(RoomEvent.TrackPublished, this.#changed)
      .on(RoomEvent.TrackUnpublished, this.#changed)
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
        } else if (track.source === Track.Source.ScreenShare && pinned) {
          // With adaptiveStream off nothing picks a layer: ask for the top.
          try {
            pub.setVideoQuality(VideoQuality.HIGH);
          } catch {
            /* not simulcast */
          }
        }
        this.#changed();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
        track.detach().forEach((el) => el.remove());
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

  #micOpen(): boolean {
    if (!this.#mic || !this.#canPublish || this.#deafened) return false;
    return this.#pttMode || this.#forcePTT ? this.#pttHeld : !this.#muted;
  }

  async #applyMic(): Promise<void> {
    const mic = this.#mic;
    if (!mic) return;
    const open = this.#micOpen();
    if (open && mic.isMuted) await mic.unmute();
    else if (!open && !mic.isMuted) await mic.mute();
    this.#changed();
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
    for (const p of this.#room?.remoteParticipants.values() ?? []) this.#applyVolume(p);
    return this.#applyMic();
  }

  /** Switch push-to-talk on or off (stays on when the channel forces it). */
  setPTTMode(on: boolean): Promise<void> {
    this.#pttMode = on;
    this.#opts.store.set("voice.ptt", on ? "1" : "0");
    this.#pttHeld = false;
    return this.#applyMic();
  }

  /** The push-to-talk key went down (true) or up (false). */
  setPTTHeld(held: boolean): void {
    if (held === this.#pttHeld) return;
    this.#pttHeld = held;
    void this.#applyMic();
  }

  /** The channel's settings changed (force push-to-talk). */
  setForcePTT(force: boolean): void {
    if (this.#state === "idle" || force === this.#forcePTT) return;
    this.#forcePTT = force;
    this.#pttHeld = false;
    void this.#applyMic();
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
    const v = this.#deafened || this.#localMutedOf(p.identity) ? 0 : this.#volumeOf(p.identity);
    p.setVolume(v, Track.Source.Microphone);
    p.setVolume(v, Track.Source.ScreenShareAudio);
  }

  /** This device's playback volume for one person, 0..1. Remembered. */
  setUserVolume(id: string, volume: number): void {
    this.#opts.store.set(`voice.volume.${id}`, String(Math.min(1, Math.max(0, volume))));
    const p = this.#room?.remoteParticipants.get(id);
    if (p) this.#applyVolume(p);
    this.#changed();
  }

  /** Silence one person on this device only. Remembered. */
  setUserMuted(id: string, muted: boolean): void {
    this.#opts.store.set(`voice.localMute.${id}`, muted ? "1" : "0");
    const p = this.#room?.remoteParticipants.get(id);
    if (p) this.#applyVolume(p);
    this.#changed();
  }

  // ------------------------------------------------------------ devices

  async listDevices(): Promise<AudioDevices> {
    const [inputs, outputs] = await Promise.all([
      Room.getLocalDevices("audioinput", false),
      Room.getLocalDevices("audiooutput", false),
    ]);
    return {
      inputs,
      outputs,
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
    if (limit) {
      s = { ...s, fps: Math.min(s.fps, limit.fps), kbps: Math.min(s.kbps, limit.kbps) };
    }

    const tracks = await createLocalScreenTracks({
      audio: s.audio,
      resolution: { width: s.width, height: s.height, frameRate: s.fps },
    });
    if (this.#room !== room) {
      for (const t of tracks) t.stop(); // left the call meanwhile
      return;
    }
    this.#screenTracks = tracks;
    if (limit) {
      for (const t of tracks) if (t.kind === Track.Kind.Video) await capToLimit(t, limit);
    }
    // Browsers tag screen capture "detail", which pins games near 15 fps
    // whatever the bitrate; "motion" flips the tradeoff.
    const hint = s.priority === "motion" ? "motion" : "detail";
    const encoding = { maxBitrate: s.kbps * 1000, maxFramerate: s.fps };
    try {
      for (const track of tracks) {
        if (track.kind === Track.Kind.Video) track.mediaStreamTrack.contentHint = hint;
        await this.#publishShare(room, track, s, encoding);
        // The browser's own "Stop sharing" bar bypasses our button.
        track.mediaStreamTrack.addEventListener("ended", () => void this.stopShare());
      }
    } catch (err) {
      await this.stopShare();
      if (this.#shareBlocked(room)) throw new Error(SHARE_BLOCKED);
      throw err;
    }
    this.#changed();
  }

  #publishShare(room: Room, track: LocalTrack, s: ShareSettings, encoding: { maxBitrate: number; maxFramerate: number }) {
    return room.localParticipant.publishTrack(track, {
        // Screen-share tracks read screenShareEncoding, NOT videoEncoding;
        // setting only the latter leaves 1080p15 at 1.5 Mbps in place.
        screenShareEncoding: encoding,
        videoEncoding: encoding,
        simulcast: s.simulcast,
        // Two layers: full quality, and half resolution for anyone who
        // can't keep up (only used with simulcast on).
        screenShareSimulcastLayers: [
          new VideoPreset(Math.round(s.width / 2), Math.round(s.height / 2),
            Math.round(s.kbps * 1000 * 0.3), Math.min(s.fps, 30)),
        ],
        // H.264 is hardware-decoded nearly everywhere, iOS included.
        videoCodec: s.codec,
        degradationPreference: s.priority === "motion" ? "maintain-framerate" : "maintain-resolution",
      });
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

  async stopShare(): Promise<void> {
    const tracks = this.#screenTracks;
    this.#screenTracks = [];
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
  attachScreen(id: string, el: HTMLVideoElement): void {
    const t = this.#screenTrack(id);
    if (!t) return;
    el.muted = true;
    el.playsInline = true;
    t.attach(el);
  }

  detachScreen(id: string, el: HTMLVideoElement): void {
    this.#screenTrack(id)?.detach(el);
  }

  /**
   * What a share is actually doing, for the stats line: frame size, frame
   * rate and bitrate, sent (your own) or received. Call about once a
   * second; rates are measured between calls.
   */
  async screenStats(id: string, el?: HTMLVideoElement): Promise<{ width: number; height: number; fps: number | null; kbps: number | null; dropped: number }> {
    const t = this.#screenTrack(id);
    const out = { width: el?.videoWidth ?? 0, height: el?.videoHeight ?? 0, fps: null as number | null, kbps: null as number | null, dropped: 0 };
    if (!t) return out;
    let bytes = 0;
    let frames = 0;
    try {
      const report = await (t as unknown as { getRTCStatsReport?: () => Promise<RTCStatsReport | undefined> }).getRTCStatsReport?.();
      // Simulcast reports one outbound-rtp per layer: sum before diffing.
      report?.forEach((r: { type: string; kind?: string; bytesSent?: number; bytesReceived?: number; framesSent?: number; framesDecoded?: number; frameWidth?: number; frameHeight?: number }) => {
        if (r.kind !== "video") return;
        if (r.type === "outbound-rtp") {
          bytes += r.bytesSent ?? 0;
          frames = Math.max(frames, r.framesSent ?? 0);
          if (!out.width && r.frameWidth) {
            out.width = r.frameWidth;
            out.height = r.frameHeight ?? 0;
          }
        } else if (r.type === "inbound-rtp") {
          bytes += r.bytesReceived ?? 0;
          frames += r.framesDecoded ?? 0;
        }
      });
    } catch {
      /* stats unavailable in this browser */
    }
    const q = el?.getVideoPlaybackQuality?.();
    if (q) out.dropped = q.droppedVideoFrames;
    const now = performance.now();
    const prev = this.#stats.get(id);
    if (prev && now > prev.at) {
      const secs = (now - prev.at) / 1000;
      out.kbps = Math.max(0, Math.round(((bytes - prev.bytes) * 8) / secs / 1000));
      out.fps = Math.max(0, Math.round((frames - prev.frames) / secs));
    }
    this.#stats.set(id, { bytes, frames, at: now });
    return out;
  }
}
