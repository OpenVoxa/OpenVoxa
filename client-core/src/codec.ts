// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tagged JSON: JSON that keeps the three things plain JSON loses in MLS
 * data. Uint8Array becomes base64, BigInt a decimal string, and
 * `undefined` (blank ratchet tree nodes) survives instead of turning into
 * null. Each is wrapped in a one-key object ({"__u8": ...} and so on).
 *
 * Used for ratchet trees in transit (mls/tsmls.ts, encodeTree) and for
 * values in encrypted local storage (storage.ts). Only plain objects,
 * arrays, strings, numbers, booleans, null and those three types round
 * trip; a Map, a class instance or a CryptoKey would not. Key packages
 * were checked by experiment to contain nothing else (2026-11-03).
 */
const U8_TAG = "__u8";
const BIGINT_TAG = "__bigint";
const UNDEF_TAG = "__undef";

export function encodeTagged(value: unknown): Uint8Array {
  const json = JSON.stringify(normaliseUndefined(value), (_key, value) => {
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

export function decodeTagged(bytes: Uint8Array): unknown {
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
