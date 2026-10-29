// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

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

/** Which wire format the last commit encoding used, for diagnostics. */
export let lastCommitWireFormat = "unknown";

/**
 * Shape of the last createCommit result, for diagnostics.
 *
 * ts-mls has thin documentation and the published examples disagree with
 * each other across versions. Rather than keep inferring field names from
 * prose, this reports what the library actually returned so the code can
 * be written against observed reality.
 *
 * Remove once the shape is pinned.
 */
export let lastCommitShape = "unknown";

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return `object{${keys.slice(0, 8).join(",")}${keys.length > 8 ? ",..." : ""}}`;
  }
  return typeof value;
}

/**
 * Encode a commit for transport.
 *
 * ts-mls can frame a commit as either a PublicMessage or a
 * PrivateMessage, and the encoder has to be told which. Rather than
 * assume, this tries public framing and falls back to private.
 *
 * The try/catch is deliberate and narrow: both calls are pure encoding of
 * data the library just produced, so a failure here means the shape did
 * not match, not that anything cryptographic went wrong. The format that
 * worked is recorded so it can be pinned once observed.
 */
function encodeCommit(commit: unknown): WireMessage {
  // Already a full MLSMessage? Then it only needs serialising.
  const maybe = commit as { wireformat?: string };
  if (maybe && typeof maybe.wireformat === "string") {
    lastCommitWireFormat = `prewrapped:${maybe.wireformat}`;
    return encodeMlsMessage(commit as never);
  }

  for (const [field, wireformat] of [
    ["publicMessage", "mls_public_message"],
    ["privateMessage", "mls_private_message"],
  ] as const) {
    try {
      const encoded = encodeMlsMessage({
        [field]: commit,
        wireformat,
        version: "mls10",
      } as never);

      // encodeMlsMessage does not always throw on a shape mismatch; it
      // can simply produce nothing. Treat that as a failure too.
      if (encoded instanceof Uint8Array && encoded.length > 0) {
        lastCommitWireFormat = wireformat;
        return encoded;
      }
    } catch {
      // Try the next framing.
    }
  }

  throw new Error(
    `could not encode commit (${describe(commit)}). shape: ${lastCommitShape}`,
  );
}

export class TsMlsProvider implements MlsProvider {
  readonly name = "ts-mls";

  #impl: Impl | null = null;

  async init(): Promise<void> {
    if (this.#impl) return;
    this.#impl = await getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE));
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

    // Record what came back before touching any of it, so a wrong
    // assumption below produces a useful message rather than a bare
    // "undefined".
    lastCommitShape = Object.entries(result as Record<string, unknown>)
      .map(([key, value]) => `${key}: ${describe(value)}`)
      .join(" | ");

    // ts-mls hands back the key material it just used so the caller can
    // destroy it. Skipping this leaves spent keys sitting in memory,
    // which quietly weakens forward secrecy: the whole point is that a
    // device compromised later cannot read what was sent earlier.
    result.consumed?.forEach(zeroOutUint8Array);

    const rawCommit = (result as Record<string, unknown>)["commit"];
    if (rawCommit === undefined) {
      throw new Error(`no commit field on result. shape: ${lastCommitShape}`);
    }

    return {
      state: result.newState,
      commit: encodeCommit(rawCommit),
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
    const group = state as {
      keySchedule: { exporterSecret: Uint8Array };
    };

    // RFC 9420 section 8.5. The context is empty here; when media keys
    // are derived this will carry the channel and epoch so two uses of
    // the same group cannot produce the same key.
    return impl.kdf.expandWithLabel(
      group.keySchedule.exporterSecret,
      new TextEncoder().encode(label),
      await impl.hash.digest(new Uint8Array()),
      length,
    );
  }
}
