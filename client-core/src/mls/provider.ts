// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The surface OpenVoxa uses from an MLS implementation.
 *
 * This interface exists so the implementation can be replaced without
 * touching anything above it. Today it is backed by ts-mls, which is pure
 * TypeScript and installs with npm. The likely successor is OpenMLS
 * compiled to WebAssembly, which is more heavily scrutinised but requires
 * authoring a Rust wrapper crate and adding a Rust toolchain to the
 * build.
 *
 * Writing the protocol against an interface means that decision stays
 * open, and the swap is a new file rather than a rewrite. See
 * docs/decisions.md.
 *
 * Nothing here persists state. Group state is immutable and returned from
 * every operation; callers hold the current value and are responsible for
 * storing it.
 */

/** An opaque MLS group state. Treated as a value, never mutated. */
export type GroupState = unknown;

/** Serialised MLS wire-format bytes, safe to hand to the server. */
export type WireMessage = Uint8Array;

export interface KeyPair {
  /** Published to the server so others can add this device to a group. */
  readonly publicPackage: unknown;
  /** Never leaves this device. */
  readonly privatePackage: unknown;
}

export interface CommitResult {
  readonly state: GroupState;
  /** The commit, broadcast to existing members. */
  readonly commit: WireMessage;
  /** Sent to members added by this commit, if any. */
  readonly welcome?: WireMessage;
  /** The group's ratchet tree, which a joiner needs alongside a welcome. */
  readonly ratchetTree?: unknown;
}

export interface DecryptResult {
  readonly state: GroupState;
  /** Absent when the message advanced the group rather than carrying content. */
  readonly plaintext?: Uint8Array;
}

export interface MlsProvider {
  /** Human-readable identifier, surfaced in diagnostics. */
  readonly name: string;

  /** Prepare the ciphersuite. Must be called before anything else. */
  init(): Promise<void>;

  /**
   * Generate this device's credential and key package.
   *
   * identity is the stable device identifier the server knows. It is
   * carried inside the credential, so every member of a group can see
   * which device authored a message.
   */
  generateKeyPackage(identity: string): Promise<KeyPair>;

  /** Encode a key package for publication to the server. */
  encodeKeyPackage(keys: KeyPair): WireMessage;

  /** Create a new group containing only this device. */
  createGroup(groupId: string, keys: KeyPair): Promise<GroupState>;

  /**
   * The identities (device IDs) of every member currently in the group,
   * read from this device's copy of the ratchet tree.
   */
  memberIdentities(state: GroupState): string[];

  /** Add members by their published key packages and produce a commit. */
  addMembers(state: GroupState, keyPackages: WireMessage[]): Promise<CommitResult>;

  /** Join a group from a welcome message. */
  joinGroup(
    welcome: WireMessage,
    keys: KeyPair,
    ratchetTree: unknown,
  ): Promise<GroupState>;

  /** Encrypt an application message. */
  encrypt(state: GroupState, plaintext: Uint8Array): Promise<{
    readonly state: GroupState;
    readonly message: WireMessage;
  }>;

  /** Decrypt an application message, or apply a handshake message. */
  decrypt(state: GroupState, message: WireMessage): Promise<DecryptResult>;

  /**
   * Derive a key for another protocol from the group's current epoch.
   *
   * This is how voice and screen-share media will be keyed: the same
   * group that protects text produces the media key, so membership
   * changes rotate both at once and there is one key schedule rather
   * than two.
   */
  exportSecret(
    state: GroupState,
    label: string,
    length: number,
  ): Promise<Uint8Array>;
}
