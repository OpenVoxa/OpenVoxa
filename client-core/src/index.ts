// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * OpenVoxa client-core.
 *
 * Protocol and cryptography, with no user interface. Shared by the web
 * client, the desktop client, and for now the debug page.
 *
 * At this stage it contains only the MLS layer. The rest of the client
 * logic still lives inline in the debug page and moves here as
 * client-web is built.
 */

import { TsMlsProvider } from "./mls/tsmls.js";
import type { MlsProvider } from "./mls/provider.js";

export type {
  CommitResult,
  DecryptResult,
  GroupState,
  KeyPair,
  MlsProvider,
  WireMessage,
} from "./mls/provider.js";

export { TsMlsProvider } from "./mls/tsmls.js";

export const VERSION = "0.1.0";

/** The provider this build uses. Swapping implementations happens here. */
export function createMlsProvider(): MlsProvider {
  return new TsMlsProvider();
}

export interface SelfTestResult {
  readonly ok: boolean;
  readonly provider: string;
  readonly steps: string[];
  readonly error?: string;
  readonly elapsedMs: number;
}

/**
 * Run a complete two-party MLS exchange in the browser.
 *
 * This exists to prove the toolchain before any of it is wired into the
 * application: that the library bundles, that WebCrypto is available and
 * behaves, and that a group can actually be created, joined, and used.
 * Those are the parts most likely to fail in an unexpected environment,
 * and finding out here is much cheaper than finding out halfway through
 * the protocol work.
 *
 * It also checks that both members derive an identical exported secret,
 * which is how voice and screen-share media will be keyed. A divergence
 * there would otherwise go unnoticed until media encryption is built.
 *
 * It creates two identities locally. Nothing touches the network and
 * nothing is persisted.
 */
export async function selfTest(): Promise<SelfTestResult> {
  const started = performance.now();
  const steps: string[] = [];
  const provider = createMlsProvider();

  try {
    await provider.init();
    steps.push(`ciphersuite ready (${provider.name})`);

    const alice = await provider.generateKeyPackage("alice-device");
    const bob = await provider.generateKeyPackage("bob-device");
    steps.push("generated two key packages");

    let aliceGroup = await provider.createGroup("selftest", alice);
    steps.push("created a group");

    const bobPackage = provider.encodeKeyPackage(bob);
    steps.push(`encoded a key package (${bobPackage.length} bytes)`);

    const commit = await provider.addMembers(aliceGroup, [bobPackage]);
    aliceGroup = commit.state;

    if (!commit.welcome) throw new Error("expected a welcome message");
    steps.push(
      `committed an add: commit ${commit.commit.length} bytes, ` +
      `welcome ${commit.welcome.length} bytes`,
    );

    let bobGroup = await provider.joinGroup(commit.welcome, bob, commit.ratchetTree);
    steps.push("second member joined from the welcome");

    const plaintext = new TextEncoder().encode("hello from the self test");
    const encrypted = await provider.encrypt(aliceGroup, plaintext);
    aliceGroup = encrypted.state;
    steps.push(`encrypted ${plaintext.length} bytes into ${encrypted.message.length}`);

    const decrypted = await provider.decrypt(bobGroup, encrypted.message);
    bobGroup = decrypted.state;

    if (!decrypted.plaintext) throw new Error("no plaintext returned");

    const roundTripped = new TextDecoder().decode(decrypted.plaintext);
    if (roundTripped !== "hello from the self test") {
      throw new Error(`round trip mismatch: ${roundTripped}`);
    }
    steps.push("decrypted and matched the original");

    // Exercised here because voice and screen-share keys will be derived
    // this way, and a mismatch between the two sides would otherwise only
    // surface when media encryption is built.
    const aliceKey = await provider.exportSecret(aliceGroup, "openvoxa media", 32);
    const bobKey = await provider.exportSecret(bobGroup, "openvoxa media", 32);

    if (aliceKey.length !== 32) {
      throw new Error(`exported key was ${aliceKey.length} bytes, expected 32`);
    }
    if (!aliceKey.every((byte, i) => byte === bobKey[i])) {
      throw new Error("exported secrets differ between members");
    }
    steps.push("both members derived the same 32-byte media key");

    return {
      ok: true,
      provider: provider.name,
      steps,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    return {
      ok: false,
      provider: provider.name,
      steps,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}
