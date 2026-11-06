// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * QR login links (server signinlinks.go; decisions.md, Feature decisions,
 * "Planned", "QR login settled").
 *
 * The link is `https://<server>/#signin=<id>.<secret>`. The id comes from
 * the server; the secret is made here and stays in the URL fragment,
 * which browsers never send, so the server never learns it. The handover
 * (the recovery backup id and key) travels sealed under a key derived
 * from the secret, with the id bound in, so the server relays it blind
 * and cannot move it to another link.
 */

const SECRET_BYTES = 32;
const PARAM = "signin";
const utf8 = new TextEncoder();

/** What the signed-in device hands the new one. */
export interface Handover {
  readonly v: 1;
  /** The recovery backup this device can read, if any. */
  readonly backup?: { readonly id: string; readonly key: string };
}

export interface LinkParts {
  readonly id: string;
  readonly secret: string;
}

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A fresh secret for a new link. */
export function newLinkSecret(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** The link to show as a QR code and to copy. */
export function linkUrl(origin: string, parts: LinkParts): string {
  return `${origin}/#${PARAM}=${parts.id}.${parts.secret}`;
}

/**
 * The id and secret from a pasted link or a location hash; null when it
 * is not a sign-in link. Accepts the whole address or just the `#...`.
 */
export function parseLink(text: string): LinkParts | null {
  const hash = text.trim().split("#")[1];
  if (!hash) return null;
  const value = new URLSearchParams(hash).get(PARAM);
  const m = value ? /^([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(value) : null;
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

async function handoverKey(parts: LinkParts, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", fromB64url(parts.secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8.encode(parts.id), info: utf8.encode("openvoxa sign-in link v1 handover") },
    ikm, { name: "AES-GCM", length: 256 }, false, [usage],
  );
}

function aad(id: string): Uint8Array<ArrayBuffer> {
  return utf8.encode(`openvoxa sign-in link v1 ${id}`);
}

/** Seal the handover for the server to relay: IV || AES-GCM ciphertext. */
export async function sealHandover(parts: LinkParts, handover: Handover): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(parts.id) },
    await handoverKey(parts, "encrypt"), utf8.encode(JSON.stringify(handover)),
  ));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return out;
}

/** Undo sealHandover; null when it does not open (wrong link, or altered). */
export async function openHandover(parts: LinkParts, sealed: Uint8Array): Promise<Handover | null> {
  if (sealed.length < 12 + 16) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: aad(parts.id) },
      await handoverKey(parts, "decrypt"), sealed.slice(12),
    );
    const h = JSON.parse(new TextDecoder().decode(plain)) as Handover;
    return h?.v === 1 ? h : null;
  } catch {
    return null;
  }
}

/** Raw key bytes for Handover.backup.key, and back. */
export const handoverBytes = { encode: toB64url, decode: fromB64url };
