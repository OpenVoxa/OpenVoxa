// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bytes this page has sent to and received from its server, for the
 * About tab's bandwidth line (decisions.md Feature decisions, "About tab
 * in Settings"). A page can only measure its own traffic, so this is
 * "OpenVoxa on this server", not the whole computer.
 *
 * Three sources feed it:
 *  - websockets: chat.ts counts every frame it sends and receives;
 *  - HTTP: the web client counts request bodies (up) and the browser's
 *    resource timing transferSize (down: headers and body as they
 *    arrived, 0 when served from cache);
 *  - the call: VoiceClient.trafficBytes(), read from WebRTC itself, is
 *    added by the caller, because it is a running total kept by the
 *    browser rather than something counted here.
 *
 * Totals only ever grow; rates are worked out by whoever samples them.
 */

let up = 0;
let down = 0;

export function countUp(bytes: number): void {
  if (bytes > 0) up += bytes;
}

export function countDown(bytes: number): void {
  if (bytes > 0) down += bytes;
}

/** Bytes sent and received outside the call since the page loaded. */
export function trafficTotals(): { up: number; down: number } {
  return { up, down };
}

/**
 * The size of a websocket frame or request body, in bytes. Strings are
 * counted as their length: everything we send as text is JSON with
 * base64 payloads, so ASCII, where length and UTF-8 size agree.
 */
export function sizeOf(data: unknown): number {
  if (data == null) return 0;
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  if (typeof URLSearchParams !== "undefined" && data instanceof URLSearchParams) return data.toString().length;
  if (typeof FormData !== "undefined" && data instanceof FormData) {
    let n = 0;
    data.forEach((v, k) => { n += k.length + (typeof v === "string" ? v.length : v.size); });
    return n;
  }
  return 0;
}

/** Counts every frame a websocket sends and receives. */
export function meterSocket(ws: WebSocket): void {
  ws.addEventListener("message", (e) => countDown(sizeOf(e.data)));
  const send = ws.send.bind(ws);
  ws.send = (data) => {
    countUp(sizeOf(data));
    send(data);
  };
}
