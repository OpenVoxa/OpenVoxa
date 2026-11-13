// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The server's name and icon (server serverinfo.go; decisions.md Feature
 * decisions, "Server name and icon"). Public, so fetched before sign-in:
 * the sign-in page shows the name. Sets the browser tab's title and icon,
 * and is fetched again when the server says it changed
 * (server_info_changed). In the desktop app it also tells the shell to
 * fetch them again for the server pane; the shell fetches them itself, so
 * this page never hands the shell anything but the nudge.
 */

import { useSyncExternalStore } from "react";

export interface ServerInfo {
  /** "" when the administrator set none. */
  name: string;
  /** A path on this server, with the version in it, or null. */
  icon: string | null;
  /** The Home banner (home.tsx), shown at the top of the sign-in card too. */
  banner: string | null;
}

let info: ServerInfo = { name: "", icon: null, banner: null };
const listeners = new Set<() => void>();

function apply(next: ServerInfo): void {
  info = next;
  document.title = next.name || "OpenVoxa";
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  // Without a server icon, the OpenVoxa icon (also the app's default icon).
  link.href = next.icon ?? "/icons/icon-192.png";
  for (const l of listeners) l();
}

/** Fetch the name and icon again. Failures keep what is shown. */
export async function refreshServerInfo(): Promise<void> {
  try {
    const res = await fetch("/api/v1/server-info");
    if (!res.ok) return;
    const body = (await res.json()) as Partial<ServerInfo>;
    apply({
      name: typeof body.name === "string" ? body.name : "",
      icon: typeof body.icon === "string" ? body.icon : null,
      banner: typeof body.banner === "string" ? body.banner : null,
    });
  } catch {
    /* offline: keep what is shown */
  }
}

/** After server_info_changed: fetch again, and nudge the desktop app. */
export function serverInfoChanged(): void {
  void refreshServerInfo();
  const desktop = (window as unknown as { openvoxaDesktop?: { serverInfoChanged?: () => void } }).openvoxaDesktop;
  desktop?.serverInfoChanged?.();
}

export function useServerInfo(): ServerInfo {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => info,
  );
}

/**
 * The sign-in pages' heading. Branding first: the Home banner across the
 * top of the card, if there is one, then the server's icon and name,
 * largest, so people know at once which server they are signing in to,
 * with "OpenVoxa" small under it. Without a name: OpenVoxa, as before.
 */
export function AuthHeading() {
  const { name, icon, banner } = useServerInfo();
  return (
    <div className="auth-brand">
      {banner && <img className="auth-banner" src={banner} alt="" />}
      {icon && <img className="auth-icon" src={icon} alt="" />}
      <h1>{name || "OpenVoxa"}</h1>
      {name && <span className="auth-app">OpenVoxa</span>}
    </div>
  );
}
