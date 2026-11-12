// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Direct messages in the web client (decisions.md Feature decisions,
 * "Direct messages", stage 2): the sidebar's Messages list, the New
 * Message picker, and the wording for a read-only conversation. A DM
 * opens in the main pane like an encrypted text channel (client-core
 * Chat.open with its channel id); client-core keeps the list
 * (Chat.dms) and its alerts, which work like mentions.
 */

import { useEffect, useMemo, useState } from "react";
import type { ApiCall } from "@core/identity";
import type { DMInfo } from "@core/chat";
import { Modal } from "./ChannelDialogs";
import { BellIcon } from "./ChannelPane";
import { ColouredName } from "./names";
import { dmName, NO_DM_REASON, readOnlyText } from "./dmText";
import { Avatar } from "./avatars";

/** The sidebar's Messages tab: your conversations, newest first. */
export function DMList({ dms, openId, unread, mentions, muted, canStart, onOpen, onNew, menuHandlers, touchHandled }: {
  dms: readonly DMInfo[];
  /** The conversation in the main pane, if one is. */
  openId: string | null;
  unread: ReadonlySet<string>;
  mentions: ReadonlySet<string>;
  muted: ReadonlySet<string>;
  canStart: boolean;
  onOpen: (channelId: string) => void;
  onNew: () => void;
  /** Right-click / long-press handlers for a row (ChannelMenu's useMenuTrigger). */
  menuHandlers: (channelId: string, onTap?: () => void) => object;
  touchHandled: () => boolean;
}) {
  return (
    <>
      <div className="list-head">
        <h2>Direct Messages</h2>
        <button className="icon" onClick={onNew} disabled={!canStart}
          title={canStart ? "New Message" : NO_DM_REASON}
          aria-label="New Message">+</button>
      </div>
      <ul>
        {dms.map((d) => {
          const id = d.channel_id;
          const alert = mentions.has(id);
          return (
            <li key={id} className="channel-row">
              <button
                className={`channel dm${id === openId ? " active" : ""}${unread.has(id) || alert ? " unread" : ""}`}
                {...menuHandlers(id, () => onOpen(id))}
                onClick={() => {
                  if (touchHandled()) return;
                  onOpen(id);
                }}
                aria-current={id === openId ? "page" : undefined}
                title={d.can_post ? `Direct message with ${dmName(d)}` : readOnlyText(d)}
              >
                <Avatar userId={d.user.deleted ? null : d.user.id} name={dmName(d)} />
                {d.user.deleted
                  ? <span className="name muted">{dmName(d)}</span>
                  : <ColouredName userId={d.user.id} className="name">{dmName(d)}</ColouredName>}
                {muted.has(id) && <span className="muted-bell" title="Sounds muted"><BellIcon off size={12} /></span>}
                {alert
                  ? <span className="mention-badge dot-badge" aria-label="new messages" title="New messages" />
                  : unread.has(id) && <span className="dot" aria-label="unread" />}
              </button>
            </li>
          );
        })}
        {!dms.length && (
          <li className="muted empty">
            {canStart ? "No conversations yet. Start one with + or \"Message\" on anyone's name." : NO_DM_REASON + "."}
          </li>
        )}
      </ul>
    </>
  );
}

interface Candidate {
  id: string;
  username: string;
}

/** New Message: pick someone to message (GET /dm-candidates). */
export function NewMessageDialog({ call, onClose, onPick }: {
  call: ApiCall;
  onClose: () => void;
  /** Start or open the DM; resolves to an error to show, or null when done. */
  onPick: (userId: string) => Promise<string | null>;
}) {
  const [people, setPeople] = useState<Candidate[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (call("/api/v1/dm-candidates") as Promise<Candidate[]>)
      .then((list) => live && setPeople(list))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [call]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people ?? []).filter((p) => p.username.toLowerCase().includes(q));
  }, [people, query]);

  async function pick(id: string) {
    setBusy(id);
    setError(null);
    const err = await onPick(id);
    setBusy(null);
    if (err) setError(err);
  }

  return (
    <Modal title="New Message" onClose={onClose}>
      <div className="settings-form">
        <input autoFocus placeholder="Find someone" value={query} aria-label="Find someone"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown.length === 1 && !busy) void pick(shown[0].id);
          }} />
        {error && <p className="error small" role="alert">{error}</p>}
        <ul className="pick-list">
          {people === null && !error && <li className="muted small">Loading…</li>}
          {people !== null && !shown.length && (
            <li className="muted small">{people.length ? "Nobody by that name." : "Nobody here can receive direct messages yet."}</li>
          )}
          {shown.map((p) => (
            <li key={p.id}>
              <button className="pick" disabled={!!busy} onClick={() => void pick(p.id)}>
                <Avatar userId={p.id} name={p.username} />
                <ColouredName userId={p.id}>{p.username}</ColouredName>
                {busy === p.id && <span className="muted small">Opening…</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
