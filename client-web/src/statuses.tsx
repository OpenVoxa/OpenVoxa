// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Custom status (decisions.md Feature decisions, "User avatars and
 * profiles", stage 2b; server statuses.go). An optional emoji plus up to
 * 60 characters, shown on the profile card, under names in voice
 * channels and under your own name in the user panel.
 *
 * The server lists everyone's; status_changed events keep the list live
 * (also when a status runs out, which the server sweeps) and a
 * reconnected event socket refetches it, as for avatars.
 *
 * Set in Settings, Profile (StatusFields, saved with the bio) or in the
 * small Set Status dialog from your own profile card or the user panel.
 * "Clear after" is turned into a time here, since only the browser knows
 * when the person's day ends.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { ApiCall } from "@core/identity";
import type { UserStatus } from "@core/chat";
import { Modal } from "./ChannelDialogs";
import { EmojiPicker } from "./emoji";

export type { UserStatus };

/** Most characters in a status (the server's limit). */
export const STATUS_MAX_CHARS = 60;

let call: ApiCall | null = null;
/** Account id -> status. Replaced, never changed in place. */
let statuses: Record<string, UserStatus> | null = null;
let loading = false;
let again = false;
const listeners = new Set<() => void>();

function changed() {
  for (const l of listeners) l();
}

/** Called by ChatApp once signed in. */
export function configureStatuses(c: ApiCall): void {
  if (call !== c) statuses = null;
  call = c;
  refreshStatuses();
}

/** Fetch the list again. Calls during a fetch are folded into one more. */
export function refreshStatuses(): void {
  if (!call) return;
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  const from = call;
  (from("/api/v1/statuses") as Promise<{ users: Record<string, UserStatus> }>)
    .then((r) => {
      if (from === call) statuses = r.users;
    })
    .catch(() => {
      /* keep the last list until the next try */
    })
    .finally(() => {
      loading = false;
      changed();
      if (again) {
        again = false;
        refreshStatuses();
      }
    });
}

/** A status_changed event, or our own save: the new status, or null. */
export function statusChanged(userId: string, status: UserStatus | null): void {
  if (!userId) return;
  const next = { ...(statuses ?? {}) };
  if (status && (status.emoji || status.text)) next[userId] = status;
  else delete next[userId];
  statuses = next;
  changed();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** Someone's current status, or undefined for none. */
export function useStatus(userId: string | null | undefined): UserStatus | undefined {
  const s = useSyncExternalStore(subscribe, () => statuses);
  return userId && s ? s[userId] : undefined;
}

/** "🎮 Playing ranked" as one line; nothing when there is no status. */
export function StatusLine({ userId, className = "status-line" }: { userId: string; className?: string }) {
  const s = useStatus(userId);
  if (!s) return null;
  const text = [s.emoji, s.text].filter(Boolean).join(" ");
  return <span className={className} title={text}>{text}</span>;
}

// -------------------------------------------------------------- editing

/** "Clear after" choices; "keep" (as already set) only when editing a timed status. */
export type ClearAfter = "never" | "1h" | "4h" | "today" | "keep";

const CLEAR_AFTER: [ClearAfter, string][] = [
  ["never", "Never"],
  ["1h", "1 hour"],
  ["4h", "4 hours"],
  ["today", "Today"],
];

/** The time to send for a choice (ISO), or null for never. */
export function clearAtFor(choice: ClearAfter, keep: string | null, now = new Date()): string | null {
  switch (choice) {
    case "1h":
      return new Date(now.getTime() + 3_600_000).toISOString();
    case "4h":
      return new Date(now.getTime() + 4 * 3_600_000).toISOString();
    case "today": {
      // The next local midnight.
      const d = new Date(now);
      d.setHours(24, 0, 0, 0);
      return d.toISOString();
    }
    case "keep":
      return keep;
    default:
      return null;
  }
}

/** "18:30", or "Wed 00:00" when not today. */
function clearTimeText(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** Your own status as Settings and the dialog edit it. */
export interface StatusDraft {
  emoji: string;
  text: string;
  clearAfter: ClearAfter;
}

/** What the server has for you (GET /api/v1/me/profile, "status"). */
export interface OwnStatus {
  emoji: string;
  text: string;
  /** ISO time, or null: kept until changed. */
  clear_at: string | null;
}

export function draftFrom(s: OwnStatus | null): StatusDraft {
  return s
    ? { emoji: s.emoji, text: s.text, clearAfter: s.clear_at ? "keep" : "never" }
    : { emoji: "", text: "", clearAfter: "never" };
}

/** Whether the draft differs from what is saved. */
export function draftDirty(d: StatusDraft, saved: OwnStatus | null): boolean {
  const s = draftFrom(saved);
  return d.emoji !== s.emoji || d.text.trim() !== s.text || d.clearAfter !== s.clearAfter;
}

/** The PATCH /api/v1/me/profile "status" value for a draft. */
export function statusBody(d: StatusDraft, saved: OwnStatus | null): OwnStatus | null {
  const text = d.text.trim();
  if (!text && !d.emoji) return null;
  return { emoji: d.emoji, text, clear_at: clearAtFor(d.clearAfter, saved?.clear_at ?? null) };
}

export const statusTooLong = (d: StatusDraft) => Array.from(d.text.trim()).length > STATUS_MAX_CHARS;

const PICKER_W = 360;
const PICKER_H = 380;

/** Emoji button, text and "Clear after", for Settings and the dialog. */
export function StatusFields({ draft, saved, disabled, onChange }: {
  draft: StatusDraft;
  saved: OwnStatus | null;
  disabled?: boolean;
  onChange: (d: StatusDraft) => void;
}) {
  const [picker, setPicker] = useState<CSSProperties | null>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const chars = Array.from(draft.text.trim()).length;
  const keep = saved?.clear_at && draft.clearAfter === "keep" ? saved.clear_at : null;
  const hasStatus = !!(draft.emoji || draft.text.trim());

  function openPicker() {
    const r = emojiButton.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PICKER_W - 8));
    const top = r.bottom + 4 + PICKER_H <= window.innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - PICKER_H - 4);
    setPicker({ position: "fixed", top, left, right: "auto", bottom: "auto",
      width: Math.min(PICKER_W, window.innerWidth - 16), zIndex: 20 });
  }

  return (
    <>
      <div className="status-row">
        <button ref={emojiButton} type="button" className="secondary status-emoji" disabled={disabled}
          title={draft.emoji ? "Change the emoji (right-click to remove it)" : "Choose an emoji"}
          aria-label={draft.emoji ? `Emoji ${draft.emoji}, change` : "Choose an emoji"}
          // Kept from the picker's click-outside check, so a second click
          // closes it rather than closing and reopening it.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => (picker ? setPicker(null) : openPicker())}
          onContextMenu={(e) => {
            if (!draft.emoji) return;
            e.preventDefault();
            onChange({ ...draft, emoji: "" });
          }}>
          {draft.emoji || <SmileIcon />}
        </button>
        <input className="status-input" value={draft.text} disabled={disabled} aria-label="Status"
          placeholder="What are you up to?" maxLength={STATUS_MAX_CHARS * 2}
          onChange={(e) => onChange({ ...draft, text: e.target.value.replace(/\n/g, " ") })} />
      </div>
      <p className={`small bio-count ${chars > STATUS_MAX_CHARS ? "error" : "muted"}`}>
        {chars} / {STATUS_MAX_CHARS} characters
      </p>
      <label className="status-clear">
        <span>Clear after</span>
        <select value={draft.clearAfter} disabled={disabled || !hasStatus} aria-label="Clear after"
          onChange={(e) => onChange({ ...draft, clearAfter: e.target.value as ClearAfter })}>
          {saved?.clear_at && <option value="keep">As set (clears {clearTimeText(saved.clear_at)})</option>}
          {CLEAR_AFTER.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        {!keep && draft.clearAfter !== "never" && hasStatus && (
          <span className="muted small">Clears {clearTimeText(clearAtFor(draft.clearAfter, null)!)}</span>
        )}
      </label>
      {picker && (
        <EmojiPicker label="Status emoji" style={picker} onClose={() => setPicker(null)}
          onPick={(emoji) => {
            onChange({ ...draft, emoji });
            setPicker(null);
          }} />
      )}
    </>
  );
}

function SmileIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4zM5.6 9.4a2.8 2.8 0 0 0 4.8 0l1.2.7a4.2 4.2 0 0 1-7.2 0zM5.8 5.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm4.4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
    </svg>
  );
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Save a status (null clears it); updates the list here at once too. */
export async function saveOwnStatus(c: ApiCall, userId: string, body: OwnStatus | null): Promise<OwnStatus | null> {
  const p = await c("/api/v1/me/profile", { method: "PATCH", body: JSON.stringify({ status: body }) }) as
    { status: OwnStatus | null };
  statusChanged(userId, p.status && { emoji: p.status.emoji, text: p.status.text });
  return p.status;
}

/** "Set Status", from your own profile card or the user panel. */
export function SetStatusDialog({ call: c, userId, onClose }: { call: ApiCall; userId: string; onClose: () => void }) {
  const [saved, setSaved] = useState<OwnStatus | null | undefined>(undefined); // undefined: loading
  const [draft, setDraft] = useState<StatusDraft>(draftFrom(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (c("/api/v1/me/profile") as Promise<{ status: OwnStatus | null }>).then(
      (p) => {
        if (!live) return;
        setSaved(p.status);
        setDraft(draftFrom(p.status));
      },
      (err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [c]);

  async function save(body: OwnStatus | null) {
    setBusy(true);
    setError(null);
    try {
      await saveOwnStatus(c, userId, body);
      onClose();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  const loaded = saved !== undefined;
  const dirty = loaded && draftDirty(draft, saved);
  return (
    <Modal title="Set Status" onClose={onClose}>
      <form className="modal-body" onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !statusTooLong(draft)) void save(statusBody(draft, saved));
      }}>
        <StatusFields draft={draft} saved={saved ?? null} disabled={!loaded || busy} onChange={setDraft} />
        <p className="muted small">
          Shown on your profile card and under your name in voice channels, to everyone on this server.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="submit" className="save" disabled={busy || !dirty || statusTooLong(draft)}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="secondary" disabled={busy || !saved} onClick={() => void save(null)}>
            Clear Status
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
