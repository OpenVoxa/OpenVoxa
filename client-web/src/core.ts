// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Glue between client-web and client-core: the authenticated request
 * function client-core expects, websocket URLs, and the one crypto
 * session per signed-in account.
 */

import { startSession, type Session as CryptoSession } from "@core/index";
import type { ApiCall } from "@core/identity";
import type { KeyValueStore } from "@core/chat";
import { ApiError, guessDeviceName, accountGate } from "./api";

/**
 * client-core's ApiCall: JSON in and out, the session token added, and
 * errors as ApiError so client-core can read `.status` (it rebases on a
 * 409 epoch conflict). onUnauthorized fires on a 401: the session ended.
 */
export function apiCall(token: string, onUnauthorized?: () => void): ApiCall {
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    // FormData (an upload) needs the browser's own multipart Content-Type.
    if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(path, { ...init, headers });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      if (res.status === 401) onUnauthorized?.();
      accountGate(res.status, data);
      // Some refusals carry `reason` (an epoch conflict on commit).
      throw new ApiError(res.status, data?.error ?? data?.reason ?? `request failed (${res.status})`);
    }
    return data;
  };
}

/** "/api/v1/ws?..." on this page's own server, as ws:// or wss://. */
export function wsUrl(pathAndQuery: string): string {
  const url = new URL(pathAndQuery, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

// One crypto session per account and page. React's StrictMode runs
// effects twice in development, and two Identity.start calls at once
// could register two devices; sharing the promise prevents that.
const sessions = new Map<string, Promise<CryptoSession>>();

export function cryptoSession(userId: string, call: ApiCall): Promise<CryptoSession> {
  let p = sessions.get(userId);
  if (!p) {
    p = startSession(call, userId, guessDeviceName());
    sessions.set(userId, p);
    p.catch(() => sessions.delete(userId));
  }
  return p;
}

/** Forget the cached session (after sign-out wiped the device). */
export function dropCryptoSession(userId: string): void {
  sessions.delete(userId);
}

/** localStorage, quietly in memory when the browser refuses it. */
export const localStore: KeyValueStore = (() => {
  const fallback = new Map<string, string>();
  return {
    get(key) {
      try {
        return localStorage.getItem(`openvoxa.${key}`);
      } catch {
        return fallback.get(key) ?? null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`openvoxa.${key}`, value);
      } catch {
        fallback.set(key, value);
      }
    },
  };
})();
