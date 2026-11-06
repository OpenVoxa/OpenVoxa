// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Thin wrapper over the server's REST API.
 *
 * The client is served by the same server it talks to, so every path is
 * relative ("/api/v1/..."), with no server URL to configure. The desktop
 * client will add one later.
 */

export interface Session {
  token: string;
  expires_at: string;
  user_id: string;
  username: string;
  permissions: string[];
  rank: number;
  groups: { id: string; name: string }[];
  /** The server requires two-factor and this account has none (TwoFactor.tsx). */
  two_factor_setup_required?: boolean;
}

/**
 * The server refused a request because this account must set up
 * two-factor first (Server settings, Security). Reload: the app then
 * starts at the setup screen (App.tsx). Once per page.
 */
let gateHit = false;
export function twoFactorGate(status: number, data: any): void {
  if (status === 403 && data?.code === "two_factor_setup_required" && !gateHit) {
    gateHit = true;
    location.reload();
  }
}

/** An error the server explained, with its HTTP status. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function call<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  // The server always answers errors as {"error": "..."}; anything else
  // (a proxy's HTML page, an empty body) gets a generic message.
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    twoFactorGate(res.status, data);
    throw new ApiError(res.status, data?.error ?? `request failed (${res.status})`);
  }
  return data as T;
}

/** A readable device name for the session list, e.g. "Firefox on Windows". */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const os = /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Mac OS/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "unknown OS";
  return `${browser} on ${os}`;
}
