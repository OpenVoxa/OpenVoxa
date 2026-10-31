// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as tsMls from "ts-mls";
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  createGroupInfoWithExternalPubAndRatchetTree,
  decodeMlsMessage,
  defaultAuthenticationService,
  defaultCapabilities,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetime,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  joinGroupExternal,
  processPrivateMessage,
  processPublicMessage,
  zeroOutUint8Array,
  type ClientConfig,
  type Credential,
  type Proposal,
} from "ts-mls";

import type {
  CommitResult,
  DecryptResult,
  GroupState,
  KeyPair,
  MemberLeaf,
  MlsProvider,
  WireMessage,
} from "./provider.js";

/**
 * Ciphersuite 1: DHKEM-X25519, AES-128-GCM, HKDF-SHA256, Ed25519.
 *
 * It is the mandatory-to-implement suite in RFC 9420, so any other
 * conforming implementation can interoperate. That matters here
 * specifically: the provider interface exists so ts-mls can be replaced
 * with OpenMLS later, and a suite both must support keeps that door open.
 *
 * It also has the smallest dependency footprint ts-mls offers:
 * @noble/curves and @noble/hashes, both independently audited, and no
 * HPKE extensions. Every other suite adds packages on top.
 *
 * The post-quantum suites are deliberately not used yet. They pull in
 * more code and the threat they address is not the one this project is
 * trying to solve first.
 */
const CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

type Impl = Awaited<ReturnType<typeof getCiphersuiteImpl>>;

/**
 * Serialise a commit for transport.
 *
 * Observed from ts-mls 1.6.2 rather than inferred: createCommit returns
 * `commit` as a COMPLETE MLSMessage, already carrying its version and
 * wireformat, while `welcome` comes back as a bare Welcome that still
 * needs wrapping. The asymmetry is easy to miss and produces confusing
 * errors deep inside the encoder, so it is pinned here with a test that
 * exercises it.
 *
 * Commits are framed as private messages, which means the delivery
 * server cannot read them - including the epoch it needs for ordering.
 * See docs/decisions.md; the client sends the epoch alongside the opaque
 * blob and the server treats it as a hint for serialising commits, never
 * as something to trust.
 */
function encodeCommit(commit: unknown): WireMessage {
  return encodeMlsMessage(commit as never);
}

/**
 * ts-mls hands back the key material a commit used up so the caller can
 * destroy it. Skipping that leaves spent keys in memory, which quietly
 * weakens forward secrecy: a device compromised later should not be able
 * to read what was sent earlier.
 *
 * For a commit the wipe is deferred, not done on the spot. The material
 * is shared with the state the commit was built on, and if the server
 * refuses the commit (someone else committed first) that state is used
 * again to process the winner. Wiping early corrupts it and the device
 * fails with "Could not verify confirmation tag", stuck. Observed in Node,
 * ts-mls 1.6.2, 2026-10-31.
 */
function spentWiper(consumed: Uint8Array[]): () => void {
  return () => consumed.forEach(zeroOutUint8Array);
}

/**
 * Serialise group state for storage.
 *
 * Browsers restart, so group state has to survive on disk or every
 * reload would mean rejoining every channel. ts-mls exposes
 * encodeGroupState/decodeGroupState for exactly this.
 *
 * The output contains PRIVATE key material and must never be sent
 * anywhere. It is written to IndexedDB on this device and nowhere else.
 */
export function encodeState(state: unknown): Uint8Array {
  const fn = (tsMls as Record<string, unknown>)["encodeGroupState"];
  if (typeof fn !== "function") throw new Error("ts-mls has no encodeGroupState");

  const out = (fn as (s: unknown) => unknown)(state);
  if (!(out instanceof Uint8Array)) {
    throw new Error("encodeGroupState did not return bytes");
  }
  return out;
}

export function decodeState(bytes: Uint8Array): unknown {
  const fn = (tsMls as Record<string, unknown>)["decodeGroupState"];
  if (typeof fn !== "function") throw new Error("ts-mls has no decodeGroupState");

  // ts-mls decoders take (bytes, offset) and return [value, bytesRead].
  const out = (fn as (b: Uint8Array, o: number) => unknown)(bytes, 0);
  if (Array.isArray(out)) return out[0];
  return out;
}

/**
 * Rebuild the runtime configuration that encoding drops.
 *
 * encodeGroupState loses exactly one field, `clientConfig`, and for a
 * good reason: it holds an authentication service and other callables,
 * which cannot be serialised at all.
 *
 * So it is reconstructed from the library defaults rather than carried
 * across from the old object. That matters beyond tidiness - a config
 * captured before a restart could hold stale callables closed over a
 * previous session, and restoring those would be worse than rebuilding.
 */
function defaultClientConfig(): ClientConfig {
  // Typed against ts-mls's own ClientConfig so a wrong key name is a
  // compile error. It used to be an untyped record, which let
  // `authenticationService` stand in for the real key `authService`:
  // every group loaded from storage then had no auth service, and the
  // first commit failed reading `validateCredential` off undefined.
  return {
    paddingConfig: defaultPaddingConfig,
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    authService: defaultAuthenticationService,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  };
}

/** Decode stored state and make it usable again. */
export function restoreState(bytes: Uint8Array): unknown {
  const decoded = decodeState(bytes) as Record<string, unknown>;
  return { ...decoded, clientConfig: defaultClientConfig() };
}

/**
 * Serialise a ratchet tree for transport.
 *
 * A joiner needs the group's ratchet tree alongside the welcome, and it
 * has to reach them through the server as bytes.
 *
 * The RFC-intended route is the ratchet_tree extension, which would make
 * the welcome self-contained. ts-mls exposes no encoder for a bare tree
 * and no documented way to populate that extension, and several attempts
 * at inferring one failed. So this is a deliberate detour: JSON with
 * base64 for the binary leaves, which is wholly under our control.
 *
 * What it costs: the bytes are not MLS wire format, so another MLS
 * implementation could not read them. That matters only for
 * interoperability we do not have and are not promising, and swapping
 * the provider would change this layer anyway. Recorded in
 * docs/decisions.md rather than left as a surprise.
 *
 * What it does not cost: anything cryptographic. A ratchet tree is public
 * data - it is what a joiner is given precisely because it reveals no
 * secrets - so how it is framed in transit is a compatibility question,
 * not a security one.
 */
const U8_TAG = "__u8";
const BIGINT_TAG = "__bigint";
const UNDEF_TAG = "__undef";

export function encodeTree(tree: unknown): Uint8Array {
  const json = JSON.stringify(normaliseUndefined(tree), (_key, value) => {
    if (value instanceof Uint8Array) {
      let binary = "";
      for (const byte of value) binary += String.fromCharCode(byte);
      return { [U8_TAG]: btoa(binary) };
    }

    // MLS leaf indices and generations exceed what a JavaScript number
    // represents exactly, so ts-mls uses BigInt. JSON has no form for
    // one and throws rather than guessing, which is the right call:
    // silently narrowing to a float would corrupt a tree in a way that
    // might not surface until much later.
    if (typeof value === "bigint") {
      return { [BIGINT_TAG]: value.toString() };
    }

    // Blank nodes in a ratchet tree are `undefined`, and JSON turns an
    // undefined array entry into null. That difference matters: ts-mls
    // tests for an absent node, a null passes the test, and it then
    // reads a property off nothing.
    //
    // This is the serialisation failure worth watching for - not the
    // kind that throws, but the kind that succeeds and quietly returns
    // something subtly different.
    if (value === undefined) {
      return { [UNDEF_TAG]: true };
    }

    return value;
  });

  return new TextEncoder().encode(json);
}

/**
 * Replace undefined with its tag before stringifying.
 *
 * Done as a pre-pass rather than relying on the replacer alone, because
 * an engine may convert an undefined array entry to null before the
 * replacer is ever consulted for it. Walking the structure first removes
 * the ambiguity.
 */
function normaliseUndefined(value: unknown): unknown {
  if (value === undefined) return { [UNDEF_TAG]: true };
  if (value === null || value instanceof Uint8Array) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((entry) => normaliseUndefined(entry));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = normaliseUndefined(entry);
  }
  return out;
}

export function decodeTree(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes), (_key, value) => {
    if (value === null || typeof value !== "object") return value;

    const tagged = value as Record<string, unknown>;

    if (typeof tagged[U8_TAG] === "string") {
      const binary = atob(tagged[U8_TAG] as string);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    }

    if (typeof tagged[BIGINT_TAG] === "string") {
      return BigInt(tagged[BIGINT_TAG] as string);
    }

    if (tagged[UNDEF_TAG] === true) {
      return undefined;
    }

    return value;
  });
}

/**
 * The MLS group ID of a state, as text.
 *
 * Group IDs are chosen by us (the channel ID, plus a generation after a
 * reset; see Groups), so they are always valid UTF-8.
 */
export function groupIdOf(state: unknown): string {
  const group = state as { groupContext?: { groupId?: Uint8Array } };
  const id = group.groupContext?.groupId;
  if (!(id instanceof Uint8Array)) throw new Error("mls: state has no group ID");
  return new TextDecoder().decode(id);
}

/**
 * The epoch a group state is currently at.
 *
 * Needed because the server orders commits by epoch and a client has to
 * tell it which one its commit builds on. ts-mls keeps this as a BigInt;
 * it is narrowed here because the server stores it as a 64-bit integer
 * and no group will approach the point where that loses precision.
 */
export function epochOf(state: unknown): number {
  const group = state as { groupContext?: { epoch?: bigint | number } };
  const epoch = group.groupContext?.epoch;
  if (epoch === undefined) throw new Error("mls: state has no epoch");
  return typeof epoch === "bigint" ? Number(epoch) : epoch;
}

export class TsMlsProvider implements MlsProvider {
  readonly name = "ts-mls";

  #impl: Impl | null = null;

  async init(): Promise<void> {
    if (this.#impl) return;
    this.#impl = await getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE));
  }

  /** The prepared ciphersuite. Null until init() has run. */
  get impl(): Impl | null {
    return this.#impl;
  }

  #require(): Impl {
    if (!this.#impl) {
      throw new Error("mls: init() must be called before use");
    }
    return this.#impl;
  }

  async generateKeyPackage(identity: string): Promise<KeyPair> {
    const credential: Credential = {
      credentialType: "basic",
      identity: new TextEncoder().encode(identity),
    };

    const pkg = await generateKeyPackage(
      credential,
      defaultCapabilities(),
      defaultLifetime,
      [],
      this.#require(),
    );

    return { publicPackage: pkg.publicPackage, privatePackage: pkg.privatePackage };
  }

  encodeKeyPackage(keys: KeyPair): WireMessage {
    return encodeMlsMessage({
      keyPackage: keys.publicPackage as never,
      wireformat: "mls_key_package",
      version: "mls10",
    });
  }

  async createGroup(groupId: string, keys: KeyPair): Promise<GroupState> {
    return createGroup(
      new TextEncoder().encode(groupId),
      keys.publicPackage as never,
      keys.privatePackage as never,
      [],
      this.#require(),
    );
  }

  /**
   * Observed from ts-mls 1.6.2: the tree is a flat array in which even
   * indices are leaves and odd indices are parents, so a leaf's index is
   * its array index divided by two. A blank node is `undefined` in a live
   * state and a hole after our tree codec, so anything that is not
   * explicitly a leaf is skipped. A leaf's identity is the device ID we
   * put in its basic credential at key-package time. ts-mls has
   * getGroupMembers for this but it does not return leaf indexes.
   */
  memberLeaves(state: GroupState): MemberLeaf[] {
    const tree = (state as { ratchetTree?: unknown[] }).ratchetTree ?? [];
    const decoder = new TextDecoder();
    const out: MemberLeaf[] = [];
    for (let i = 0; i < tree.length; i += 2) {
      const n = tree[i] as
        | { nodeType?: string; leaf?: { credential?: { identity?: Uint8Array } } }
        | undefined;
      if (n?.nodeType !== "leaf") continue;
      const identity = n.leaf?.credential?.identity;
      if (identity) out.push({ leafIndex: i / 2, identity: decoder.decode(identity) });
    }
    return out;
  }

  memberIdentities(state: GroupState): string[] {
    return this.memberLeaves(state).map((l) => l.identity);
  }

  ownLeafIndex(state: GroupState): number {
    return (state as { privatePath: { leafIndex: number } }).privatePath.leafIndex;
  }

  /**
   * ts-mls keeps only the private signature key in the state, and its
   * Signature interface cannot derive the public half. So rather than
   * compare keys, sign a random probe with our private key and verify it
   * against the public key in the leaf at our index: it verifies only if
   * that leaf is still ours.
   */
  async stillMember(state: GroupState): Promise<boolean> {
    const s = state as {
      groupActiveState?: { kind: string };
      ratchetTree: unknown[];
      signaturePrivateKey: Uint8Array;
    };
    if (s.groupActiveState?.kind === "removedFromGroup") return false;

    const node = s.ratchetTree[this.ownLeafIndex(state) * 2] as
      | { nodeType?: string; leaf?: { signaturePublicKey?: Uint8Array } }
      | undefined;
    const publicKey = node?.nodeType === "leaf" ? node.leaf?.signaturePublicKey : undefined;
    if (!publicKey) return false;

    const sig = this.#require().signature;
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const signature = await sig.sign(s.signaturePrivateKey, probe);
    return sig.verify(publicKey, probe, signature);
  }

  async removeMembers(state: GroupState, leafIndexes: number[]): Promise<CommitResult> {
    // Shape observed in Node (decisions.md, "External commit works").
    const proposals: Proposal[] = leafIndexes.map((removed) => ({
      proposalType: "remove",
      remove: { removed },
    }));

    const result = await createCommit(
      { state: state as never, cipherSuite: this.#require() },
      { extraProposals: proposals },
    );
    // No welcome: nobody is joining. The tree is not needed either.
    return {
      state: result.newState,
      commit: encodeCommit(result.commit),
      wipeSpent: spentWiper(result.consumed),
    };
  }

  async addMembers(state: GroupState, keyPackages: WireMessage[]): Promise<CommitResult> {
    const proposals: Proposal[] = keyPackages.map((raw) => {
      const decoded = decodeMlsMessage(raw, 0)?.[0];
      if (!decoded || decoded.wireformat !== "mls_key_package") {
        throw new Error("mls: expected a key package");
      }
      return { proposalType: "add", add: { keyPackage: decoded.keyPackage } };
    });

    const result = await createCommit(
      { state: state as never, cipherSuite: this.#require() },
      { extraProposals: proposals },
    );

    return {
      state: result.newState,
      wipeSpent: spentWiper(result.consumed),
      commit: encodeCommit(result.commit),
      welcome: result.welcome
        ? encodeMlsMessage({
            welcome: result.welcome,
            wireformat: "mls_welcome",
            version: "mls10",
          })
        : undefined,
      ratchetTree: (result.newState as { ratchetTree: unknown }).ratchetTree,
    };
  }

  /**
   * The tree rides inside the GroupInfo (ratchet_tree extension), so a
   * joiner needs nothing else. Observed in Node, 2026-10-30: this is the
   * one ts-mls route that puts a tree inside a message, about 300 bytes
   * per member. Welcomes still carry the tree in our JSON codec.
   */
  async groupInfo(state: GroupState): Promise<WireMessage> {
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
      state as never,
      [],
      this.#require(),
    );
    return encodeMlsMessage({
      groupInfo,
      wireformat: "mls_group_info",
      version: "mls10",
    });
  }

  /**
   * resync is always false. With true, ts-mls looks for this device's
   * old leaf by signature key, a fresh key package never matches, and
   * the tree walk never ends (decisions.md, ts-mls list). A device that
   * rejoins this way briefly holds two leaves; reconcile removes the old
   * one.
   *
   * joinGroupExternal returns a bare PublicMessage, so it is wrapped
   * here; members apply it with processPublicMessage (see decrypt).
   */
  async joinExternal(groupInfo: WireMessage, keys: KeyPair) {
    const decoded = decodeMlsMessage(groupInfo, 0)?.[0];
    if (!decoded || decoded.wireformat !== "mls_group_info") {
      throw new Error("mls: expected a group info message");
    }

    const result = await joinGroupExternal(
      decoded.groupInfo,
      keys.publicPackage as never,
      keys.privatePackage as never,
      false,
      this.#require(),
    );

    return {
      state: result.newState as GroupState,
      commit: encodeMlsMessage({
        publicMessage: result.publicMessage,
        wireformat: "mls_public_message",
        version: "mls10",
      }),
    };
  }

  async joinGroup(
    welcome: WireMessage,
    keys: KeyPair,
    ratchetTree: unknown,
  ): Promise<GroupState> {
    const decoded = decodeMlsMessage(welcome, 0)?.[0];
    if (!decoded || decoded.wireformat !== "mls_welcome") {
      throw new Error("mls: expected a welcome message");
    }

    return joinGroup(
      decoded.welcome,
      keys.publicPackage as never,
      keys.privatePackage as never,
      emptyPskIndex,
      this.#require(),
      ratchetTree as never,
    );
  }

  async encrypt(state: GroupState, plaintext: Uint8Array) {
    const result = await createApplicationMessage(
      state as never,
      plaintext,
      this.#require(),
    );

    result.consumed.forEach(zeroOutUint8Array);

    return {
      state: result.newState as GroupState,
      message: encodeMlsMessage({
        privateMessage: result.privateMessage,
        wireformat: "mls_private_message",
        version: "mls10",
      }),
    };
  }

  async decrypt(state: GroupState, message: WireMessage): Promise<DecryptResult> {
    const decoded = decodeMlsMessage(message, 0)?.[0];

    // An external join: the only handshake MLS frames in the clear,
    // because the joiner holds no group secrets to encrypt it with.
    if (decoded?.wireformat === "mls_public_message") {
      const result = await processPublicMessage(
        state as never,
        decoded.publicMessage,
        emptyPskIndex,
        this.#require(),
      );
      return { state: result.newState as GroupState };
    }

    if (!decoded || decoded.wireformat !== "mls_private_message") {
      throw new Error("mls: expected a private message");
    }

    const result = await processPrivateMessage(
      state as never,
      decoded.privateMessage,
      emptyPskIndex,
      this.#require(),
    );

    // A handshake message advances the group without carrying content.
    if (result.kind === "newState") {
      return { state: result.newState as GroupState };
    }

    result.consumed.forEach(zeroOutUint8Array);

    return {
      state: result.newState as GroupState,
      plaintext: result.message,
    };
  }

  async exportSecret(
    state: GroupState,
    label: string,
    length: number,
    context: Uint8Array = new Uint8Array(),
  ): Promise<Uint8Array> {
    const impl = this.#require();

    // RFC 9420 section 8.5. Signature observed from ts-mls 1.6.2 rather
    // than inferred:
    //
    //   mlsExporter(exporterSecret, label, context, length, ciphersuite)
    //
    // It derives from the key schedule's exporter secret, not from the
    // group state, which is why passing the state silently failed.
    const group = state as { keySchedule: { exporterSecret: Uint8Array } };

    // Context binds the output to its use (media keys pass the channel
    // ID). The epoch needs no context: each epoch has its own exporter
    // secret.
    return tsMls.mlsExporter(
      group.keySchedule.exporterSecret,
      label,
      context,
      length,
      impl,
    ) as Promise<Uint8Array>;
  }
}
