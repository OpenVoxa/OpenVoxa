// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as tsMls from "ts-mls";
import {
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processPrivateMessage,
  zeroOutUint8Array,
  type Credential,
  type Proposal,
} from "ts-mls";

import type {
  CommitResult,
  DecryptResult,
  GroupState,
  KeyPair,
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
function defaultClientConfig(): Record<string, unknown> {
  const lib = tsMls as Record<string, unknown>;
  return {
    paddingConfig: lib["defaultPaddingConfig"],
    keyRetentionConfig: lib["defaultKeyRetentionConfig"],
    lifetimeConfig: lib["defaultLifetimeConfig"],
    authenticationService: lib["defaultAuthenticationService"],
    keyPackageEqualityConfig: lib["defaultKeyPackageEqualityConfig"],
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

export function encodeTree(tree: unknown): Uint8Array {
  const json = JSON.stringify(tree, (_key, value) => {
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

    return value;
  });

  return new TextEncoder().encode(json);
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

    return value;
  });
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

    // ts-mls hands back the key material it just used so the caller can
    // destroy it. Skipping this leaves spent keys sitting in memory,
    // which quietly weakens forward secrecy: the whole point is that a
    // device compromised later cannot read what was sent earlier.
    result.consumed.forEach(zeroOutUint8Array);

    return {
      state: result.newState,
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

    // Context is empty for now. When media keys are derived it carries
    // the channel and epoch, so two uses of the same group cannot
    // produce the same key.
    return tsMls.mlsExporter(
      group.keySchedule.exporterSecret,
      label,
      new Uint8Array(),
      length,
      impl,
    ) as Promise<Uint8Array>;
  }
}
