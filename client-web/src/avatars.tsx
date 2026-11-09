// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * User avatars (decisions.md Feature decisions, "User avatars and
 * profiles", stage 1; server avatars.go). The server lists which accounts
 * have a picture and its version; each picture is fetched once per
 * version (it needs the session token, so it can't be a plain <img src>)
 * and kept as a blob: URL. avatars_changed events update the list live;
 * a reconnected event socket refetches it.
 *
 * <Avatar> draws the picture, or the first letter of the name where
 * there is none (or until it has loaded), in whatever circle the
 * surrounding CSS gives `.avatar`.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ApiCall } from "@core/identity";

let source: { call: ApiCall; token: string } | null = null;
/** Account id -> current picture version. Replaced, never changed in place. */
let versions: Record<string, number> | null = null;
let loading = false;
let again = false;
const listeners = new Set<() => void>();
/** `${userId}:${version}` -> the picture as a blob: URL, or null if it can't be had. */
const images = new Map<string, Promise<string | null>>();

function changed() {
  for (const l of listeners) l();
}

/** Called by ChatApp once signed in. */
export function configureAvatars(call: ApiCall, token: string): void {
  if (source?.token !== token) {
    versions = null;
    for (const p of images.values()) void p.then((url) => url && URL.revokeObjectURL(url));
    images.clear();
  }
  source = { call, token };
  refreshAvatars();
}

/** Fetch the list again. Calls during a fetch are folded into one more. */
export function refreshAvatars(): void {
  if (!source) return;
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  const from = source;
  (from.call("/api/v1/avatars") as Promise<{ users: Record<string, number> }>)
    .then((r) => {
      if (from === source) versions = r.users;
    })
    .catch(() => {
      /* keep the last list; letters show until the next try */
    })
    .finally(() => {
      loading = false;
      changed();
      if (again) {
        again = false;
        refreshAvatars();
      }
    });
}

/** An avatars_changed event: someone's new version, or null when removed. */
export function avatarChanged(userId: string, version: number | null): void {
  if (!userId) return;
  const next = { ...(versions ?? {}) };
  if (version === null) delete next[userId];
  else next[userId] = version;
  versions = next;
  // Older versions of this person's picture are no longer shown; free
  // them once whatever still draws them has moved on.
  for (const key of [...images.keys()]) {
    if (key.startsWith(userId + ":") && key !== `${userId}:${version}`) {
      const p = images.get(key)!;
      images.delete(key);
      void p.then((url) => url && setTimeout(() => URL.revokeObjectURL(url), 10_000));
    }
  }
  changed();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The current version of someone's picture, or undefined for none. */
export function useAvatarVersion(userId: string | null | undefined): number | undefined {
  const v = useSyncExternalStore(subscribe, () => versions);
  return userId && v ? v[userId] : undefined;
}

function imageUrl(userId: string, version: number): Promise<string | null> {
  const key = `${userId}:${version}`;
  let p = images.get(key);
  if (!p && source) {
    const { token } = source;
    p = fetch(`/api/v1/avatars/${userId}?v=${version}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
      .catch(() => null);
    images.set(key, p);
    // A failure (offline, or just removed) is retried on the next request.
    void p.then((url) => url === null && images.get(key) === p && images.delete(key));
  }
  return p ?? Promise.resolve(null);
}

/** Someone's picture as a URL to draw, or null (none, or not loaded yet). */
export function useAvatarUrl(userId: string | null | undefined): string | null {
  const version = useAvatarVersion(userId);
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null);
  const key = userId && version !== undefined ? `${userId}:${version}` : null;
  useEffect(() => {
    if (!key || !userId || version === undefined) return;
    let live = true;
    void imageUrl(userId, version).then((url) => live && setLoaded({ key, url }));
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep showing the previous picture while a new version loads, rather
  // than flashing the letter.
  if (!key) return null;
  return loaded?.key === key || loaded?.key.startsWith(userId + ":") ? loaded.url : null;
}

/** The first letter of a name, for the circle when there is no picture. */
export function avatarLetter(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

/**
 * A person's circle: their picture, else the first letter of their name.
 * Sized by the surrounding CSS (`.avatar` in its context); extra classes
 * go in className.
 */
export function Avatar({ userId, name, className }: {
  userId: string | null | undefined;
  name: string;
  className?: string;
}) {
  const url = useAvatarUrl(userId);
  return (
    <span className={`avatar${url ? " has-picture" : ""}${className ? " " + className : ""}`} aria-hidden>
      {url ? <img src={url} alt="" draggable={false} /> : avatarLetter(name)}
    </span>
  );
}
