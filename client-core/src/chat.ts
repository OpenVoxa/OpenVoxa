// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Text chat: channels, history, sending, editing and deleting, for any
 * client (build order 13, M2). Ported from the debug page's inline script
 * so client-web and the desktop client share one implementation.
 *
 * No UI here. A `Chat` is one signed-in account: its event socket, its
 * channel list and its crypto session. A `ChannelView` is one open text
 * channel: its socket and the messages loaded so far. Both report changes
 * through listeners; the UI reads a snapshot and redraws.
 *
 * Encrypted channels follow decisions.md: no history from before this
 * device joined, and the local archive (storage "sent" store) is the only
 * readable copy of anything once its MLS key is used. Every message this
 * device reads or sends is archived, and `onArchived` fires so the client
 * can schedule a backup upload.
 */

import { decodeEnvelope, encodeEnvelope, encryptFile, type FileKey } from "./attachments.js";
import type { ApiCall } from "./identity.js";
import type { AutoEvent, MembershipChange, PersonChange } from "./groups.js";
import { normalizeTime, storage, type SharedBy } from "./storage.js";
import type { Session } from "./index.js";
import { meterSocket } from "./traffic.js";

// ----------------------------------------------------------------- types

/** A channel as GET /api/v1/channels lists it. */
export interface ChannelInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: "text" | "voice";
  readonly encrypted: boolean;
  readonly retention: string;
  readonly force_ptt: boolean;
  readonly history_sharing: boolean;
  readonly can_post: boolean;
  readonly last_message_at?: string;
  /** Newest message mentioning you (not deleted); for the mention badge. */
  readonly last_mention_at?: string;
  /** The allow-list: groups that may view, and whether they may post. */
  readonly access: readonly ChannelAccess[];
}

export interface ChannelAccess {
  readonly group_id: string;
  readonly group: string;
  readonly can_post: boolean;
}

/**
 * A file uploaded for the next message (ChannelView.upload). key is set
 * in encrypted channels: what readers need to decrypt it.
 */
export interface Upload {
  readonly info: AttachmentInfo;
  readonly key?: FileKey;
}

export interface AttachmentInfo {
  readonly id: string;
  readonly filename: string;
  readonly content_type: string;
  readonly size: number;
  readonly url?: string;
}

/** Someone mentioned in a message, or who may view a channel. */
export interface Mention {
  readonly user_id: string;
  readonly username: string;
}

/** One emoji on a message, as the server sends it. */
interface ServerReaction {
  emoji: string;
  /** Who chose it, oldest first. */
  users: Mention[];
}

/**
 * One emoji on a message and who chose it, oldest first. The server sees
 * these in every channel, encrypted ones too (decisions.md, "Reactions
 * are metadata the server sees").
 */
export interface Reaction {
  readonly emoji: string;
  readonly users: readonly Mention[];
  /** This account is among them. */
  readonly mine: boolean;
}

/** At most this many different emoji on one message (server rule). */
export const MAX_REACTION_KINDS = 20;

/** A message as the server sends it (websocket or history page). */
interface ServerMessage {
  id: string;
  channel_id: string;
  author_id: string;
  username: string;
  body: string;
  deleted: boolean;
  created_at: string;
  edited_at?: string;
  ref?: string;
  attachments?: AttachmentInfo[];
  mentions?: Mention[];
  reactions?: ServerReaction[];
}

/**
 * Why a message has no text to show:
 * - before_join: this device was not in the group when it was sent (or
 *   read it before the archive existed); by design.
 * - other_device: sent by this account from a device whose plaintext
 *   this one does not have.
 * - not_member: this device is not (yet) in the channel's group.
 * - failed: decryption failed unexpectedly.
 */
export type Unreadable = "before_join" | "other_device" | "not_member" | "failed";

export interface ChatMessage {
  /** Server ID, or "pending:<ref>" for a message still on its way. */
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly username: string;
  readonly createdAt: string;
  readonly editedAt?: string;
  /** Written by this account. */
  readonly own: boolean;
  readonly deleted: boolean;
  /** Empty when deleted or unreadable. */
  readonly text: string;
  readonly unreadable?: Unreadable;
  /** Encrypted attachments' keys, from the envelope. */
  readonly files: readonly FileKey[];
  /** The server's attachment list (placeholders in encrypted channels). */
  readonly attachments: readonly AttachmentInfo[];
  /** Who it mentions, as the server accepted it: only people who may view
   * the channel. Draw "@name" as a mention only if the name is here. */
  readonly mentions: readonly Mention[];
  /** It mentions this account. */
  readonly mentionsMe: boolean;
  /** Emoji reactions, in the order each emoji was first used. */
  readonly reactions: readonly Reaction[];
  /** Readable because someone shared it (history sharing). */
  readonly sharedBy?: SharedBy;
  /**
   * Edited again since this device archived it, and the newer version
   * could not be decrypted here; the text shown is an older version.
   */
  readonly staleEdit?: boolean;
  /** Sent from here, not yet confirmed by the server. */
  readonly pending?: boolean;
  /** Sending failed; the reason. Only on pending messages. */
  readonly failed?: string;
}

/** The encryption side of an open channel, for a status line. */
export type CryptoState =
  | { kind: "plaintext" }
  | { kind: "opening" }
  | { kind: "ready"; epoch: number }
  | { kind: "waiting"; detail: string }
  | { kind: "removed" }
  | { kind: "unavailable"; detail: string };

export interface ChannelSnapshot {
  readonly channel: ChannelInfo;
  /** Oldest first. */
  readonly messages: readonly ChatMessage[];
  readonly connection: "connecting" | "open" | "closed";
  /** The first history page has arrived. */
  readonly loaded: boolean;
  /** Older messages exist on the server. */
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly canPost: boolean;
  readonly crypto: CryptoState;
  /** Something worth a line in the UI (shared history, group replaced,
   * who joined or left the encryption group). Oldest first. */
  readonly notices: readonly Notice[];
  /** Who may view the channel, for the composer's @ list (not you).
   * Empty until loaded. */
  readonly members: readonly Mention[];
}

/** A line in the message stream that isn't a message. */
export interface Notice {
  /** Unique within the view, for React keys. */
  readonly id: number;
  /** When this device learned of it (ISO time); sorts it among messages. */
  readonly at: string;
  readonly text: string;
  /** "membership": someone joined or left the channel's encryption. */
  readonly kind: "info" | "membership";
}

/** Per-account key/value storage for small client state (unread marks). */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface ChatOptions {
  /** Authenticated JSON request; errors carry `.status`. */
  call: ApiCall;
  /** Turns "/api/v1/ws?..." into a ws:// or wss:// URL. */
  wsUrl: (pathAndQuery: string) => string;
  userId: string;
  /** This account's name, for its own reactions until the server echoes them. */
  username?: string;
  /** Where unread marks live; in memory when omitted. */
  store?: KeyValueStore;
  /** Fired after any plaintext is archived (schedule a backup upload). */
  onArchived?: () => void;
}

/** Events a Chat reports that are not about the open channel. */
export type ChatEvent =
  | { type: "channels"; channels: readonly ChannelInfo[] }
  /** This account's groups or permissions may have changed: refetch /me. */
  | { type: "me_changed" }
  | { type: "unread"; unread: ReadonlySet<string> }
  /** Channels with a mention of you since you last read them. */
  | { type: "mentions"; mentions: ReadonlySet<string> }
  /** Someone just mentioned you (for a sound or a notification).
   * `open`: in the channel open right now. */
  | { type: "mentioned"; channelId: string; messageId: string; authorId: string; username: string; open: boolean }
  /** Someone else posted (for the message sound; the client decides how
   * often to play it). `open`: in the channel open right now. */
  | { type: "message"; channelId: string; messageId: string; open: boolean }
  /** The open report queue changed; sent only to people who can read it. */
  | { type: "reports_changed" }
  /** The server's sticker set or its limits changed: refetch the list. */
  | { type: "stickers_changed" }
  /** Someone's name colour may have changed (group colours, membership,
   * or the server-wide switch): fetch /name-colours again. */
  | { type: "names_changed" }
  /** Who is in each voice call (channels you can see, non-empty only). */
  | { type: "voice"; presence: VoicePresence }
  | { type: "error"; message: string };

/** Voice channel ID -> the people in its call. */
export type VoicePresence = Readonly<Record<string, readonly { user_id: string; username: string }[]>>;

/** Fallback refresh of voice presence, for people who vanish silently. */
const VOICE_POLL_MS = 20_000;

// ------------------------------------------------------------- helpers

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64decode(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRemoved(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "RemovedFromGroup" || name === "GroupReset";
}

function newRef(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  // Pending messages sort after everything the server has confirmed.
  if (!!a.pending !== !!b.pending) return a.pending ? 1 : -1;
  const t = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Server-wide event types (emitAll / emitUsers on the server). */
const GLOBAL_EVENTS = new Set([
  "user_purged", "access_changed", "channel_changed", "channel_deleted",
  "perms_changed", "channel_activity", "voice_changed", "reports_changed",
  "mention", "stickers_changed", "names_changed",
  "archive_message_gone", "archive_channel_expired",
]);

const EVENT_RETRY_MS = 5000;

/** The server's cap on a message body, in characters (ws.go). */
const MAX_BODY = 4000;

/** Refuse a body the server would refuse, with a clearer reason. In an
 * encrypted channel the body is base64 ciphertext, about 4/3 of the
 * text plus some overhead, so the room for text is smaller. */
function checkBodyLength(body: string, encrypted: boolean, files = 0): void {
  if ([...body].length <= MAX_BODY) return;
  // Each encrypted file's key and name ride inside the message.
  if (encrypted && files > 0) {
    throw new Error("That message is too long for an encrypted channel. Each file takes room too; send fewer files at once or shorten the text.");
  }
  throw new Error(encrypted
    ? "That message is too long for an encrypted channel (about 2,800 characters at most)."
    : `That message is too long (${MAX_BODY} characters at most).`);
}

/** "@name": not inside a word or an email address. Same characters as
 * the server's usernamePattern (auth.go). */
export const MENTION_RE = /(?<![\w@])@([A-Za-z0-9_-]{3,32})(?![\w-])/g;

/**
 * Who some text mentions, out of the people who may view the channel.
 * Code (`inline` and ```fenced```) is skipped, as for link previews.
 * Usernames are case-sensitive on the server, so an exact match wins;
 * otherwise a case-insensitive one, if only one name fits.
 */
export function findMentions(text: string, members: readonly Mention[]): Mention[] {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]+`/g, " ");
  const out = new Map<string, Mention>();
  for (const m of plain.matchAll(MENTION_RE)) {
    const who = matchMember(m[1]!, members);
    if (who) out.set(who.user_id, who);
  }
  return [...out.values()];
}

/** The member a typed name refers to, by the rule in findMentions. */
export function matchMember(name: string, members: readonly Mention[]): Mention | undefined {
  const exact = members.find((p) => p.username === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const loose = members.filter((p) => p.username.toLowerCase() === lower);
  return loose.length === 1 ? loose[0] : undefined;
}

class MemoryStore implements KeyValueStore {
  #m = new Map<string, string>();
  get(key: string) { return this.#m.get(key) ?? null; }
  set(key: string, value: string) { this.#m.set(key, value); }
}

// ---------------------------------------------------------------- Chat

/**
 * One signed-in account's chat. Create with the crypto session from
 * startSession, call start(), and close() on sign-out.
 */
/** Ids per archive check; the server accepts up to 500 (archivecheck.go). */
const ARCHIVE_CHECK_BATCH = 500;
/** Wait after user_purged so the server's purge has settled and a burst
 * of deletions costs one check. */
const PRUNE_DELAY_MS = 2000;

export class Chat {
  readonly session: Session;
  readonly userId: string;
  readonly username: string;
  readonly #opts: ChatOptions;
  readonly #store: KeyValueStore;
  #channels: ChannelInfo[] = [];
  #listeners = new Set<(e: ChatEvent) => void>();
  #events: WebSocket | null = null;
  #eventsOpen = false;
  /** When the event socket last opened (Date.now()), null while it is down. */
  #eventsSince: number | null = null;
  #closed = false;
  #view: ChannelView | null = null;
  #unread = new Set<string>();
  // Whether the user can see the open channel (the app's tab is visible
  // and focused; set by the UI). While not, its new messages are unread.
  #looking = true;
  // The newest message the open channel got while nobody was looking.
  #heldRead: { channelId: string; at: string } | null = null;
  #mentioned = new Set<string>();
  #offAuto: (() => void) | null = null;
  #offMembership: (() => void) | null = null;
  #voice: VoicePresence = {};
  #voicePoll: ReturnType<typeof setInterval> | undefined;
  #voiceTimer: ReturnType<typeof setTimeout> | undefined;
  #pruneTimer: ReturnType<typeof setTimeout> | undefined;
  #pruning: Promise<number> | null = null;
  #pruneAgain = false;

  constructor(session: Session, opts: ChatOptions) {
    this.session = session;
    this.userId = opts.userId;
    this.username = opts.username ?? "";
    this.#opts = opts;
    this.#store = opts.store ?? new MemoryStore();
  }

  get channels(): readonly ChannelInfo[] {
    return this.#channels;
  }

  get unread(): ReadonlySet<string> {
    return this.#unread;
  }

  /** Channels with a mention of you since you last read them. */
  get mentions(): ReadonlySet<string> {
    return this.#mentioned;
  }

  get voicePresence(): VoicePresence {
    return this.#voice;
  }

  /** Ask the server who is in each voice call. */
  async refreshVoice(): Promise<void> {
    try {
      this.#voice = (await this.#opts.call("/api/v1/voice/participants")) as VoicePresence;
      this.#emit({ type: "voice", presence: this.#voice });
    } catch {
      /* voice may be off on this server; the next refresh tries again */
    }
  }

  /** Coalesce bursts of voice_changed into one refresh. */
  #refreshVoiceSoon(): void {
    clearTimeout(this.#voiceTimer);
    this.#voiceTimer = setTimeout(() => void this.refreshVoice(), 300);
  }

  /** The open channel, if any. */
  get view(): ChannelView | null {
    return this.#view;
  }

  on(listener: (e: ChatEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(e: ChatEvent): void {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch (err) {
        console.warn("chat listener failed:", err);
      }
    }
  }

  async start(): Promise<void> {
    this.#offAuto = this.session.groups.onAuto((ev) => this.#onAuto(ev));
    this.#offMembership = this.session.groups.onMembership((c) => this.#onMembership(c));
    await this.refreshChannels();
    void this.#openEvents();
    void this.refreshVoice();
    this.#voicePoll = setInterval(() => void this.refreshVoice(), VOICE_POLL_MS);
    // Catch up on deletions that happened while this device was away.
    void this.pruneArchive();
  }

  /**
   * Delete this device's saved copies of messages the server no longer
   * has: deleted (one at a time, or with their author's account),
   * expired by retention, or in a deleted channel. Returns how many went.
   *
   * The archive is keyed by message id alone, and a device that was
   * offline never saw the event announcing a deletion, so it asks the
   * server about every id it keeps (decisions.md, Encryption, "Account
   * deletion is crypto-shredding"). Call it again after restoring a
   * backup, which can bring old copies back. Concurrent calls share one
   * run, plus one more afterwards if asked for meanwhile.
   *
   * Afterwards the backup is re-uploaded (it is a full copy each time),
   * so the deleted messages leave the server-held backup too.
   */
  pruneArchive(): Promise<number> {
    if (this.#pruning) {
      this.#pruneAgain = true;
      return this.#pruning;
    }
    const run = (async () => {
      let removed = 0;
      do {
        this.#pruneAgain = false;
        removed += await this.#pruneOnce();
      } while (this.#pruneAgain && !this.#closed);
      return removed;
    })();
    this.#pruning = run.finally(() => { this.#pruning = null; });
    return this.#pruning;
  }

  async #pruneOnce(): Promise<number> {
    let removed = 0;
    try {
      const ids = await storage.archivedMessageIds();
      for (let i = 0; i < ids.length && !this.#closed; i += ARCHIVE_CHECK_BATCH) {
        const { gone } = (await this.#opts.call("/api/v1/messages/archive-check", {
          method: "POST",
          body: JSON.stringify({ ids: ids.slice(i, i + ARCHIVE_CHECK_BATCH) }),
        })) as { gone: string[] };
        for (const id of gone) {
          await storage.deletePlaintext(id);
          removed++;
        }
      }
    } catch (err) {
      // Nothing is deleted on a failed check; the next start tries again.
      console.warn("could not check the message archive:", err);
    }
    if (removed > 0) {
      try {
        this.#opts.onArchived?.();
      } catch {
        /* the backup schedule is best-effort */
      }
    }
    return removed;
  }

  /**
   * Delete this device's copy of one message the server deleted, if it
   * has one, and refresh the backup. The open channel's view may already
   * have deleted it (message_deleted); then there is nothing to do.
   */
  async #forget(messageId: string): Promise<void> {
    try {
      if ((await storage.getPlaintext(messageId)) === undefined) return;
      await storage.deletePlaintext(messageId);
      this.#opts.onArchived?.();
    } catch (err) {
      // The next start's archive check catches it.
      console.warn("could not delete an archived message:", err);
    }
  }

  /** Coalesce a burst of deletions (accounts, retention sweeps, channels)
   * into one archive check. */
  #pruneSoon(): void {
    clearTimeout(this.#pruneTimer);
    this.#pruneTimer = setTimeout(() => void this.pruneArchive(), PRUNE_DELAY_MS);
  }

  /** Stop everything. The crypto session itself is the caller's. */
  close(): void {
    this.#closed = true;
    clearInterval(this.#voicePoll);
    clearTimeout(this.#voiceTimer);
    clearTimeout(this.#pruneTimer);
    this.#offAuto?.();
    this.#offMembership?.();
    this.#view?.close();
    this.#view = null;
    const ws = this.#events;
    this.#events = null;
    ws?.close();
  }

  async refreshChannels(): Promise<void> {
    const list = (await this.#opts.call("/api/v1/channels")) as ChannelInfo[];
    this.#channels = list;
    this.#recomputeUnread();
    this.#emit({ type: "channels", channels: list });

    // An open channel that is gone from the list was deleted or lost.
    const v = this.#view;
    if (v) {
      const now = list.find((c) => c.id === v.channel.id);
      if (!now) v.lost();
      else v.updateChannel(now);
    }
  }

  /** Open a text channel, closing whichever was open. */
  open(channelId: string): ChannelView {
    const channel = this.#channels.find((c) => c.id === channelId && c.kind === "text");
    if (!channel) throw new Error("no such text channel");
    this.#view?.close();
    const view = new ChannelView(this, channel, this.#opts);
    this.#view = view;
    this.markRead(channelId, channel.last_message_at);
    void view.start();
    return view;
  }

  // ------------------------------------------------------------ unread

  /**
   * Tell the chat whether the user can see the open channel (tab visible
   * and window focused). While they can't, its new messages leave it
   * unread, as for any other channel; coming back marks it read.
   */
  setLooking(on: boolean): void {
    if (this.#looking === on) return;
    this.#looking = on;
    const held = this.#heldRead;
    this.#heldRead = null;
    if (on && held && held.channelId === this.#view?.channel.id) this.markRead(held.channelId, held.at);
  }

  /** @internal A message arrived in the open channel. */
  seenInOpen(channelId: string, at: string): void {
    if (channelId !== this.#view?.channel.id) return;
    if (this.#looking) {
      this.markRead(channelId, at);
      return;
    }
    if (!this.#heldRead || Date.parse(at) > Date.parse(this.#heldRead.at)) this.#heldRead = { channelId, at };
    if (!this.#unread.has(channelId)) {
      this.#unread = new Set(this.#unread).add(channelId);
      this.#emit({ type: "unread", unread: this.#unread });
    }
  }

  #readKey(channelId: string): string {
    return `read.${this.userId}.${channelId}`;
  }

  /**
   * Record that everything up to `at` in a channel has been seen. A
   * channel never seen before counts as read up to now, so a new account
   * does not start with every channel bold.
   */
  markRead(channelId: string, at?: string): void {
    const key = this.#readKey(channelId);
    const prev = this.#store.get(key);
    const next = at ? normalizeTime(at) : prev ?? new Date().toISOString();
    if (!prev || Date.parse(next) > Date.parse(prev)) this.#store.set(key, next);
    if (this.#unread.delete(channelId)) this.#emit({ type: "unread", unread: this.#unread });
    if (this.#mentioned.has(channelId)) {
      this.#mentioned = new Set(this.#mentioned);
      this.#mentioned.delete(channelId);
      this.#emit({ type: "mentions", mentions: this.#mentioned });
    }
  }

  #recomputeUnread(): void {
    const next = new Set<string>();
    const mentioned = new Set<string>();
    for (const c of this.#channels) {
      if (c.kind !== "text") continue;
      const read = this.#store.get(this.#readKey(c.id));
      if (!read) {
        // First sight: everything so far counts as read.
        this.#store.set(this.#readKey(c.id), c.last_message_at
          ? normalizeTime(c.last_message_at) : new Date().toISOString());
        continue;
      }
      if (c.id === this.#view?.channel.id && this.#looking) continue;
      if (c.last_message_at && Date.parse(c.last_message_at) > Date.parse(read)) next.add(c.id);
      if (c.last_mention_at && Date.parse(c.last_mention_at) > Date.parse(read)) mentioned.add(c.id);
    }
    this.#unread = next;
    this.#emit({ type: "unread", unread: next });
    this.#mentioned = mentioned;
    this.#emit({ type: "mentions", mentions: mentioned });
  }

  #onMention(f: GlobalFrame): void {
    const channelId = f.channel_id!;
    const open = channelId === this.#view?.channel.id;
    if ((!open || !this.#looking) && !this.#mentioned.has(channelId)) {
      this.#mentioned = new Set(this.#mentioned).add(channelId);
      this.#emit({ type: "mentions", mentions: this.#mentioned });
    }
    this.#emit({
      type: "mentioned", channelId, messageId: f.message_id ?? "",
      authorId: f.author_id ?? "", username: f.username ?? "", open,
    });
  }

  #onActivity(channelId: string, authorId: string, createdAt: string, messageId: string): void {
    // Your own messages, and the channel you are looking at, are read.
    if (authorId === this.userId) {
      this.markRead(channelId, createdAt);
      return;
    }
    const open = channelId === this.#view?.channel.id;
    if (open) this.seenInOpen(channelId, createdAt);
    else if (!this.#unread.has(channelId)) {
      this.#unread = new Set(this.#unread).add(channelId);
      this.#emit({ type: "unread", unread: this.#unread });
    }
    this.#emit({ type: "message", channelId, messageId, open });
  }

  // ------------------------------------------------------ server events

  async #openEvents(): Promise<void> {
    if (this.#closed || this.#events) return;
    let ticket: string;
    try {
      ({ ticket } = (await this.#opts.call("/api/v1/ws/ticket", { method: "POST" })) as { ticket: string });
    } catch {
      setTimeout(() => void this.#openEvents(), EVENT_RETRY_MS);
      return;
    }
    if (this.#closed) return;
    const ws = new WebSocket(this.#opts.wsUrl(`/api/v1/ws?ticket=${encodeURIComponent(ticket)}`));
    this.#events = ws;
    meterSocket(ws);
    ws.onopen = () => {
      this.#eventsOpen = true;
      this.#eventsSince = Date.now();
      // Anything missed while it was down.
      this.refreshChannels().catch(() => {});
    };
    ws.onmessage = (e) => {
      let frame: { type?: string };
      try {
        frame = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (frame.type && GLOBAL_EVENTS.has(frame.type)) this.handleGlobal(frame as GlobalFrame);
    };
    ws.onclose = () => {
      if (this.#events !== ws) return;
      this.#events = null;
      this.#eventsOpen = false;
      this.#eventsSince = null;
      if (!this.#closed) setTimeout(() => void this.#openEvents(), EVENT_RETRY_MS);
    };
  }

  /** Whether server-wide events arrive on the event socket right now. */
  get eventsOpen(): boolean {
    return this.#eventsOpen;
  }

  /** When the event socket (the chat connection) last opened, as Date.now(); null while it is down. */
  get connectedSince(): number | null {
    return this.#eventsSince;
  }

  /** @internal Server-wide events, from the event socket (or a channel's
   * socket while the event socket is down). */
  handleGlobal(frame: GlobalFrame): void {
    switch (frame.type) {
      case "channel_activity":
        this.#onActivity(frame.channel_id!, frame.author_id ?? "", frame.created_at!, frame.message_id ?? "");
        break;
      case "mention":
        this.#onMention(frame);
        break;
      case "user_purged":
        this.#view?.userPurged(frame.user_id!);
        this.#reconcileOpen();
        // Their messages in every other channel, not only the open one.
        this.#pruneSoon();
        break;
      case "access_changed":
        this.#reconcileOpen();
        this.#view?.refreshMembers();
        break;
      case "voice_changed":
        this.#refreshVoiceSoon();
        break;
      case "reports_changed":
        this.#emit({ type: "reports_changed" });
        break;
      case "stickers_changed":
        this.#emit({ type: "stickers_changed" });
        break;
      case "names_changed":
        this.#emit({ type: "names_changed" });
        break;
      case "archive_message_gone":
        // A message deleted in any encrypted channel this account can see.
        void this.#forget(frame.message_id!);
        break;
      case "archive_channel_expired":
        // Retention removed messages that may not be loaded anywhere.
        this.#pruneSoon();
        break;
      case "channel_deleted":
        // Its messages went with it.
        this.#pruneSoon();
        this.#view?.refreshMembers();
        this.refreshChannels().catch(() => {});
        this.#refreshVoiceSoon();
        break;
      case "channel_changed":
        this.#view?.refreshMembers();
        this.refreshChannels().catch(() => {});
        this.#refreshVoiceSoon();
        break;
      case "perms_changed":
        // Group membership decides name colours too.
        this.#emit({ type: "names_changed" });
        if (!frame.user_id || frame.user_id === this.userId) {
          this.#emit({ type: "me_changed" });
          this.refreshChannels().catch(() => {});
        }
        this.#reconcileOpen();
        break;
    }
  }

  #reconcileOpen(): void {
    const v = this.#view;
    if (v && v.channel.encrypted && this.session.groups.isMember(v.channel.id)) {
      this.session.groups.reconcileSoon(v.channel.id);
    }
  }

  #onAuto(ev: AutoEvent): void {
    const v = this.#view;
    if (!v || v.channel.id !== ev.channelId) return;
    if (ev.kind === "removed") v.removedFromGroup(ev.replaced);
    else if (ev.kind === "error") v.notice(`Encryption membership: ${errorText(ev.error)}`);
    else if (ev.kind === "reconciled") v.cryptoReady();
  }

  /** Who joined or left the open channel's group, per person by default
   * (decisions.md, "Notices are per person"). Voice groups announce here
   * too, under the voice channel's ID; those never match a text view. */
  #onMembership(change: MembershipChange): void {
    const v = this.#view;
    if (!v || v.channel.id !== change.channelId || !v.channel.encrypted) return;
    for (const p of change.people) v.notice(describePerson(p), "membership");
  }

  /**
   * Revoke this device on the server and destroy its local keys and
   * archive. Called on sign-out once the backup is uploaded. 404 means it
   * was already revoked. Throws, leaving everything in place, if the
   * server refuses for another reason.
   */
  async forgetDevice(): Promise<void> {
    try {
      await this.#opts.call(`/api/v1/devices/${this.session.status.deviceId}`, { method: "DELETE" });
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
    this.close();
    await storage.wipe();
    storage.lock();
  }
}

/** The server's username for messages whose author was deleted (messages.go). */
export const DELETED_AUTHOR = "[deleted]";

/** "staff joined", "staff left", "staff joined on a new device". */
export function describePerson(p: PersonChange): string {
  const who = p.you ? "You" : p.username ?? null;
  if (p.kind === "new_device") {
    const label = p.devices.map((d) => d.label).filter(Boolean).join(", ");
    return `${who ?? "An unknown account"} joined on a new device${label ? ` (${label})` : ""}.`;
  }
  const verb = p.kind === "joined" ? "joined" : "left";
  if (!who) return `An unknown device ${verb} the encryption.`;
  return `${who} ${verb}.`;
}

interface GlobalFrame {
  type: string;
  channel_id?: string;
  user_id?: string;
  author_id?: string;
  username?: string;
  message_id?: string;
  created_at?: string;
}

// ---------------------------------------------------------- ChannelView

const RECONNECT_MS = [1000, 2000, 5000, 10000, 30000];

/** One open text channel. Get one from Chat.open. */
export class ChannelView {
  readonly #chat: Chat;
  readonly #opts: ChatOptions;
  #channel: ChannelInfo;
  #messages = new Map<string, ChatMessage>();
  /** As the server sent them, for re-preparing (shared history arrived). */
  #raw = new Map<string, ServerMessage>();
  #sorted: ChatMessage[] | null = null;
  #listeners = new Set<() => void>();
  #socket: WebSocket | null = null;
  #connection: ChannelSnapshot["connection"] = "connecting";
  #loaded = false;
  #hasMore = false;
  #loadingOlder = false;
  #canPost: boolean;
  #crypto: CryptoState;
  #notices: Notice[] = [];
  #noticeSeq = 0;
  #closed = false;
  /** Access lost or channel deleted: stays on screen, never reconnects. */
  #gone = false;
  #retry = 0;
  #snapshot: ChannelSnapshot | null = null;
  #members: readonly Mention[] = [];
  /** Settles once the first member list has arrived (or failed). */
  #membersLoaded: Promise<void> | null = null;
  #membersTimer: ReturnType<typeof setTimeout> | undefined;

  // Every received message, history or live, goes through one queue.
  // Decryption reads and rewrites the stored group state, and own-message
  // echoes must pair with what was sent; one at a time keeps both right.
  #inbound: Promise<unknown> = Promise.resolve();
  /** Plaintext (envelope) of sends awaiting their echo, by ref. */
  #pendingSends = new Map<string, string>();
  /** Plaintext of edits awaiting the server, by message ID. */
  #pendingEdits = new Map<string, string>();

  constructor(chat: Chat, channel: ChannelInfo, opts: ChatOptions) {
    this.#chat = chat;
    this.#opts = opts;
    this.#channel = channel;
    this.#canPost = channel.can_post;
    this.#crypto = channel.encrypted ? { kind: "opening" } : { kind: "plaintext" };
  }

  get channel(): ChannelInfo {
    return this.#channel;
  }

  get #groups() {
    return this.#chat.session.groups;
  }

  get #encrypted(): boolean {
    return this.#channel.encrypted;
  }

  // --------------------------------------------------------- snapshots

  on(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The current state. A new object after every change, so React can
   * compare by identity. */
  snapshot(): ChannelSnapshot {
    if (!this.#snapshot) {
      if (!this.#sorted) this.#sorted = [...this.#messages.values()].sort(compareMessages);
      this.#snapshot = {
        channel: this.#channel,
        messages: this.#sorted,
        connection: this.#connection,
        loaded: this.#loaded,
        hasMore: this.#hasMore,
        loadingOlder: this.#loadingOlder,
        canPost: this.#canPost,
        crypto: this.#crypto,
        notices: this.#notices,
        members: this.#members,
      };
    }
    return this.#snapshot;
  }

  #changed(messages = false): void {
    if (messages) this.#sorted = null;
    this.#snapshot = null;
    if (this.#closed) return;
    for (const l of this.#listeners) {
      try {
        l();
      } catch (err) {
        console.warn("channel listener failed:", err);
      }
    }
  }

  #put(m: ChatMessage): void {
    this.#messages.set(m.id, m);
    this.#changed(true);
  }

  /** @internal */
  notice(text: string, kind: Notice["kind"] = "info"): void {
    const n: Notice = { id: ++this.#noticeSeq, at: new Date().toISOString(), text, kind };
    this.#notices = [...this.#notices, n];
    this.#changed();
  }

  /** @internal The channel's settings changed. */
  updateChannel(c: ChannelInfo): void {
    this.#channel = c;
    this.#changed();
  }

  // -------------------------------------------------------- connection

  /** @internal Called by Chat.open. */
  async start(): Promise<void> {
    this.#membersLoaded = this.#loadMembers();
    if (this.#encrypted) await this.#openGroup();
    await this.#connect();
  }

  async #loadMembers(): Promise<void> {
    try {
      const list = (await this.#opts.call(`/api/v1/channels/${this.#channel.id}/members`)) as Mention[];
      if (this.#closed) return;
      this.#members = list.filter((m) => m.user_id !== this.#chat.userId);
      this.#changed();
    } catch {
      /* no @ list for now; mentions typed by hand still go out once it loads */
    }
  }

  /** @internal Access may have changed: fetch the member list again. */
  refreshMembers(): void {
    clearTimeout(this.#membersTimer);
    this.#membersTimer = setTimeout(() => {
      if (!this.#closed) this.#membersLoaded = this.#loadMembers();
    }, 300);
  }

  /** Mentions in text to send, from the member list (waits for it once). */
  async #mentionsIn(text: string): Promise<Mention[]> {
    if (!text.includes("@")) return [];
    await this.#membersLoaded;
    return findMentions(text, this.#members);
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#membersTimer);
    const s = this.#socket;
    this.#socket = null;
    s?.close();
    this.#listeners.clear();
  }

  /** @internal The channel is gone from this account's list. */
  lost(): void {
    this.notice("You no longer have access to this channel.");
    this.#canPost = false;
    this.#gone = true;
    const s = this.#socket;
    this.#socket = null;
    this.#connection = "closed";
    s?.close();
    this.#changed();
  }

  async #connect(): Promise<void> {
    if (this.#closed || this.#gone) return;
    this.#connection = "connecting";
    this.#changed();

    let ticket: string;
    try {
      // Browsers cannot set headers on a websocket, so the session token
      // is traded for a single-use ticket instead of going in the URL.
      ({ ticket } = (await this.#opts.call("/api/v1/ws/ticket", { method: "POST" })) as { ticket: string });
    } catch {
      this.#scheduleReconnect();
      return;
    }
    if (this.#closed || this.#gone) return;

    const ws = new WebSocket(this.#opts.wsUrl(
      `/api/v1/ws?ticket=${encodeURIComponent(ticket)}&channel=${encodeURIComponent(this.#channel.id)}`,
    ));
    this.#socket = ws;
    meterSocket(ws);
    ws.onopen = () => {
      this.#retry = 0;
      this.#connection = "open";
      this.#changed();
    };
    ws.onmessage = (e) => {
      let frame: { type?: string };
      try {
        frame = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (frame.type && GLOBAL_EVENTS.has(frame.type)) {
        // The event socket handles these while it is up.
        if (!this.#chat.eventsOpen) this.#chat.handleGlobal(frame as GlobalFrame);
        return;
      }
      this.#onFrame(frame as ChannelFrame);
    };
    ws.onclose = () => {
      if (this.#socket !== ws) return;
      this.#socket = null;
      this.#connection = "closed";
      // Sends in flight will never be echoed on this socket.
      for (const [ref] of this.#pendingSends) this.#failPending(ref, "connection lost");
      this.#changed();
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#gone) return;
    const delay = RECONNECT_MS[Math.min(this.#retry, RECONNECT_MS.length - 1)];
    this.#retry++;
    setTimeout(() => {
      // Refetching the list first finds out whether access was lost (the
      // server closes the socket on demotion); lost() then stops here.
      this.#chat.refreshChannels()
        .catch(() => {})
        .then(() => this.#connect());
    }, delay);
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#inbound.then(fn);
    this.#inbound = next.catch((err) => console.warn("chat: message handling failed:", err));
    return next;
  }

  #onFrame(frame: ChannelFrame): void {
    switch (frame.type) {
      case "history": {
        const first = !this.#loaded;
        this.#canPost = !!frame.can_post;
        if (first) this.#hasMore = !!frame.has_more;
        void this.#receive(frame.messages ?? [], false);
        this.#enqueue(async () => {
          this.#loaded = true;
          this.#changed();
          if (first && this.#encrypted && this.#groups.isMember(this.#channel.id)) {
            // Bundles may already be waiting (shared while away).
            await this.#importShared();
          }
        });
        break;
      }
      case "message":
        void this.#receive([frame as unknown as ServerMessage], true);
        this.#chat.seenInOpen(this.#channel.id, (frame as unknown as ServerMessage).created_at);
        break;
      case "message_edited":
        this.#enqueue(() => this.#applyEdit(frame.message_id!, frame.body!, frame.edited_at!, frame.mentions));
        break;
      case "message_deleted":
        this.#enqueue(() => this.#tombstone(frame.message_id!));
        break;
      case "reaction":
        this.#enqueue(async () => this.#applyReaction(
          frame.message_id!, frame.emoji!, { user_id: frame.user_id!, username: frame.username ?? "" }, !!frame.added));
        break;
      case "channel_purged":
        this.#enqueue(() => this.#purgeBefore(frame.before!));
        break;
      case "group_advanced":
        this.#enqueue(() => this.#onGroupAdvanced());
        break;
      case "history_shared":
        if ((frame.recipients ?? []).includes(this.#chat.session.status.deviceId)) {
          this.#enqueue(() => this.#importShared());
        }
        break;
      case "error":
        if (frame.ref && this.#pendingSends.has(frame.ref)) this.#failPending(frame.ref, frame.error ?? "failed");
        else this.notice(frame.error ?? "error");
        break;
    }
  }

  // ---------------------------------------------------- receiving text

  /** Prepare messages in order and show them in one change. */
  #receive(list: ServerMessage[], live: boolean): Promise<void> {
    for (const m of list) this.#raw.set(m.id, m);
    return this.#enqueue(async () => {
      for (const m of list) {
        const prepared = await this.#prepare(m, live);
        if (live && m.ref) {
          this.#pendingSends.delete(m.ref);
          this.#messages.delete(`pending:${m.ref}`);
        }
        this.#messages.set(prepared.id, prepared);
      }
      if (list.length) this.#changed(true);
    });
  }

  #base(m: ServerMessage): Omit<ChatMessage, "text" | "files"> {
    return {
      id: m.id,
      channelId: m.channel_id || this.#channel.id,
      authorId: m.author_id,
      username: m.username,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      own: !!m.author_id && m.author_id === this.#chat.userId,
      deleted: m.deleted,
      attachments: m.attachments ?? [],
      mentions: m.mentions ?? [],
      mentionsMe: (m.mentions ?? []).some((p) => p.user_id === this.#chat.userId),
      reactions: this.#reactions(m.reactions),
    };
  }

  #opened(base: Omit<ChatMessage, "text" | "files">, plain: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    const env = decodeEnvelope(plain);
    return { ...base, text: env.text, files: env.files, ...extra };
  }

  /** Turn a server message into something to show, archiving as needed. */
  async #prepare(m: ServerMessage, live: boolean): Promise<ChatMessage> {
    const base = this.#base(m);
    if (m.deleted) {
      if (this.#encrypted) await storage.deletePlaintext(m.id);
      return { ...base, text: "", files: [] };
    }
    if (!this.#encrypted) return { ...base, text: m.body, files: [] };

    const id = m.id;

    // Our own message coming back. MLS senders cannot read their own
    // application messages, so the plaintext comes from the send.
    if (live && m.ref && this.#pendingSends.has(m.ref)) {
      const plain = this.#pendingSends.get(m.ref)!;
      this.#pendingSends.delete(m.ref);
      await storage.putPlaintext(id, plain);
      this.#archived();
      return this.#opened(base, plain);
    }

    // Check the archive before decrypting: MLS deletes each message key
    // once used, so a second attempt at the same ciphertext always fails.
    const saved = await storage.getPlaintext(id);
    if (m.edited_at) {
      const mark = await storage.getEditedAt(id);
      if (saved !== undefined && mark === normalizeTime(m.edited_at)) {
        return this.#opened(base, saved);
      }
      // Edited since this device archived it (or never archived).
      const fresh = await this.#tryDecrypt(m.body);
      if (fresh !== null) {
        await storage.putEdited(id, fresh, m.edited_at);
        this.#archived();
        return this.#opened(base, fresh);
      }
      if (saved !== undefined) {
        // A shared copy carries no mark but is the version its sharer had.
        const sharedBy = await storage.getSharedBy(id);
        return this.#opened(base, saved, sharedBy ? { sharedBy } : { staleEdit: true });
      }
      return this.#unreadable(base);
    }

    if (saved !== undefined) {
      const sharedBy = await storage.getSharedBy(id);
      return this.#opened(base, saved, sharedBy ? { sharedBy } : {});
    }

    const plain = await this.#tryDecrypt(m.body);
    if (plain !== null) {
      await storage.putPlaintext(id, plain);
      this.#archived();
      return this.#opened(base, plain);
    }
    return this.#unreadable(base);
  }

  #unreadable(base: Omit<ChatMessage, "text" | "files">): ChatMessage {
    const why: Unreadable = !this.#groups.isMember(this.#channel.id)
      ? "not_member"
      : base.own ? "other_device" : "before_join";
    return { ...base, text: "", files: [], unreadable: why };
  }

  async #tryDecrypt(body: string): Promise<string | null> {
    if (!body || !this.#groups.isMember(this.#channel.id)) return null;
    let bytes: Uint8Array;
    try {
      bytes = b64decode(body);
    } catch {
      return null;
    }
    const plain = await this.#groups.decrypt(this.#channel.id, bytes);
    return plain ? new TextDecoder().decode(plain) : null;
  }

  #archived(): void {
    try {
      this.#opts.onArchived?.();
    } catch {
      /* the backup schedule is best-effort */
    }
  }

  async #applyEdit(id: string, body: string, editedAt: string, mentions?: Mention[]): Promise<void> {
    const raw = this.#raw.get(id);
    if (raw) this.#raw.set(id, { ...raw, body, edited_at: editedAt, ...(mentions ? { mentions } : {}) });
    let current = this.#messages.get(id);
    if (current && mentions) {
      current = {
        ...current, mentions,
        mentionsMe: mentions.some((p) => p.user_id === this.#chat.userId),
      };
    }

    if (!this.#encrypted) {
      if (current) this.#put({ ...current, text: body, editedAt });
      return;
    }

    // Our own edit: the plaintext is known, the ciphertext unreadable.
    const mine = this.#pendingEdits.get(id);
    if (mine !== undefined) {
      this.#pendingEdits.delete(id);
      await storage.putEdited(id, mine, editedAt);
      this.#archived();
      if (current) this.#put(this.#opened(this.#base({ ...(this.#raw.get(id) ?? toServer(current)), body, edited_at: editedAt }), mine));
      return;
    }
    if ((await storage.getEditedAt(id)) === normalizeTime(editedAt)) {
      if (current && mentions) this.#put(current); // already applied, but the mentions may be new
      return;
    }

    const fresh = await this.#tryDecrypt(body);
    if (fresh !== null) {
      await storage.putEdited(id, fresh, editedAt);
      this.#archived();
    }
    if (!current) return;
    if (fresh !== null) {
      this.#put(this.#opened({ ...this.#base(this.#raw.get(id) ?? toServer(current)), editedAt }, fresh));
    } else {
      this.#put({ ...current, editedAt, staleEdit: !current.unreadable });
    }
  }

  #reactions(list: readonly ServerReaction[] | undefined): Reaction[] {
    return (list ?? []).filter((r) => r.users.length > 0).map((r) => ({
      emoji: r.emoji,
      users: r.users,
      mine: r.users.some((u) => u.user_id === this.#chat.userId),
    }));
  }

  /** Add or remove one person's reaction. Idempotent: the event and the
   * request's own reply both land here. */
  #applyReaction(id: string, emoji: string, who: Mention, added: boolean): void {
    const raw = this.#raw.get(id);
    const list = (raw?.reactions ?? this.#messages.get(id)?.reactions ?? []).map((r) => ({ emoji: r.emoji, users: [...r.users] }));
    let entry = list.find((r) => r.emoji === emoji);
    const has = !!entry?.users.some((u) => u.user_id === who.user_id);
    if (added === has) return;
    if (added) {
      if (!entry) list.push((entry = { emoji, users: [] }));
      entry.users.push(who);
    } else if (entry) {
      entry.users = entry.users.filter((u) => u.user_id !== who.user_id);
    }
    const next = list.filter((r) => r.users.length > 0);
    if (raw) this.#raw.set(id, { ...raw, reactions: next });
    const current = this.#messages.get(id);
    if (current) this.#put({ ...current, reactions: this.#reactions(next) });
  }

  async #tombstone(id: string): Promise<void> {
    if (this.#encrypted) await storage.deletePlaintext(id);
    const raw = this.#raw.get(id);
    if (raw) this.#raw.set(id, { ...raw, body: "", deleted: true, attachments: [], reactions: [] });
    const current = this.#messages.get(id);
    if (current) {
      this.#put({ ...current, deleted: true, text: "", files: [], attachments: [], reactions: [], unreadable: undefined, staleEdit: undefined });
    }
  }

  async #purgeBefore(before: string): Promise<void> {
    const cutoff = Date.parse(before);
    let n = 0;
    for (const m of [...this.#messages.values()]) {
      if (m.pending || Date.parse(m.createdAt) >= cutoff) continue;
      if (this.#encrypted) await storage.deletePlaintext(m.id);
      this.#messages.delete(m.id);
      this.#raw.delete(m.id);
      n++;
    }
    if (n) {
      this.#changed(true);
      this.notice(`${n} message(s) passed this channel's retention limit.`);
    }
  }

  /**
   * @internal An account was deleted: its messages go, and so does their
   * attribution, as the server already does for history (author NULL,
   * username "[deleted]"), so the live view matches a reload.
   */
  userPurged(userId: string): void {
    for (const m of [...this.#messages.values()]) {
      // Their reactions went with the account.
      for (const r of m.reactions) {
        const who = r.users.find((u) => u.user_id === userId);
        if (who) void this.#enqueue(async () => this.#applyReaction(m.id, r.emoji, who, false));
      }
      if (m.authorId !== userId) continue;
      void this.#enqueue(async () => {
        await this.#tombstone(m.id);
        const raw = this.#raw.get(m.id);
        if (raw) this.#raw.set(m.id, { ...raw, author_id: "", username: DELETED_AUTHOR });
        const current = this.#messages.get(m.id);
        if (current) this.#put({ ...current, authorId: "", username: DELETED_AUTHOR, own: false });
      });
    }
  }

  // ------------------------------------------------------- encryption

  async #openGroup(): Promise<boolean> {
    this.#crypto = { kind: "opening" };
    this.#changed();
    let result;
    try {
      result = await this.#groups.open(this.#channel.id);
    } catch (err) {
      this.#crypto = { kind: "unavailable", detail: errorText(err) };
      this.#changed();
      return false;
    }
    switch (result.status) {
      case "created":
      case "joined":
      case "ready":
        if (result.replaced) {
          this.notice(result.status === "created"
            ? "Nobody could update this channel's old encryption group, so this device started a new one. Earlier messages can't be read by devices that hadn't already read them."
            : "This channel's encryption group was replaced since this device last used it; messages it hadn't already read can't be read here.");
        }
        this.#crypto = { kind: "ready", epoch: result.epoch };
        this.#changed();
        this.#groups.reconcileSoon(this.#channel.id);
        return true;
      case "awaiting_invite":
        this.#crypto = { kind: "waiting", detail: result.detail || "Waiting to be added to this channel's encryption." };
        this.#changed();
        return false;
      default:
        this.#crypto = { kind: "unavailable", detail: result.detail || "Could not open the encryption group." };
        this.#changed();
        return false;
    }
  }

  /** @internal A background reconcile finished. */
  cryptoReady(): void {
    const epoch = this.#groups.epoch(this.#channel.id);
    if (epoch !== null && this.#crypto.kind === "ready" && this.#crypto.epoch !== epoch) {
      this.#crypto = { kind: "ready", epoch };
      this.#changed();
    }
  }

  async #onGroupAdvanced(): Promise<void> {
    if (!this.#encrypted) return;
    const id = this.#channel.id;
    if (!this.#groups.isMember(id)) {
      // Maybe this device is the one just added.
      if (await this.#openGroup()) {
        await this.#importShared();
        await this.#redrawUnreadable();
      }
      return;
    }
    try {
      const epoch = await this.#groups.catchUp(id);
      this.#crypto = { kind: "ready", epoch };
      this.#changed();
      this.#groups.reconcileSoon(id);
    } catch (err) {
      if (isRemoved(err)) this.removedFromGroup((err as Error).name === "GroupReset");
      else this.notice(`Encryption: ${errorText(err)}`);
    }
  }

  /** @internal This device is out of the channel's group. */
  removedFromGroup(replaced: boolean): void {
    if (replaced) {
      // The whole group was replaced, not this device's access: rejoin.
      void this.#enqueue(async () => {
        if (await this.#openGroup()) await this.#redrawUnreadable();
      });
      return;
    }
    this.#crypto = { kind: "removed" };
    this.notice("This device was removed from this channel's encryption. It is added back automatically if it regains access.");
  }

  async #importShared(): Promise<void> {
    try {
      const got = await this.#groups.importSharedHistory(this.#channel.id);
      if (!got.messages) return;
      const names = [...new Set(got.sharedBy.map((b) =>
        !b.verified ? "an unverified member" : b.username ?? "a member"))];
      this.notice(`${got.messages} earlier message(s) shared by ${names.join(", ")}.`);
      this.#archived();
      await this.#redrawUnreadable();
    } catch (err) {
      this.notice(`Shared history: ${errorText(err)}`);
    }
  }

  /** Re-prepare messages that could not be read; some now can. Runs
   * inside the inbound queue. */
  async #redrawUnreadable(): Promise<void> {
    for (const m of [...this.#messages.values()]) {
      if (!m.unreadable) continue;
      const raw = this.#raw.get(m.id);
      if (!raw) continue;
      const again = await this.#prepare(raw, false);
      if (!again.unreadable) this.#put(again);
    }
  }

  // ------------------------------------------------------------ paging

  /** Load the page before the oldest message shown. */
  async loadOlder(): Promise<void> {
    if (this.#loadingOlder || !this.#hasMore || this.#closed) return;
    const oldest = this.snapshot().messages.find((m) => !m.pending);
    if (!oldest) return;
    this.#loadingOlder = true;
    this.#changed();
    try {
      const page = (await this.#opts.call(
        `/api/v1/channels/${this.#channel.id}/messages?before=${encodeURIComponent(oldest.id)}`,
      )) as { messages: ServerMessage[]; has_more: boolean };
      await this.#receive(page.messages.filter((m) => !this.#messages.has(m.id)), false);
      this.#hasMore = page.has_more;
    } catch (err) {
      this.notice(`Couldn't load older messages: ${errorText(err)}`);
    } finally {
      this.#loadingOlder = false;
      this.#changed();
    }
  }

  // ----------------------------------------------------------- sending

  /**
   * Upload one file for the next message in this channel. The server
   * holds it until a message claims it (unclaimed uploads are swept after
   * an hour), so pass the result to send().
   *
   * In an encrypted channel the file is encrypted here first with its own
   * key (attachments.ts). The server gets ciphertext under a placeholder
   * name; `key` carries the real name, type and the key itself, and
   * travels inside the MLS message. The returned `info` shows the real
   * name and size, so the composer and the pending message can show them.
   *
   * The ApiCall must leave Content-Type alone for a FormData body: the
   * browser sets it, multipart boundary included.
   */
  async upload(file: Blob, name: string): Promise<Upload> {
    if (!this.#canPost) throw new Error("you can't post in this channel");
    const form = new FormData();
    let key: Omit<FileKey, "id"> | undefined;
    if (this.#encrypted) {
      if (!this.#groups.isMember(this.#channel.id)) {
        throw new Error("this device hasn't been added to this channel's encryption yet");
      }
      // The name rides in the message, which has a size limit; the server
      // keeps 120 characters of a plain upload's name, so match it.
      const enc = await encryptFile(await file.arrayBuffer(), [...name].slice(0, 120).join(""), file.type);
      key = enc.key;
      form.append("file", new Blob([enc.ciphertext as Uint8Array<ArrayBuffer>]), "encrypted");
    } else {
      form.append("file", file, name);
    }
    const info = (await this.#opts.call(`/api/v1/channels/${this.#channel.id}/attachments`, {
      method: "POST",
      body: form,
    })) as AttachmentInfo;
    if (!key) return { info };
    return {
      info: { ...info, filename: key.name, content_type: key.type, size: key.size },
      key: { ...key, id: info.id },
    };
  }

  /**
   * Send a message. Shown at once as pending; the echo replaces it.
   * attachments: already uploaded (a GIF from POST /channels/{id}/gifs,
   * or upload() results); with one, the text may be empty.
   */
  async send(text: string, attachments: readonly (AttachmentInfo | Upload)[] = []): Promise<void> {
    if (!text.trim() && !attachments.length) return;
    const infos = attachments.map((a) => ("info" in a ? a.info : a));
    const files = attachments.flatMap((a) => ("info" in a && a.key ? [a.key] : []));
    const ws = this.#socket;
    if (!ws || this.#connection !== "open") throw new Error("not connected");
    if (!this.#canPost) throw new Error("you can't post in this channel");

    const mentions = await this.#mentionsIn(text);
    const ref = newRef();
    let body = text;
    let plain = text;
    if (this.#encrypted) {
      if (!this.#groups.isMember(this.#channel.id)) {
        throw new Error("this device hasn't been added to this channel's encryption yet");
      }
      plain = encodeEnvelope({ text, files });
      checkBodyLength(b64encode(new TextEncoder().encode(plain)), true, files.length); // before spending a key
      body = b64encode(await this.#groups.encrypt(this.#channel.id, new TextEncoder().encode(plain)));
    }
    checkBodyLength(body, this.#encrypted, files.length);
    // Plaintext channels need the ref too, to swap out the pending entry.
    this.#pendingSends.set(ref, plain);

    this.#put({
      id: `pending:${ref}`,
      channelId: this.#channel.id,
      authorId: this.#chat.userId,
      username: "",
      createdAt: new Date().toISOString(),
      own: true,
      deleted: false,
      text,
      files,
      attachments: infos,
      mentions,
      mentionsMe: false,
      reactions: [],
      pending: true,
    });
    const ids = infos.map((a) => a.id);
    ws.send(JSON.stringify({
      type: "send", body, ref,
      ...(ids.length ? { attachments: ids } : {}),
      ...(mentions.length ? { mentions: mentions.map((m) => m.user_id) } : {}),
    }));
  }

  #failPending(ref: string, why: string): void {
    this.#pendingSends.delete(ref);
    const m = this.#messages.get(`pending:${ref}`);
    if (m) this.#put({ ...m, failed: why });
  }

  /** Drop a failed pending message from the list. */
  dismiss(id: string): void {
    if (id.startsWith("pending:") && this.#messages.delete(id)) this.#changed(true);
  }

  /** Replace the text of one of your messages. */
  async edit(id: string, text: string): Promise<void> {
    const current = this.#messages.get(id);
    if (!current || !current.own || current.deleted || current.pending) throw new Error("can't edit this message");
    if (!text.trim()) throw new Error("a message can't be empty; delete it instead");
    if (text === current.text) return;

    const mentions = (await this.#mentionsIn(text)).map((m) => m.user_id);
    let body = text;
    if (this.#encrypted) {
      if (current.unreadable) throw new Error("this device can't read that message, so it can't edit it");
      if (!this.#groups.isMember(this.#channel.id)) throw new Error("this device isn't in this channel's encryption");
      // Keep the attachment keys, or the files become unreadable.
      const plain = encodeEnvelope({ text, files: [...current.files] });
      checkBodyLength(b64encode(new TextEncoder().encode(plain)), true);
      body = b64encode(await this.#groups.encrypt(this.#channel.id, new TextEncoder().encode(plain)));
      checkBodyLength(body, true);
      this.#pendingEdits.set(id, plain);
    }
    checkBodyLength(body, this.#encrypted);
    try {
      const res = (await this.#opts.call(`/api/v1/messages/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ body, mentions }),
      })) as { edited_at: string };
      // The event usually arrives first; this covers it arriving late.
      await this.#enqueue(() => this.#applyEdit(id, body, res.edited_at));
    } catch (err) {
      this.#pendingEdits.delete(id);
      throw err;
    }
  }

  /**
   * Add (on) or take back (off) this account's reaction to a message.
   * Needs permission to post in the channel; the server allows at most
   * MAX_REACTION_KINDS different emoji per message.
   */
  async react(id: string, emoji: string, on: boolean): Promise<void> {
    const current = this.#messages.get(id);
    if (!current || current.deleted || current.pending) throw new Error("can't react to this message");
    await this.#opts.call(`/api/v1/messages/${id}/reactions/${encodeURIComponent(emoji)}`, {
      method: on ? "PUT" : "DELETE",
    });
    // The event usually arrives first; this covers it arriving late.
    await this.#enqueue(async () => this.#applyReaction(
      id, emoji, { user_id: this.#chat.userId, username: this.#chat.username }, on));
  }

  /** Delete one of your messages (or anyone's, with the permission). */
  async remove(id: string): Promise<void> {
    if (id.startsWith("pending:")) return this.dismiss(id);
    await this.#opts.call(`/api/v1/messages/${id}`, { method: "DELETE" });
    await this.#enqueue(() => this.#tombstone(id));
  }
}

interface ChannelFrame {
  type: string;
  messages?: ServerMessage[];
  can_post?: boolean;
  has_more?: boolean;
  message_id?: string;
  body?: string;
  edited_at?: string;
  before?: string;
  recipients?: string[];
  error?: string;
  ref?: string;
  mentions?: Mention[];
  emoji?: string;
  user_id?: string;
  username?: string;
  added?: boolean;
}

function toServer(m: ChatMessage): ServerMessage {
  return {
    id: m.id,
    channel_id: m.channelId,
    author_id: m.authorId,
    username: m.username,
    body: "",
    deleted: m.deleted,
    created_at: m.createdAt,
    edited_at: m.editedAt,
    attachments: [...m.attachments],
    mentions: [...m.mentions],
    reactions: m.reactions.map((r) => ({ emoji: r.emoji, users: [...r.users] })),
  };
}
