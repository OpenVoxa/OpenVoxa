// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { KeyPair, MlsProvider } from "./mls/provider.js";
import { storage, type StoredDevice } from "./storage.js";

/**
 * Device identity and key package lifecycle.
 *
 * A device is the cryptographic identity here, not an account. It holds
 * its own key material and appears as its own leaf in every group, which
 * is what lets one person read a channel on two machines without either
 * holding the other's private keys.
 *
 * Key packages are published in advance because you are almost always
 * offline when someone adds you to a group. The server hands them out one
 * at a time and never sees a private half.
 */

/** How many unused key packages to keep published. */
const TARGET_POOL = 25;

/** Replenish when the server reports fewer than this remaining. */
const LOW_WATER = 10;

/**
 * Performs an API request and returns the parsed JSON body. On a non-2xx
 * response it must throw an Error carrying the HTTP status as `status`
 * and the server's `error` (or `reason`) text as its message.
 */
export interface ApiCall {
  (path: string, init?: RequestInit): Promise<unknown>;
}

export interface IdentityStatus {
  readonly deviceId: string;
  readonly label: string;
  readonly available: number;
  readonly hasLastResort: boolean;
  readonly published: number;
}

interface CountResponse {
  available: number;
  has_last_resort: boolean;
  low_water: number;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class Identity {
  readonly #mls: MlsProvider;
  readonly #call: ApiCall;

  #device: StoredDevice | null = null;

  constructor(mls: MlsProvider, call: ApiCall) {
    this.#mls = mls;
    this.#call = call;
  }

  get device(): StoredDevice | null {
    return this.#device;
  }

  /**
   * Load the existing device, or create and register a new one.
   *
   * The ID is generated here rather than by the server because it goes
   * inside the MLS credential, which has to exist before registration
   * would otherwise happen. See migration 0009.
   *
   * A device belongs to one account. Signing in as someone else on the
   * same browser produces a new device rather than reusing this one,
   * because reusing it would put two accounts behind one cryptographic
   * identity.
   */
  async ensureDevice(userId: string, label: string): Promise<StoredDevice> {
    const existing = await storage.getDevice();

    if (existing && existing.userId === userId) {
      this.#device = existing;
      return existing;
    }

    if (existing) {
      // Different account on this browser. The previous device's keys are
      // useless to the new account and must not linger.
      await storage.wipe();
    }

    const device: StoredDevice = {
      id: crypto.randomUUID(),
      label,
      userId,
      createdAt: Date.now(),
    };

    await this.#call("/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({ id: device.id, label: device.label }),
    });

    await storage.setDevice(device);
    this.#device = device;
    return device;
  }

  /**
   * Generate and publish key packages, keeping the pool topped up.
   *
   * Returns how many were published, which is zero when the pool is
   * already healthy. Safe to call on every sign-in.
   */
  async replenish(force = false): Promise<IdentityStatus> {
    const device = this.#device;
    if (!device) throw new Error("identity: no device registered");

    const count = (await this.#call(
      `/api/v1/devices/${device.id}/key-packages`,
    )) as CountResponse;

    const needed = force
      ? TARGET_POOL
      : count.available < LOW_WATER
        ? TARGET_POOL - count.available
        : 0;

    const wantsLastResort = !count.has_last_resort;

    if (needed <= 0 && !wantsLastResort) {
      return {
        deviceId: device.id,
        label: device.label,
        available: count.available,
        hasLastResort: count.has_last_resort,
        published: 0,
      };
    }

    const packages: string[] = [];

    for (let i = 0; i < needed; i++) {
      packages.push(await this.#generateAndStore(device.id));
    }

    // The last-resort package is reusable, which weakens forward secrecy
    // for anyone who joins using it. It exists so that an add degrades
    // rather than failing outright when the pool is empty, and clients
    // replenish well before reaching it.
    const lastResort = wantsLastResort
      ? await this.#generateAndStore(device.id)
      : "";

    const updated = (await this.#call(
      `/api/v1/devices/${device.id}/key-packages`,
      {
        method: "POST",
        body: JSON.stringify({ packages, last_resort: lastResort }),
      },
    )) as CountResponse;

    return {
      deviceId: device.id,
      label: device.label,
      available: updated.available,
      hasLastResort: updated.has_last_resort,
      published: packages.length + (lastResort ? 1 : 0),
    };
  }

  /**
   * Generate one key package, keep the private half locally, and return
   * the public half encoded for publication.
   *
   * Storing the private half BEFORE publishing matters. If the order were
   * reversed and the write failed, the server would hand out a package
   * nobody could use, and the resulting welcome messages would be
   * undecryptable with no obvious cause.
   */
  async #generateAndStore(deviceId: string): Promise<string> {
    const keys: KeyPair = await this.#mls.generateKeyPackage(deviceId);
    const encoded = this.#mls.encodeKeyPackage(keys);

    // Keyed by the encoded public package, since that is what comes back
    // in a welcome and is the only handle the other side has.
    const digest = await crypto.subtle.digest("SHA-256", encoded as BufferSource);
    const id = toBase64(new Uint8Array(digest));

    await storage.putKeyPair({
      id,
      publicPackage: keys.publicPackage,
      privatePackage: keys.privatePackage,
      createdAt: Date.now(),
    });

    return toBase64(encoded);
  }

  /** Forget this device entirely. Called on sign-out. */
  async forget(): Promise<void> {
    this.#device = null;
    await storage.wipe();
  }
}
