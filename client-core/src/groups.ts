// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CommitResult, MemberLeaf, MlsProvider, WireMessage } from "./mls/provider.js";
import { encodeState, restoreState, encodeTree, decodeTree, epochOf } from "./mls/tsmls.js";
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
}

interface ServerGroupState {
  exists: boolean;
  epoch: number;
  reason?: string;
}

/**
 * Outcome of addMembers, by user ID.
 *
 * added: at least one of their devices joined in this commit.
 * alreadyMembers: every device they have is already in the group.
 * skipped: they have no device that could be added.
 *
 * Each user lands in exactly one list. Someone whose laptop is already
 * in but whose new phone was just added counts as added.
 */
export interface AddResult {
  epoch: number;
  added: string[];
  alreadyMembers: string[];
  skipped: string[];
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

  constructor(mls: MlsProvider, call: ApiCall, deviceId: string) {
    this.#mls = mls;
    this.#call = call;
    this.#deviceId = deviceId;
  }

  /**
   * Make this device a working member of a channel's group.
   *
   * Four outcomes, in the order they are attempted: already a member and
   * caught up; no group exists so create one; a welcome is waiting so
   * join; or the group exists and nobody has added us, which is not an
   * error but a state the interface has to show.
   */
  async open(channelId: string): Promise<OpenResult> {
    return this.#serial(channelId, () => this.#open(channelId));
  }

  async #open(channelId: string): Promise<OpenResult> {
    const stored = (await storage.getGroup(channelId)) as Uint8Array | undefined;

    if (stored) {
      const state = restoreState(stored);
      this.#states.set(channelId, state);
      try {
        const epoch = await this.#catchUp(channelId);
        return { status: "ready", epoch };
      } catch (err) {
        // Removed while we were away. The stale state is already gone;
        // carry on as a newcomer, which picks up a welcome if someone
        // has added this device back.
        if (!(err instanceof RemovedFromGroup)) throw err;
      }
    }

    const remote = (await this.#call(
      `/api/v1/channels/${channelId}/mls`,
    )) as ServerGroupState;

    if (!remote.exists) {
      return this.#create(channelId);
    }

    const welcome = await this.#findWelcome(channelId);
    if (welcome) {
      return this.#join(channelId, welcome);
    }

    return {
      status: "awaiting_invite",
      epoch: remote.epoch,
      detail: "this channel is encrypted and nobody has added this device yet",
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
    const state = await this.#mls.createGroup(channelId, keys);

    try {
      await this.#call(`/api/v1/channels/${channelId}/mls`, {
        method: "POST",
        body: JSON.stringify({ device_id: this.#deviceId }),
      });
    } catch (err) {
      // Someone created it between our check and our write. Their group
      // is the real one; ours is a local object with no members, so
      // discard it and come back as a joiner.
      if (String(err).includes("already has a group")) {
        return this.#open(channelId);
      }
      throw err;
    }

    await this.#persist(channelId, state);
    return { status: "created", epoch: epochOf(state) };
  }

  async #findWelcome(channelId: string): Promise<PendingWelcome | null> {
    const pending = (await this.#call(
      `/api/v1/mls/welcomes?device_id=${encodeURIComponent(this.#deviceId)}`,
    )) as PendingWelcome[];

    return pending.find((w) => w.channel_id === channelId) ?? null;
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
    await this.#call(`/api/v1/mls/welcomes/${welcome.id}/ack`, {
      method: "POST",
      body: JSON.stringify({ device_id: this.#deviceId }),
    });

    // A key package is single use. Keeping it would invite reuse, which
    // is the forward secrecy failure the whole design is built to avoid.
    await storage.deleteKeyPair(usedId);

    return { status: "joined", epoch: epochOf(state) };
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

    for (;;) {
      const since = epochOf(state);
      const entries = (await this.#call(
        `/api/v1/channels/${channelId}/mls/handshakes?since_epoch=${since}`,
      )) as HandshakeEntry[];

      if (entries.length === 0) break;

      let applied = 0;
      for (const entry of entries) {
        if (entry.epoch < epochOf(state)) continue;

        // Our own commit. MLS never lets a sender process its own commit
        // (the keys it was framed with are already spent), and the commit
        // path applies it locally once the server accepts it. Seeing it
        // here just means the server's "group advanced" event beat that
        // local update, so leave it to the commit path rather than
        // failing with an opaque OperationError.
        if (entry.sender_device_id === this.#deviceId) break;

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
      }

      await this.#persist(channelId, state);

      // The server pages handshakes, so keep asking until a request adds
      // nothing. Stopping on a full page would silently leave a device
      // several epochs behind.
      if (applied === 0) break;
    }

    return epochOf(state);
  }

  /**
   * Add every device belonging to the given users.
   *
   * Members are added per device, not per account: each device is its own
   * leaf, which is what lets someone read a channel on a laptop and a
   * phone without either holding the other's keys.
   */
  async addMembers(channelId: string, userIds: string[]): Promise<AddResult> {
    return this.#serial(channelId, async () => {
      const state = this.#requireState(channelId);
      const { pending, alreadyMembers, skipped } = await this.#claim(
        channelId,
        userIds,
        this.#mls.memberIdentities(state),
      );

      if (pending.length === 0) {
        if (alreadyMembers.length > 0) {
          // Nothing new to add. No commit, so the epoch does not move.
          return { epoch: epochOf(state), added: [], alreadyMembers, skipped };
        }
        throw new Error("groups: none of those accounts have a device to add");
      }

      const { epoch, done: committed } = await this.#addPending(channelId, pending);

      // Someone else's commit may have added some of these devices while
      // we were rebasing. Report those users as already members unless
      // another of their devices went in with our commit.
      const added = [...new Set(committed.map((p) => p.user_id))];
      for (const userId of new Set(pending.map((p) => p.user_id))) {
        if (!added.includes(userId)) alreadyMembers.push(userId);
      }
      return { epoch, added, alreadyMembers, skipped };
    });
  }

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
              commit: toBase64(commit.commit),
              welcomes,
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
