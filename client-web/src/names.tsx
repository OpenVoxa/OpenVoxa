// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Username colours by group (decisions.md Open items, "Username colours
 * by group"; server namecolours.go). The server maps every account to
 * the colour of its highest coloured group, or null. Fetched once, again
 * on names_changed (group colours, the server-wide switch) and
 * perms_changed (membership), and again when a name turns up that the
 * map doesn't know yet (an account created since).
 *
 * Shown on message authors, @mention chips, the mention suggestions,
 * voice rosters and the Members tab. Each user can hide them in
 * Settings > Appearance (NAME_COLOURS, per browser).
 */

import { useEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { ApiCall } from "@core/identity";
import { NAME_COLOURS, useToggle } from "./settings";

interface NameColours {
  enabled: boolean;
  users: Record<string, string | null>;
}

let source: ApiCall | null = null;
/** Replaced, never changed in place, so useSyncExternalStore sees each change. */
let state: NameColours | null = null;
let loading = false;
let again = false;
let lastMissFetch = 0;
const listeners = new Set<() => void>();

/** At most one refetch per this long for names the map doesn't know. */
const MISS_REFETCH_MS = 30_000;

/** Called by ChatApp once signed in. */
export function configureNames(call: ApiCall): void {
  if (source !== call) state = null;
  source = call;
  refreshNames();
}

/** Fetch the map again. Calls during a fetch are folded into one more. */
export function refreshNames(): void {
  if (!source) return;
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  const call = source;
  (call("/api/v1/name-colours") as Promise<NameColours>)
    .then((n) => {
      if (call === source) state = n;
    })
    .catch(() => {
      /* keep the last map; names stay plain until the next try */
    })
    .finally(() => {
      loading = false;
      for (const l of listeners) l();
      if (again) {
        again = false;
        refreshNames();
      }
    });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** The name colour for an account, or undefined for plain text. */
export function useNameColour(userId: string | null | undefined): string | undefined {
  const on = useToggle(NAME_COLOURS);
  const s = useSyncExternalStore(subscribe, () => state);
  const unknown = !!userId && !!s && s.enabled && !(userId in s.users);
  useEffect(() => {
    if (!unknown) return;
    const now = Date.now();
    if (now - lastMissFetch < MISS_REFETCH_MS) return;
    lastMissFetch = now;
    refreshNames();
  }, [unknown]);
  if (!on || !userId || !s?.enabled) return undefined;
  return s.users[userId] ?? undefined;
}

/** The server-wide switch, or null until the first answer (Groups tab). */
export function useServerNameColours(): boolean | null {
  const s = useSyncExternalStore(subscribe, () => state);
  return s ? s.enabled : null;
}

/** Inline style for a coloured name (bold, which the 3:1 contrast rule assumes). */
export function nameStyle(colour: string | undefined): CSSProperties | undefined {
  return colour ? { color: colour, fontWeight: 600 } : undefined;
}

/** A name in its colour, for places that render a plain span. */
export function ColouredName({ userId, children, className }: {
  userId: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const colour = useNameColour(userId);
  return <span className={className} style={nameStyle(colour)}>{children}</span>;
}

// ---------------------------------------------------- contrast (mirrors the server)

/** Default background (styles.css --bg); users can't change it. */
export const NAME_BACKGROUND = "#333333";
/** WCAG level for bold text; the server refuses anything lower. */
export const MIN_NAME_CONTRAST = 3;

function luminance(hex: string): number {
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/** WCAG contrast ratio of a #rrggbb colour against the background. */
export function nameContrast(hex: string): number {
  const a = luminance(hex.toLowerCase());
  const b = luminance(NAME_BACKGROUND);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
