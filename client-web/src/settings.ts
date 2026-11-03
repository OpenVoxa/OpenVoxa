// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Small per-browser on/off settings, kept in localStorage, that components
 * can subscribe to so a change in the settings dialog shows at once.
 */

import { useSyncExternalStore } from "react";
import { localStore } from "./core";

export interface Toggle {
  readonly key: string;
  readonly fallback: boolean;
}

/** Join/leave tones in voice calls. */
export const VOICE_TONES: Toggle = { key: "voice.tones", fallback: true };
/**
 * Link previews in encrypted channels. Off by default: the server fetches
 * the page, so asking for a preview tells it the link (decisions.md,
 * "Link previews leak URLs to the server").
 */
export const PREVIEWS_ENCRYPTED: Toggle = { key: "chat.previewsEncrypted", fallback: false };

/** Clicking an image in chat opens it in a new tab instead of the in-page viewer. */
export const IMAGES_IN_TAB: Toggle = { key: "chat.imagesInTab", fallback: false };

const listeners = new Set<() => void>();

export function getToggle(t: Toggle): boolean {
  const v = localStore.get(t.key);
  return v === null ? t.fallback : v === "1";
}

export function setToggle(t: Toggle, on: boolean): void {
  localStore.set(t.key, on ? "1" : "0");
  for (const l of listeners) l();
}

export function useToggle(t: Toggle): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getToggle(t),
  );
}
