// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CommitResult, MemberLeaf, MlsProvider, WireMessage } from "./mls/provider.js";
import {
  encodeState,
  restoreState,
  encodeTree,
  decodeTree,
  epochOf,
  groupIdOf,
} from "./mls/tsmls.js";
import { storage } from "./storage.js";
import type { ApiCall } from "./identity.js";

/**
 * MLS group lifecycle for encrypted channels.
 *
 * One group per channel. The client owns all of it: the server orders
 * commits by epoch and stores opaque blobs, and can read none of it.
 *
 * Every MLS operation returns new state rather than mutating, so the
 * pattern throughout is: perform, persist, then act on the result. The
 * persist step is not optional - a state advanced in memory but not
 * written is a group this device can no longer participate in after a
 * reload, with no way to recover but to be re-added.
 */

/** How many times to rebase a commit that lost an epoch race. */
const MAX_COMMIT_ATTEMPTS = 4;

/**
 * How many times open() looks again after losing a race to join or
 * replace a group (someone committed, joined or reset in between).
 */
const MAX_OPEN_ATTEMPTS = 3;

/**
 * Separates the channel ID from the generation in an MLS group ID.
 *
 * A replaced group (see #reset) gets a new group ID, so a device holding
 * the old group's state can tell the two apart. Generation 0 is the bare
 * channel ID, which is what every group created before resets existed
 * already uses.
 */
const GENERATION_SEP = "#";

/** Exporter label for voice and screen-share keys. Changing it changes every key. */
const MEDIA_KEY_LABEL = "OpenVoxa media key v1";

/**
 * 32 bytes of input keying material. LiveKit runs it through HKDF to get
 * the actual AES-GCM frame key, so this only needs to be uniformly random
 * and at least as long as the key it feeds.
 */
const MEDIA_KEY_BYTES = 32;

export type GroupStatus =
  | "ready"
  | "created"
  | "joined"
  | "awaiting_invite"
  | "unavailable";

export interface OpenResult {
  readonly status: GroupStatus;
  readonly epoch: number;
  readonly detail?: string;
  /**
   * How a "joined" device got in: a member added it ("welcome"), or it
   * joined on its own from the published GroupInfo ("external").
   */
  readonly via?: "welcome" | "external";
  /**
   * The group this device knew, or the one on the server, was replaced
   * (decisions.md, "replaced, not rescued"). Set on "created" when this
   * device did the replacing, and on any result when it found its old
   * state belonged to a replaced group. Messages it had not already
   * decrypted can no longer be read.
   */
  readonly replaced?: boolean;
}

interface ServerGroupState {
  exists: boolean;
  epoch: number;
  generation: number;
  group_info_epoch: number | null;
  reason?: string;
}

/** GET /channels/{id}/mls/group-info. */
interface GroupInfoResponse {
  generation: number;
  epoch: number;
  group_info_epoch: number | null;
  /** Base64; empty when no member has uploaded one. */
  group_info: string;
}

/**
 * Outcome of reconcile, by device ID.
 *
 * removed: leaves taken out because their device lost access (or was a
 *   stale duplicate of this device).
 * added: devices that joined in this reconcile's add commit.
 * skipped: devices that belong in the group but could not be added,
 *   usually because they have no key package left to claim.
 */
export interface ReconcileResult {
  epoch: number;
  removed: string[];
  added: string[];
  skipped: string[];
}

/**
 * What a background reconcile reports. See Groups.reconcileSoon.
 *
 * reconciled: a run finished; result says what changed (often nothing).
 * removed: this device turned out not to be in the group any more. Its
 *   state is gone; opening the channel again rejoins if re-added.
 *   replaced: it is out because the whole group was replaced, not
 *   because it lost access, so opening again rejoins straight away.
 * error: the run failed for a reason worth showing.
 *
 * A run where this device may no longer view the channel reports
 * nothing: it is not a member that could commit anyway, and the server
 * tells it about the lost access separately.
 */
export type AutoEvent =
  | { kind: "reconciled"; channelId: string; result: ReconcileResult }
  | { kind: "removed"; channelId: string; replaced: boolean }
  | { kind: "error"; channelId: string; error: unknown };

/**
 * A device named in a membership notice.
 *
 * deviceId comes from the MLS credential in the ratchet tree and is the
 * part that cannot be faked by the server. The rest is the server's claim
 * about who owns it, and is missing if the lookup failed.
 */
export interface DeviceInfo {
  deviceId: string;
  userId?: string;
  username?: string;
  label?: string;
  revoked?: boolean;
}

/**
 * Who joined or left a group in one commit.
 *
 * Worked out by this device from its own group state before and after
 * the commit, never from anything the server says, so a device cannot
 * be added without every member seeing it (decisions.md, Known tensions).
 * Reported for commits this device made and for ones it caught up on,
 * including those made while it was offline.
 *
 * by: the device that submitted the commit, null when not recorded.
 * self: this device made the commit.
 */
export interface MembershipChange {
  channelId: string;
  epoch: number;
  joined: DeviceInfo[];
  left: DeviceInfo[];
  by: DeviceInfo | null;
  self: boolean;
}

/** A change still holding raw device IDs; see #announce. */
interface RawChange {
  channelId: string;
  epoch: number;
  joined: string[];
  left: string[];
  by: string | null;
}

/** Wait after the first trigger, so a burst of events costs one run. */
const RECONCILE_DEBOUNCE_MS = 300;

/** Extra wait per member ranked ahead of this device; see reconcileSoon. */
const RECONCILE_STAGGER_MS = 1500;

/** Rank beyond which the wait stops growing. */
const RECONCILE_MAX_RANK = 8;

/** Random spread, so devices at the same computed wait do not collide. */
const RECONCILE_JITTER_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * This device is no longer in the group. Its local state has been
 * discarded; opening the channel again joins afresh if a welcome is
 * waiting.
 */
export class RemovedFromGroup extends Error {
  constructor(readonly channelId: string) {
    super("groups: this device was removed from the channel's encryption group");
    this.name = "RemovedFromGroup";
  }
}

/**
 * The channel's group was replaced while this device held the old one
 * (decisions.md, "replaced, not rescued"). Its state is gone, as with any
 * removal, but it has not lost access: opening the channel joins the new
 * group.
 */
export class GroupReset extends RemovedFromGroup {
  constructor(channelId: string) {
    super(channelId);
    this.name = "GroupReset";
    this.message = "groups: this channel's encryption group was replaced; rejoin it";
  }
}

/** One entry of GET /channels/{id}/mls/allowed-devices. */
interface AllowedDevice {
  device_id: string;
  user_id: string;
  username: string;
  label: string;
}

/**
 * What a commit builder hands back: either a commit to submit, or
 * nothing to do on this state (someone else's commit already did it).
 */
type Built<T> =
  | { commit: CommitResult; welcomeTo: string[]; done: T }
  | { nothing: T };

interface PendingWelcome {
  id: number;
  channel_id: string;
  welcome: string;
  ratchet_tree: string;
  epoch: number;
}

interface HandshakeEntry {
  epoch: number;
  sender_device_id: string | null;
  blob: string;
}

interface ClaimedPackage {
  device_id: string;
  label: string;
  package: string;
  was_last_resort: boolean;
}

interface ClaimResponse {
  packages: ClaimedPackage[];
  already_in_group: string[];
}

/** A claimed package plus whose it is, so results can be reported per user. */
interface PendingAdd extends ClaimedPackage {
  user_id: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Thrown when the server rejected a commit because the epoch moved. */
class EpochConflict extends Error {
  constructor(readonly serverEpoch: number) {
    super(`epoch conflict; server is at ${serverEpoch}`);
  }
}

export class Groups {
  readonly #mls: MlsProvider;
  readonly #call: ApiCall;
  readonly #deviceId: string;

  /** Live group state per channel, mirrored to IndexedDB after every change. */
  readonly #states = new Map<string, unknown>();

  /** Tail of each channel's operation queue; see #serial. */
  readonly #queues = new Map<string, Promise<unknown>>();

  /** Channels with a background reconcile scheduled or running. */
  readonly #autoBusy = new Set<string>();

  /** Channels that were triggered again while their run was busy. */
  readonly #autoAgain = new Set<string>();

  readonly #autoListeners = new Set<(event: AutoEvent) => void>();

  readonly #membershipListeners = new Set<(change: MembershipChange) => void>();

  /** Who owns each device ID seen so far; see #describe. */
  readonly #names = new Map<string, DeviceInfo>();

  /** Notices are named and delivered strictly in order through this. */
  #notices: Promise<void> = Promise.resolve();

  constructor(mls: MlsProvider, call: ApiCall, deviceId: string) {
    this.#mls = mls;
    this.#call = call;
    this.#deviceId = deviceId;
  }

  /**
   * Make this device a working member of a channel's group.
   *
   * In the order they are attempted: already a member, so catch up; no
   * group exists, so create one; a member added this device, so join
   * from the welcome; otherwise join on its own from the GroupInfo the
   * group publishes (external commit); and if there is no usable
   * GroupInfo, nobody with access can commit to the group any more, so
   * replace it (decisions.md, "replaced, not rescued").
   *
   * Joining from the GroupInfo does not wait for a member to come along
   * and add this device. It is announced and access-checked exactly like
   * an add, uses no key package, and works whether or not anyone is
   * online. If a member's add lands first, the external commit loses the
   * epoch race and the next attempt takes the welcome instead.
   */
  async open(channelId: string): Promise<OpenResult> {
    return this.#serial(channelId, () => this.#open(channelId, 0));
  }

  async #open(channelId: string, attempt: number): Promise<OpenResult> {
    let remote = await this.#remote(channelId);
    let replaced = false;

    const stored = (await storage.getGroup(channelId)) as Uint8Array | undefined;
    if (stored) {
      const state = restoreState(stored);
      if (remote.exists && this.#generationOf(channelId, state) !== remote.generation) {
        // Replaced while this device was away. Nothing in the old state
        // applies to the new group.
        await this.#forget(channelId);
        replaced = true;
      } else {
        this.#states.set(channelId, state);
        try {
          const epoch = await this.#catchUp(channelId);
          // A group created before external join existed has no
          // GroupInfo until someone commits; any member can fill it in.
          await this.#publishGroupInfo(channelId, remote).catch(() => undefined);
          return { status: "ready", epoch };
        } catch (err) {
          // Removed while we were away, or the group was replaced. The
          // stale state is already gone; carry on as a newcomer.
          if (!(err instanceof RemovedFromGroup)) throw err;
          replaced = err instanceof GroupReset;
          remote = await this.#remote(channelId);
        }
      }
    }

    if (!remote.exists) {
      return this.#create(channelId);
    }

    const found = await this.#findWelcome(channelId);
    if (found) {
      const result = await this.#join(channelId, found.newest);
      if (result.status === "joined") {
        // Clear out the superseded welcomes so they are not offered
        // again. Best effort: leaving one behind costs a wasted lookup,
        // not correctness, since the newest is always chosen.
        for (const w of found.stale) {
          await this.#ackWelcome(w.id).catch(() => undefined);
        }
        return { ...result, replaced };
      }
      // No local key package matches it. The GroupInfo route below
      // needs none, so fall through rather than give up.
    }

    const info = (await this.#call(
      `/api/v1/channels/${channelId}/mls/group-info`,
    )) as GroupInfoResponse;

    const result =
      info.group_info && info.group_info_epoch === info.epoch
        ? await this.#joinExternal(channelId, info)
        : await this.#reset(channelId, info.generation);
    if (result) return { ...result, replaced: result.replaced || replaced };

    // Lost a race: someone committed, joined or replaced the group
    // between our look and our write. Look again.
    if (attempt + 1 < MAX_OPEN_ATTEMPTS) return this.#open(channelId, attempt + 1);
    return {
      status: "awaiting_invite",
      epoch: info.epoch,
      detail: "the encryption group kept changing while joining; try again in a moment",
      replaced,
    };
  }

  async #remote(channelId: string): Promise<ServerGroupState> {
    return (await this.#call(`/api/v1/channels/${channelId}/mls`)) as ServerGroupState;
  }

  /** The MLS group ID for a channel's group of a given generation. */
  #groupIdFor(channelId: string, generation: number): string {
    return generation === 0 ? channelId : `${channelId}${GENERATION_SEP}${generation}`;
  }

  /** Which generation a state belongs to; null if it is not this channel's. */
  #generationOf(channelId: string, state: unknown): number | null {
    const id = groupIdOf(state);
    if (id === channelId) return 0;
    const prefix = channelId + GENERATION_SEP;
    if (!id.startsWith(prefix)) return null;
    const n = Number(id.slice(prefix.length));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  /** The generation to name in requests for this channel's current state. */
  #generation(channelId: string): number {
    return this.#generationOf(channelId, this.#requireState(channelId)) ?? 0;
  }

  /**
   * Upload this epoch's GroupInfo if the server's is missing or older.
   *
   * Commits carry one already, so this only matters for a group from
   * before external join, or one whose last upload was lost. The server
   * refuses it unless it names the current epoch, so a device that is
   * behind cannot replace a good one with a stale one.
   */
  async #publishGroupInfo(channelId: string, remote: ServerGroupState): Promise<void> {
    const state = this.#requireState(channelId);
    const epoch = epochOf(state);
    if (remote.group_info_epoch === epoch) return;
    const info = await this.#mls.groupInfo(state);
    await this.#call(`/api/v1/channels/${channelId}/mls/group-info`, {
      method: "PUT",
      body: JSON.stringify({
        device_id: this.#deviceId,
        generation: this.#generation(channelId),
        epoch,
        group_info: toBase64(info),
      }),
    });
  }

  /**
   * Join from the published GroupInfo with an external commit (RFC 9420).
   *
   * Returns null if the commit lost the epoch race: the GroupInfo is
   * then out of date, and the caller looks again (a member may have just
   * added this device). The external commit is checked by the server
   * like any other: the caller must be allowed to view the channel and
   * the device must be its own.
   */
  async #joinExternal(
    channelId: string,
    info: GroupInfoResponse,
  ): Promise<OpenResult | null> {
    const keys = await this.#freshKeyPair();
    const { state, commit } = await this.#mls.joinExternal(fromBase64(info.group_info), keys);

    // The GroupInfo is the server's to hand out. One for another
    // channel's group would let this device build a commit nobody here
    // can process, so refuse it rather than wreck the log.
    if (groupIdOf(state) !== this.#groupIdFor(channelId, info.generation)) {
      throw new Error("groups: the published group info belongs to a different group");
    }

    const next = await this.#mls.groupInfo(state);
    try {
      await this.#call(`/api/v1/channels/${channelId}/mls/commit`, {
        method: "POST",
        body: JSON.stringify({
          device_id: this.#deviceId,
          epoch: info.epoch,
          generation: info.generation,
          commit: toBase64(commit),
          welcomes: [],
          group_info: toBase64(next),
        }),
      });
    } catch (err) {
      if (this.#isEpochConflict(err)) return null;
      throw err;
    }

    await this.#persist(channelId, state);
    return { status: "joined", via: "external", epoch: epochOf(state) };
  }

  /**
   * Replace a group nobody permitted can commit to.
   *
   * Only reached when there is no GroupInfo, or only one older than the
   * server's epoch, so an external join cannot work; the server checks
   * the same condition and refuses otherwise. This device builds the new
   * group under the next generation's group ID and sends its GroupInfo
   * with the request, so the new group is joinable the moment it exists.
   * Returns null if someone else replaced or advanced it first.
   */
  async #reset(channelId: string, generation: number): Promise<OpenResult | null> {
    const keys = await this.#freshKeyPair();
    const state = await this.#mls.createGroup(this.#groupIdFor(channelId, generation + 1), keys);
    const info = await this.#mls.groupInfo(state);

    try {
      await this.#call(`/api/v1/channels/${channelId}/mls/reset`, {
        method: "POST",
        body: JSON.stringify({
          device_id: this.#deviceId,
          generation,
          group_info: toBase64(info),
        }),
      });
    } catch (err) {
      if ((err as { status?: unknown } | null)?.status === 409) return null;
      throw err;
    }

    await this.#persist(channelId, state);
    return {
      status: "created",
      epoch: epochOf(state),
      replaced: true,
      detail: "nobody with access could update the old encryption group, so it was replaced",
    };
  }

  /** Current epoch for a channel this device belongs to. */
  epoch(channelId: string): number | null {
    const state = this.#states.get(channelId);
    return state ? epochOf(state) : null;
  }

  /**
   * The media encryption key for this channel's current epoch.
   *
   * Voice and screen share are keyed from the same MLS group as the
   * channel, so a membership change rotates the media key in the same
   * step: someone removed cannot derive the next epoch's key, and someone
   * added cannot derive an earlier one. Every member derives the same
   * bytes independently; the key is never sent anywhere.
   *
   * The label names the use and the version, so changing how media keys
   * are derived later produces different keys rather than ambiguity. The
   * channel ID goes in the exporter context as well, as defence in depth
   * against two uses of one group ever producing the same key.
   */
  async mediaKey(channelId: string): Promise<{ epoch: number; key: Uint8Array }> {
    const state = this.#states.get(channelId);
    if (!state) throw new Error(`groups: not a member of ${channelId}`);
    const key = await this.#mls.exportSecret(
      state,
      MEDIA_KEY_LABEL,
      MEDIA_KEY_BYTES,
      new TextEncoder().encode(channelId),
    );
    return { epoch: epochOf(state), key };
  }

  isMember(channelId: string): boolean {
    return this.#states.has(channelId);
  }

  async #create(channelId: string): Promise<OpenResult> {
    const keys = await this.#freshKeyPair();
    const state = await this.#mls.createGroup(this.#groupIdFor(channelId, 0), keys);
    const info = await this.#mls.groupInfo(state);

    try {
      await this.#call(`/api/v1/channels/${channelId}/mls`, {
        method: "POST",
        body: JSON.stringify({ device_id: this.#deviceId, group_info: toBase64(info) }),
      });
    } catch (err) {
      // Someone created it between our check and our write. Their group
      // is the real one; ours is a local object with no members, so
      // discard it and come back as a joiner.
      if (String(err).includes("already has a group")) {
        return this.#open(channelId, MAX_OPEN_ATTEMPTS - 1);
      }
      throw err;
    }

    await this.#persist(channelId, state);
    return { status: "created", epoch: epochOf(state) };
  }

  /**
   * The newest welcome for this channel.
   *
   * There can be several: a device removed and re-added while it was
   * offline has a welcome from each add. Only the newest is still good -
   * the older ones lead into epochs this device was later removed from -
   * so the rest are kept aside to be discarded once the join succeeds.
   */
  async #findWelcome(
    channelId: string,
  ): Promise<{ newest: PendingWelcome; stale: PendingWelcome[] } | null> {
    const pending = (await this.#call(
      `/api/v1/mls/welcomes?device_id=${encodeURIComponent(this.#deviceId)}`,
    )) as PendingWelcome[];

    const mine = pending
      .filter((w) => w.channel_id === channelId)
      .sort((a, b) => b.epoch - a.epoch || b.id - a.id);
    const [newest, ...stale] = mine;
    return newest ? { newest, stale } : null;
  }

  async #ackWelcome(id: number): Promise<void> {
    await this.#call(`/api/v1/mls/welcomes/${id}/ack`, {
      method: "POST",
      body: JSON.stringify({ device_id: this.#deviceId }),
    });
  }

  async #join(channelId: string, welcome: PendingWelcome): Promise<OpenResult> {
    const tree = decodeTree(fromBase64(welcome.ratchet_tree));
    const welcomeBytes = fromBase64(welcome.welcome);

    // A welcome does not say which of our published key packages it was
    // built for, so each is tried until one works. With a pool of about
    // twenty five this is cheap, and a failure is a fast rejection
    // rather than any real work.
    const pairs = await storage.listKeyPairs();
    pairs.sort((a, b) => b.createdAt - a.createdAt);

    let state: unknown = null;
    let usedId: string | null = null;

    for (const pair of pairs) {
      try {
        state = await this.#mls.joinGroup(
          welcomeBytes,
          { publicPackage: pair.publicPackage, privatePackage: pair.privatePackage },
          tree,
        );
        usedId = pair.id;
        break;
      } catch {
        // Wrong key package for this welcome; try the next.
      }
    }

    if (!state || !usedId) {
      return {
        status: "unavailable",
        epoch: welcome.epoch,
        detail: "no local key package matches this invitation; it may predate a device reset",
      };
    }

    await this.#persist(channelId, state);

    // Acknowledged only after the state is stored. Acknowledging on
    // receipt would mean a failure here leaves this device outside the
    // group with nothing left to retry from.
    await this.#ackWelcome(welcome.id);

    // A key package is single use. Keeping it would invite reuse, which
    // is the forward secrecy failure the whole design is built to avoid.
    await storage.deleteKeyPair(usedId);

    return { status: "joined", via: "welcome", epoch: epochOf(state) };
  }

  /**
   * Apply any commits made while this device was away.
   *
   * Handshakes are requested from the current local epoch, because a
   * commit is recorded against the epoch it was built ON. Commits this
   * device made itself are already applied and were built on an earlier
   * epoch, so they are not returned.
   */
  async catchUp(channelId: string): Promise<number> {
    return this.#serial(channelId, () => this.#catchUp(channelId));
  }

  async #catchUp(channelId: string): Promise<number> {
    let state = this.#states.get(channelId);
    if (!state) throw new Error(`groups: not a member of ${channelId}`);

    const generation = this.#generationOf(channelId, state);
    const genParam = generation === null ? "" : `&generation=${generation}`;

    for (;;) {
      const since = epochOf(state);
      let entries: HandshakeEntry[];
      try {
        entries = (await this.#call(
          `/api/v1/channels/${channelId}/mls/handshakes?since_epoch=${since}${genParam}`,
        )) as HandshakeEntry[];
      } catch (err) {
        // 410: the group was replaced. The log now belongs to the new
        // group, which this state cannot read.
        if ((err as { status?: unknown } | null)?.status === 410) {
          await this.#forget(channelId);
          throw new GroupReset(channelId);
        }
        throw err;
      }

      if (entries.length === 0) break;

      let applied = 0;
      const changes: RawChange[] = [];
      for (const entry of entries) {
        if (entry.epoch < epochOf(state)) continue;

        // Our own commit. MLS never lets a sender process its own commit
        // (the keys it was framed with are already spent), and the commit
        // path applies it locally once the server accepts it. Seeing it
        // here just means the server's "group advanced" event beat that
        // local update, so leave it to the commit path rather than
        // failing with an opaque OperationError.
        if (entry.sender_device_id === this.#deviceId) break;

        const before = this.#mls.memberIdentities(state);
        const result = await this.#mls.decrypt(state, fromBase64(entry.blob));
        state = result.state;
        applied++;

        // Checked after every commit, not once at the end: a later
        // commit cannot be processed by a device that is no longer in
        // the group, and would fail with a confusing error instead.
        if (!(await this.#mls.stillMember(state))) {
          await this.#forget(channelId);
          throw new RemovedFromGroup(channelId);
        }

        changes.push(
          this.#diff(channelId, epochOf(state), before, this.#mls.memberIdentities(state),
            entry.sender_device_id),
        );
      }

      await this.#persist(channelId, state);
      // Only once the state is saved: a notice for a change this device
      // then forgot would be repeated after a reload.
      for (const change of changes) this.#announce(change);

      // The server pages handshakes, so keep asking until a request adds
      // nothing. Stopping on a full page would silently leave a device
      // several epochs behind.
      if (applied === 0) break;
    }

    return epochOf(state);
  }

  // There is deliberately no public "add these users": membership follows
  // channel access (decisions.md), so reconcile is the only way in.

  /**
   * Make the group's membership match who may view the channel.
   *
   * The server lists every device that belongs (each non-revoked device
   * of each account that may view the channel); this device compares
   * that with its own ratchet tree, which the server cannot read, and
   * commits the difference.
   *
   * Two commits, removals first. Combining them lets an added device land
   * in the leaf a removed device just vacated, and ts-mls then leaves the
   * removed device believing it is still in (decisions.md, "Removes and
   * adds go in separate commits"). Each commit goes through the usual
   * compare-and-swap, so two members reconciling at once cannot fork the
   * group: the loser rebases and usually finds nothing left to do.
   *
   * Duplicate leaves (one device in twice, after rejoining from a
   * GroupInfo) are only cleaned up by the device itself. Any other member
   * cannot tell which of the two leaves is the live one, and removing the
   * wrong one would kick the device out.
   */
  async reconcile(channelId: string): Promise<ReconcileResult> {
    return this.#serial(channelId, async () => {
      this.#requireState(channelId);

      // Build on the newest state, or the first attempt is a wasted
      // commit and a guaranteed conflict.
      await this.#catchUp(channelId);

      const allowed = (await this.#call(
        `/api/v1/channels/${channelId}/mls/allowed-devices`,
      )) as AllowedDevice[];
      const allowedIds = new Set(allowed.map((d) => d.device_id));
      for (const d of allowed) this.#remember(d);

      // 1. Removals. The leaves are looked up again on every attempt,
      // from the state the commit is built on: after a rebase the same
      // index can name a different device.
      const removal = await this.#commitWithRetry<MemberLeaf[]>(channelId, async (state) => {
        const own = this.#mls.ownLeafIndex(state);
        const leaves = this.#mls.memberLeaves(state).filter(
          (l) =>
            l.leafIndex !== own &&
            (!allowedIds.has(l.identity) || l.identity === this.#deviceId),
        );
        if (leaves.length === 0) return { nothing: [] };
        const commit = await this.#mls.removeMembers(
          state,
          leaves.map((l) => l.leafIndex),
        );
        return { commit, welcomeTo: [], done: leaves };
      });

      // 2. Additions, against the post-removal state.
      const members = this.#mls.memberIdentities(this.#requireState(channelId));
      const missing = allowed.filter((d) => !members.includes(d.device_id));

      let epoch = removal.epoch;
      let added: string[] = [];
      if (missing.length > 0) {
        const users = [...new Set(missing.map((d) => d.user_id))];
        const { pending } = await this.#claim(channelId, users, members);
        if (pending.length > 0) {
          const addition = await this.#addPending(channelId, pending);
          epoch = addition.epoch;
          added = addition.done.map((p) => p.device_id);
        }
      }

      // Anything still missing could not be claimed (no key package left)
      // or went in via someone else's commit; report only the former.
      const nowIn = new Set(this.#mls.memberIdentities(this.#requireState(channelId)));
      const skipped = missing.map((d) => d.device_id).filter((id) => !nowIn.has(id));

      return {
        epoch,
        removed: removal.done.map((l) => l.identity),
        added,
        skipped,
      };
    });
  }

  /**
   * Hear about background reconciles. Returns a function that stops it.
   */
  onAuto(listener: (event: AutoEvent) => void): () => void {
    this.#autoListeners.add(listener);
    return () => this.#autoListeners.delete(listener);
  }

  /**
   * Reconcile a channel's group in the background, soon.
   *
   * Called on every hint that membership may be out of date: the group
   * was opened, someone committed, a role changed, an account was
   * banned, a device was revoked or published key packages. Hints are
   * cheap to give and often redundant, so this never throws and never
   * runs twice at once for a channel: a trigger while a run is pending
   * or in progress just asks for one more run after it.
   *
   * Every online member hears the same events, and if they all
   * reconciled at once each would claim a key package for the same new
   * device. Only one commit can win, and the rest of those single-use
   * packages would be burned for nothing. So members wait in turn, by
   * their position in the ratchet tree: the lowest leaf goes first, the
   * next waits a little, and by the time a later member runs, it catches
   * up on the first one's commit and finds nothing left to do. If the
   * first is offline the second simply goes a moment later. Nothing
   * depends on this for correctness - the epoch compare-and-swap still
   * prevents a fork - it only saves key packages and wasted commits.
   */
  reconcileSoon(channelId: string): void {
    if (this.#autoBusy.has(channelId)) {
      this.#autoAgain.add(channelId);
      return;
    }
    this.#autoBusy.add(channelId);

    void this.#autoRun(channelId).finally(() => {
      this.#autoBusy.delete(channelId);
      if (this.#autoAgain.delete(channelId)) this.reconcileSoon(channelId);
    });
  }

  async #autoRun(channelId: string): Promise<void> {
    await sleep(RECONCILE_DEBOUNCE_MS);

    // Not a member: there is nothing to commit from. Joining is the
    // caller's business (open picks up a welcome).
    if (!this.#states.has(channelId)) return;

    await sleep(this.#staggerFor(channelId));
    if (!this.#states.has(channelId)) return;

    try {
      const result = await this.reconcile(channelId);
      this.#emit({ kind: "reconciled", channelId, result });
    } catch (err) {
      if (err instanceof RemovedFromGroup) {
        this.#emit({ kind: "removed", channelId, replaced: err instanceof GroupReset });
        return;
      }
      // This device lost access between the trigger and the run. The
      // server refuses the allowed list, and another member's reconcile
      // removes this device.
      const status = (err as { status?: unknown } | null)?.status;
      if (status === 403 || status === 404) return;
      this.#emit({ kind: "error", channelId, error: err });
    }
  }

  /** How long this device waits its turn; see reconcileSoon. */
  #staggerFor(channelId: string): number {
    const state = this.#states.get(channelId);
    if (!state) return 0;
    const own = this.#mls.ownLeafIndex(state);
    const ahead = this.#mls.memberLeaves(state).filter((l) => l.leafIndex < own).length;
    return (
      Math.min(ahead, RECONCILE_MAX_RANK) * RECONCILE_STAGGER_MS +
      Math.floor(Math.random() * RECONCILE_JITTER_MS)
    );
  }

  /**
   * Hear who joins and leaves each group. Returns a function that stops it.
   */
  onMembership(listener: (change: MembershipChange) => void): () => void {
    this.#membershipListeners.add(listener);
    return () => this.#membershipListeners.delete(listener);
  }

  #diff(
    channelId: string,
    epoch: number,
    before: string[],
    after: string[],
    by: string | null,
  ): RawChange {
    const was = new Set(before);
    const now = new Set(after);
    return {
      channelId,
      epoch,
      joined: [...now].filter((id) => !was.has(id)),
      left: [...was].filter((id) => !now.has(id)),
      by,
    };
  }

  /**
   * Name the devices in a change and tell listeners.
   *
   * Runs behind the group operation that found the change rather than
   * inside it, so a slow name lookup never holds up the channel. The
   * shared queue keeps notices in the order the changes happened.
   */
  #announce(raw: RawChange): void {
    if (raw.joined.length === 0 && raw.left.length === 0) return;
    if (this.#membershipListeners.size === 0) return;

    this.#notices = this.#notices.then(async () => {
      const ids = [...raw.joined, ...raw.left, ...(raw.by ? [raw.by] : [])];
      await this.#describe(raw.channelId, ids, raw.left);
      const info = (id: string): DeviceInfo => this.#names.get(id) ?? { deviceId: id };
      const change: MembershipChange = {
        channelId: raw.channelId,
        epoch: raw.epoch,
        joined: raw.joined.map(info),
        left: raw.left.map(info),
        by: raw.by ? info(raw.by) : null,
        self: raw.by === this.#deviceId,
      };
      for (const listener of this.#membershipListeners) {
        try {
          listener(change);
        } catch {
          // One broken listener must not silence the rest.
        }
      }
    });
  }

  /**
   * Look up owners for device IDs not already known.
   *
   * Most are known from the allowed list reconcile fetches. Leavers
   * usually are not on it any more, since losing access is why they left. A failed lookup is not an error: the
   * notice still goes out, naming the device by ID.
   */
  async #describe(channelId: string, ids: string[], fresh: string[]): Promise<void> {
    // Leavers are always looked up again: a cached entry from the allowed
    // list predates the revocation or ban that is probably the reason.
    const again = new Set(fresh);
    const unknown = [...new Set(ids)].filter((id) => again.has(id) || !this.#names.has(id));
    if (unknown.length === 0) return;
    try {
      const found = (await this.#call(
        `/api/v1/channels/${channelId}/mls/device-names?ids=${unknown.map(encodeURIComponent).join(",")}`,
      )) as Array<AllowedDevice & { revoked: boolean }>;
      for (const d of found) this.#remember(d);
    } catch {
      // Names are a courtesy; the device ID is the announcement.
    }
  }

  #remember(d: AllowedDevice & { revoked?: boolean }): void {
    this.#names.set(d.device_id, {
      deviceId: d.device_id,
      userId: d.user_id,
      username: d.username,
      label: d.label,
      revoked: d.revoked ?? false,
    });
  }

  #emit(event: AutoEvent): void {
    for (const listener of this.#autoListeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop the others hearing about it.
      }
    }
  }

  /**
   * Claim one key package per device of each user, skipping devices
   * already in the group.
   *
   * Devices already in the group are excluded before claiming, not
   * after. Claiming consumes a single-use key package, so filtering
   * afterwards would still burn one per device on every attempt.
   *
   * An account with no device, no access, or no key package left has
   * nothing to add. That is normal, not an error: it is reported as
   * skipped rather than letting one idle account block everyone else.
   */
  async #claim(
    channelId: string,
    userIds: string[],
    members: string[],
  ): Promise<{ pending: PendingAdd[]; alreadyMembers: string[]; skipped: string[] }> {
    const pending: PendingAdd[] = [];
    const alreadyMembers: string[] = [];
    const skipped: string[] = [];
    for (const userId of userIds) {
      try {
        const res = (await this.#call(
          `/api/v1/users/${userId}/key-packages/claim`,
          {
            method: "POST",
            // The server only hands out packages for a channel both of
            // us can view, so one account cannot drain another's pool.
            body: JSON.stringify({ channel_id: channelId, exclude_device_ids: members }),
          },
        )) as ClaimResponse;
        if (res.packages.length > 0) {
          pending.push(...res.packages.map((p) => ({ ...p, user_id: userId })));
        } else if (res.already_in_group.length > 0) {
          alreadyMembers.push(userId);
        } else {
          skipped.push(userId);
        }
      } catch (err) {
        const msg = String(err);
        if (
          !msg.includes("no devices registered") &&
          !msg.includes("does not have access") &&
          !msg.includes("key packages available")
        ) {
          throw err;
        }
        skipped.push(userId);
      }
    }
    return { pending, alreadyMembers, skipped };
  }

  /**
   * Add claimed devices in one commit.
   *
   * The device list is re-checked on every attempt: if the commit that
   * beat us added one of the same devices, adding it again would put two
   * leaves in the tree for one device.
   */
  async #addPending(
    channelId: string,
    pending: PendingAdd[],
  ): Promise<{ epoch: number; done: PendingAdd[] }> {
    return this.#commitWithRetry<PendingAdd[]>(channelId, async (state) => {
      const members = new Set(this.#mls.memberIdentities(state));
      const toAdd = pending.filter((p) => !members.has(p.device_id));
      if (toAdd.length === 0) {
        // Everyone we meant to add got in through someone else's commit.
        return { nothing: [] };
      }

      const keyPackages: WireMessage[] = toAdd.map((c) => fromBase64(c.package));
      const commit = await this.#mls.addMembers(state, keyPackages);
      if (!commit.welcome) {
        throw new Error("groups: commit produced no welcome");
      }
      return { commit, welcomeTo: toAdd.map((c) => c.device_id), done: toAdd };
    });
  }

  /**
   * Build a commit and submit it, rebasing if someone else got there
   * first.
   *
   * The rebase is the whole reason this is a loop. Two clients committing
   * against the same epoch would fork the group irrecoverably, so the
   * server accepts one and rejects the other. The loser catches up,
   * rebuilds its commit on the new state, and tries again - which is why
   * the commit is built by a callback inside the loop rather than once
   * outside it.
   */
  async #commitWithRetry<T>(
    channelId: string,
    build: (state: unknown) => Promise<Built<T>>,
  ): Promise<{ epoch: number; done: T }> {
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
      const state = this.#requireState(channelId);
      const builtOn = epochOf(state);

      const built = await build(state);
      if ("nothing" in built) return { epoch: builtOn, done: built.nothing };
      const { commit, welcomeTo } = built;

      // One welcome covers every device added by this commit; each
      // decrypts only its own secrets from it. The same bytes therefore
      // go to each recipient.
      const welcomes =
        commit.welcome && welcomeTo.length > 0
          ? (() => {
              const welcomeB64 = toBase64(commit.welcome!);
              const treeB64 = toBase64(encodeTree(commit.ratchetTree));
              return welcomeTo.map((device_id) => ({
                device_id,
                welcome: welcomeB64,
                ratchet_tree: treeB64,
              }));
            })()
          : [];

      try {
        const response = (await this.#call(
          `/api/v1/channels/${channelId}/mls/commit`,
          {
            method: "POST",
            body: JSON.stringify({
              device_id: this.#deviceId,
              epoch: builtOn,
              generation: this.#generation(channelId),
              commit: toBase64(commit.commit),
              welcomes,
              // For the epoch this commit produces, so a device can join
              // from it while nobody is online.
              group_info: toBase64(await this.#mls.groupInfo(commit.state)),
            }),
          },
        )) as { epoch: number };

        // Our own commit cannot remove us, so this should never fire. It
        // is checked anyway, because if it ever does the group is in a
        // state this client does not understand, and carrying on would
        // be worse than starting over.
        if (!(await this.#mls.stillMember(commit.state))) {
          await this.#forget(channelId);
          throw new RemovedFromGroup(channelId);
        }

        // Only now is the new state real. Persisting before the server
        // accepted would leave this device on a branch nobody else
        // follows. Likewise the spent keys: until now they were still
        // needed in case we lost the race (see spentWiper in tsmls.ts).
        await this.#persist(channelId, commit.state);
        commit.wipeSpent();
        this.#announce(
          this.#diff(channelId, response.epoch, this.#mls.memberIdentities(state),
            this.#mls.memberIdentities(commit.state), this.#deviceId),
        );
        return { epoch: response.epoch, done: built.done };
      } catch (err) {
        if (!this.#isEpochConflict(err)) throw err;

        if (attempt === MAX_COMMIT_ATTEMPTS) {
          throw new Error(
            "groups: could not commit; the group kept moving. Try again in a moment.",
          );
        }

        // Discard the commit built on the stale epoch, take everyone
        // else's changes, and rebuild.
        await this.#catchUp(channelId);
      }
    }

    throw new Error("groups: commit failed");
  }

  /**
   * Only ever asked about a refused POST to the commit endpoint, where a
   * 409 means exactly one thing: someone else committed first.
   */
  #isEpochConflict(err: unknown): boolean {
    if ((err as { status?: unknown } | null)?.status === 409) return true;
    const text = String(err);
    return text.includes("the group has moved on") || text.includes("409");
  }

  /** Encrypt a message for a channel. */
  async encrypt(channelId: string, plaintext: Uint8Array): Promise<Uint8Array> {
    return this.#serial(channelId, async () => {
      const state = this.#requireState(channelId);
      const result = await this.#mls.encrypt(state, plaintext);
      await this.#persist(channelId, result.state);
      return result.message;
    });
  }

  /**
   * Decrypt a message.
   *
   * Returns null for a message this device cannot read, which is normal
   * rather than exceptional: anything sent before this device joined is
   * undecryptable by design, and a client that treated that as an error
   * would fill the log with noise for a working system.
   */
  async decrypt(channelId: string, ciphertext: Uint8Array): Promise<Uint8Array | null> {
    return this.#serial(channelId, async () => {
      const state = this.#states.get(channelId);
      if (!state) return null;

      try {
        const result = await this.#mls.decrypt(state, ciphertext);
        await this.#persist(channelId, result.state);
        return result.plaintext ?? null;
      } catch {
        return null;
      }
    });
  }

  /**
   * Run one group operation at a time per channel.
   *
   * Every operation reads the current state, awaits, then writes a new
   * one. Two interleaved (say a background reconcile and a message being
   * sent) would each write a state derived from the same starting point,
   * and whichever wrote second would silently undo the other - for a
   * commit, leaving this device an epoch behind a group it thinks it is
   * current in. Internal helpers (#open, #catchUp) do not queue, so
   * queued operations can call them without deadlocking.
   */
  #serial<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(channelId) ?? Promise.resolve();
    const next = prev.then(fn);
    // The queue must keep going after a failure; the caller still sees it.
    this.#queues.set(channelId, next.catch(() => undefined));
    return next;
  }

  #requireState(channelId: string): unknown {
    const state = this.#states.get(channelId);
    if (!state) throw new Error(`groups: not a member of ${channelId}`);
    return state;
  }

  /** Drop this device's state for a group it is no longer in. */
  async #forget(channelId: string): Promise<void> {
    this.#states.delete(channelId);
    await storage.deleteGroup(channelId);
  }

  async #persist(channelId: string, state: unknown): Promise<void> {
    this.#states.set(channelId, state);
    await storage.setGroup(channelId, encodeState(state));
  }

  /**
   * A key package for this device's own use.
   *
   * Creating a group needs one, and unlike the published pool it is
   * never handed to anyone, so it is generated on the spot rather than
   * consuming one someone else could have used.
   */
  async #freshKeyPair() {
    return this.#mls.generateKeyPackage(this.#deviceId);
  }
}
