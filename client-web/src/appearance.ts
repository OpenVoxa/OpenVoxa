// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Appearance: colours the user can change, per browser (localStorage,
 * like the toggles in settings.ts). Each one overrides a CSS variable from
 * styles.css on the root element, so the stylesheet keeps the defaults and
 * the palette stays in one place. Add a colour here and it shows up in
 * Settings > Appearance.
 */

import { useSyncExternalStore } from "react";
import { localStore } from "./core";

export interface ColourSetting {
  /** The CSS variable it overrides (styles.css). */
  readonly cssVar: string;
  readonly label: string;
  readonly help?: string;
  /** The stylesheet's default, as #rrggbb (colour inputs need hex). */
  readonly fallback: string;
}

export const COLOURS: readonly ColourSetting[] = [
  {
    cssVar: "--accent",
    label: "Accent colour",
    help: "Buttons, tabs, focus outlines and mention highlights.",
    fallback: "#d96932",
  },
  {
    cssVar: "--unread-dot",
    label: "Unread dot",
    help: "Beside a channel with messages you haven't seen.",
    fallback: "#d96932",
  },
  {
    cssVar: "--mention-badge",
    label: "Mention badge",
    help: "The @ beside a channel where someone mentioned you.",
    fallback: "#e5483d",
  },
];

const HEX = /^#[0-9a-f]{6}$/i;
const key = (c: ColourSetting) => `appearance${c.cssVar}`;
const listeners = new Set<() => void>();

/** The chosen colour, or null for the default. */
export function getColour(c: ColourSetting): string | null {
  const v = localStore.get(key(c));
  return v && HEX.test(v) ? v : null;
}

/** Set a colour; null goes back to the default. */
export function setColour(c: ColourSetting, value: string | null): void {
  localStore.set(key(c), value && HEX.test(value) ? value : "");
  apply(c);
  for (const l of listeners) l();
}

function apply(c: ColourSetting): void {
  const v = getColour(c);
  const root = document.documentElement.style;
  if (v) root.setProperty(c.cssVar, v);
  else root.removeProperty(c.cssVar);
}

/** Apply every saved colour. Call once at startup, before the first render. */
export function applyAppearance(): void {
  for (const c of COLOURS) apply(c);
}

/** The chosen colour (or the default) for a settings control. */
export function useColour(c: ColourSetting): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getColour(c) ?? c.fallback,
  );
}
