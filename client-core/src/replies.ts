// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Replies. A reply is an ordinary message whose text starts with a token
 * line naming the original, then a preview of it:
 *
 *   [reply:<message id>:<author id>:<author name>] <preview>
 *   the reply itself
 *
 * It travels inside the body (so inside the encryption in encrypted
 * channels, and readable by people who joined after the original); the
 * server never parses it. The preview is the original's first line when
 * the reply was sent, so a reply can say what it answers even when the
 * original isn't loaded, was deleted, or can't be decrypted here.
 *
 * Chat splits the token off: ChatMessage.text is the reply alone and
 * ChatMessage.reply the reference. send() and edit() put it back.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Usernames as the server allows them (auth.go usernamePattern).
const TOKEN = new RegExp(`^\\[reply:(${UUID}):(${UUID}):([A-Za-z0-9_-]{1,32})\\] ?([^\\n]*)(?:\\n|$)`);

/** Longest saved preview, in characters. */
export const REPLY_PREVIEW_MAX = 100;

/** What a reply refers to. */
export interface ReplyRef {
  /** The original message's id. */
  readonly messageId: string;
  readonly authorId: string;
  /** The original's author's name when the reply was sent. */
  readonly username: string;
  /** The original's first line when the reply was sent (may be empty). */
  readonly preview: string;
}

/** Split a message's text into the reply reference and the rest. */
export function splitReply(text: string): { text: string; reply?: ReplyRef } {
  const m = TOKEN.exec(text);
  if (!m) return { text };
  return {
    text: text.slice(m[0].length),
    reply: { messageId: m[1]!, authorId: m[2]!, username: m[3]!, preview: m[4]! },
  };
}

/** The text to send for a reply (or just text, without one). */
export function joinReply(text: string, reply?: ReplyRef): string {
  if (!reply) return text;
  const preview = oneLine(reply.preview);
  return `[reply:${reply.messageId.toLowerCase()}:${reply.authorId.toLowerCase()}:${reply.username}]${preview ? ` ${preview}` : ""}\n${text}`;
}

/**
 * A one-line preview of a message's text (already split): the first line
 * with words in it, skipping code fences and a quote marker, cut to
 * REPLY_PREVIEW_MAX. Empty if there is none (files only, say): the
 * caller decides what to show then.
 */
export function previewOf(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*```\S*\s*$/, "").replace(/^\s*>\s?/, "");
    const p = oneLine(line);
    if (p) return p;
  }
  return "";
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat); // don't cut an emoji in half
  if (chars.length <= REPLY_PREVIEW_MAX) return flat;
  return chars.slice(0, REPLY_PREVIEW_MAX - 1).join("").trimEnd() + "…";
}
