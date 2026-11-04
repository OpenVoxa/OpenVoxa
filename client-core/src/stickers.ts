// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Custom stickers: the server's set (server/internal/httpapi/stickers.go)
 * and how a message carries one.
 *
 * A sticker message is an ordinary message whose whole text is a token
 * naming the sticker's id, "[sticker:<uuid>]". In an encrypted channel
 * that text is inside the ciphertext, so the server cannot tell from the
 * message which sticker was sent (fetching the image still shows it).
 * Using the id, not the name, means renaming a sticker changes nothing
 * already sent; a removed sticker shows as "sticker removed".
 *
 * Anyone could type the token by hand. That only sends a sticker the
 * server already has, which the picker would send anyway.
 */

/** One sticker, as GET /api/v1/stickers lists it. */
export interface StickerInfo {
  readonly id: string;
  /** 2-32 of a-z, 0-9 and _; unique. */
  readonly name: string;
  /** Description for screen readers; may be empty. */
  readonly alt: string;
  readonly content_type: string;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  /** Who added it; empty once their account is gone. */
  readonly uploader: string;
  readonly created_at: string;
}

/** The server's limits on new stickers (an administrator sets them). */
export interface StickerLimits {
  readonly max_bytes: number;
  readonly max_px: number;
  readonly max_count: number;
}

export interface StickerList {
  readonly stickers: readonly StickerInfo[];
  readonly limits: StickerLimits;
}

const TOKEN = /^\[sticker:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]$/;

/** The message text that sends this sticker. */
export function stickerToken(id: string): string {
  return `[sticker:${id.toLowerCase()}]`;
}

/** The sticker id if this message text is a sticker, else null. */
export function stickerIdOf(text: string): string | null {
  return TOKEN.exec(text.trim())?.[1] ?? null;
}
