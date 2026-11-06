// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel and message links: `https://<server>/#/c/<channel id>` and
 * `https://<server>/#/c/<channel id>/<message id>`. The address is in the
 * fragment, which browsers never send, so the server needs no routes and
 * learns nothing from a link being opened. Ids rather than names, so a
 * rename doesn't break old links.
 *
 * A page opened with one (or a link pasted into this tab's address bar)
 * goes there once signed in, and the fragment is cleared afterwards, as
 * with sign-in links. In chat, links to this server draw as #channel
 * chips that navigate in-app (markdown.tsx).
 */

import { createContext, useContext } from "react";
import type { ChannelInfo } from "@core/chat";

export interface LinkTarget {
  readonly channelId: string;
  readonly messageId?: string;
}

const ID = "[0-9a-fA-F-]{36}";
const FRAGMENT = new RegExp(`^#/c/(${ID})(?:/(${ID}))?/?$`);

/** The address of a channel, or of a message in it. */
export function channelLink(channelId: string, messageId?: string): string {
  return `${location.origin}/#/c/${channelId}${messageId ? `/${messageId}` : ""}`;
}

/** Where a link goes, if it is a channel or message link to this server. */
export function parseTarget(href: string): LinkTarget | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.origin !== location.origin) return null;
  const m = FRAGMENT.exec(u.hash);
  return m ? { channelId: m[1].toLowerCase(), messageId: m[2]?.toLowerCase() } : null;
}

/** Take a target out of this page's address, leaving it clean. */
function takeFromLocation(): LinkTarget | null {
  const t = parseTarget(location.href);
  if (t) history.replaceState(null, "", location.pathname + location.search);
  return t;
}

// The link this page was opened with waits here through signing in.
let pending = takeFromLocation();

/** The link the page was opened with, once; null after that. */
export function takePendingTarget(): LinkTarget | null {
  const t = pending;
  pending = null;
  return t;
}

/** Follow links pasted into this tab's address bar (the page doesn't
 * reload for a fragment change). Returns the unsubscribe. */
export function onAddressTarget(go: (t: LinkTarget) => void): () => void {
  const listener = () => {
    const t = takeFromLocation();
    if (t) go(t);
  };
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/** What chat needs to draw and follow links: the channels you can see
 * and a way to go to one. Provided by ChatApp. */
export interface Links {
  readonly channels: readonly ChannelInfo[];
  readonly go: (t: LinkTarget) => void;
}

export const LinksContext = createContext<Links | null>(null);

export function useLinks(): Links | null {
  return useContext(LinksContext);
}

/** The text channel a link goes to, if you can see it. */
export function linkChannel(links: Links | null, t: LinkTarget): ChannelInfo | undefined {
  return links?.channels.find((c) => c.id === t.channelId && c.kind === "text");
}
