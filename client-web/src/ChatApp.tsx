// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed-in client: channel sidebar, message pane, composer (build
 * order 13, M2). Discord-like layout, one server per instance, so no
 * server rail. Voice channels are listed but inert until M3.
 *
 * All chat logic lives in client-core's Chat / ChannelView; this file
 * only draws their snapshots and forwards what the user does.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Chat, type ChannelView, type ChannelInfo } from "@core/chat";
import type { BackupStatus } from "@core/recovery";
import type { Session } from "./api";
import type { BackupManager } from "./backup";
import { apiCall, cryptoSession, localStore, wsUrl } from "./core";
import { ChannelPane } from "./ChannelPane";
import { ChannelSettingsDialog, CreateChannelDialog } from "./ChannelDialogs";

const LAST_CHANNEL = (userId: string) => `lastChannel.${userId}`;

export function ChatApp({ session, manager, backup, notice, busy, onLogout, onBackUpNow, onSetUpKey, onEnterKey, onExpired }: {
  session: Session;
  manager: BackupManager;
  backup: BackupStatus | null;
  notice: string | null;
  busy: string | null;
  onLogout: (chat: Chat | null) => void;
  onBackUpNow: () => void;
  onSetUpKey: () => void;
  onEnterKey: () => void;
  onExpired: () => void;
}) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [channels, setChannels] = useState<readonly ChannelInfo[]>([]);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<ChannelView | null>(null);
  // Permissions move while signed in (perms_changed); start from login's.
  const [perms, setPerms] = useState<readonly string[]>(session.permissions);
  const [dialog, setDialog] = useState<
    | { k: "create"; kind: "text" | "voice" }
    | { k: "settings"; id: string }
    | null
  >(null);
  const call = useMemo(() => apiCall(session.token, onExpired),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.token]);

  // Start the crypto session (this tab takes over the account's device)
  // and the chat on top of it.
  useEffect(() => {
    let live = true;
    let started: Chat | null = null;
    cryptoSession(session.user_id, call)
      .then(async (crypto) => {
        if (!live) return;
        const c = new Chat(crypto, {
          call,
          wsUrl,
          userId: session.user_id,
          store: localStore,
          onArchived: () => manager.scheduleUpload(),
        });
        started = c;
        c.on((e) => {
          if (e.type === "channels") setChannels(e.channels);
          else if (e.type === "unread") setUnread(e.unread);
          else if (e.type === "me_changed") {
            (call("/api/v1/me") as Promise<{ permissions: string[] }>)
              .then((me) => live && setPerms(me.permissions ?? []))
              .catch(() => {});
          }
        });
        await c.start();
        if (!live) {
          c.close();
          return;
        }
        setChannels(c.channels);
        setUnread(c.unread);
        setChat(c);
      })
      .catch((err) => live && setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
      started?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user_id, session.token]);

  const text = useMemo(() => channels.filter((c) => c.kind === "text"), [channels]);
  const voice = useMemo(() => channels.filter((c) => c.kind === "voice"), [channels]);

  // Pick a channel: the open one if it still exists, else the last one
  // used, else the first.
  useEffect(() => {
    if (!chat || !text.length) return;
    if (openId && text.some((c) => c.id === openId)) return;
    const last = localStore.get(LAST_CHANNEL(session.user_id));
    setOpenId(text.find((c) => c.id === last)?.id ?? text[0].id);
  }, [chat, text, openId, session.user_id]);

  useEffect(() => {
    if (!chat || !openId) return;
    if (chat.view?.channel.id === openId) return;
    try {
      setView(chat.open(openId));
      localStore.set(LAST_CHANNEL(session.user_id), openId);
    } catch {
      /* gone from the list meanwhile; the effect above picks another */
    }
  }, [chat, openId, session.user_id]);

  if (failed) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Couldn't start</h1>
          <p className="error">{failed}</p>
          <button className="primary" onClick={() => location.reload()}>Try again</button>
          <button className="link" onClick={() => onLogout(null)} disabled={!!busy}>Log out</button>
        </div>
      </div>
    );
  }
  if (!chat) {
    return <div className="auth-page"><p className="muted">Setting up encryption…</p></div>;
  }

  const can = (p: string) => perms.includes(p) || perms.includes("administrator");
  const canDeleteAny = can("delete_messages");
  const canManage = can("manage_channels");
  const canForcePTT = can("force_ptt");
  const settingsFor = (c: ChannelInfo) => canManage || (c.kind === "voice" && canForcePTT);
  const dialogChannel = dialog?.k === "settings" ? channels.find((c) => c.id === dialog.id) : undefined;

  const gear = (c: ChannelInfo) => settingsFor(c) && (
    <button className="icon gear" onClick={() => setDialog({ k: "settings", id: c.id })}
      title={`${c.name} settings`} aria-label={`${c.name} settings`}>
      <GearIcon />
    </button>
  );
  const heading = (label: string, kind: "text" | "voice") => (
    <div className="list-head">
      <h2>{label}</h2>
      {canManage && (
        <button className="icon" onClick={() => setDialog({ k: "create", kind })}
          title={`Create a ${kind} channel`} aria-label={`Create a ${kind} channel`}>+</button>
      )}
    </div>
  );

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Channels">
        <header className="sidebar-head">OpenVoxa</header>
        <div className="channel-list">
          {heading("Text channels", "text")}
          <ul>
            {text.map((c) => (
              <li key={c.id} className="channel-row">
                <button
                  className={`channel${c.id === openId ? " active" : ""}${unread.has(c.id) ? " unread" : ""}`}
                  onClick={() => setOpenId(c.id)}
                  aria-current={c.id === openId ? "page" : undefined}
                  title={c.encrypted ? "End-to-end encrypted" : "Not encrypted"}
                >
                  <span className="hash" aria-hidden>#</span>
                  <span className="name">{c.name}</span>
                  {c.encrypted && <LockIcon />}
                  {unread.has(c.id) && <span className="dot" aria-label="unread" />}
                </button>
                {gear(c)}
              </li>
            ))}
            {!text.length && <li className="muted empty">No channels you can see.</li>}
          </ul>
          {(voice.length > 0 || canManage) && (
            <>
              {heading("Voice channels", "voice")}
              <ul>
                {voice.map((c) => (
                  <li key={c.id} className="channel-row">
                    <button className="channel" disabled title="Voice arrives in a later version; use the debug page for now">
                      <SpeakerIcon />
                      <span className="name">{c.name}</span>
                      {c.force_ptt && <span className="tag small" title="Push-to-talk required">PTT</span>}
                    </button>
                    {gear(c)}
                  </li>
                ))}
                {!voice.length && <li className="muted empty">No voice channels yet.</li>}
              </ul>
            </>
          )}
        </div>
        <UserPanel session={session} backup={backup} notice={notice} busy={busy}
          onLogout={() => onLogout(chat)} onBackUpNow={onBackUpNow}
          onSetUpKey={onSetUpKey} onEnterKey={onEnterKey} />
      </nav>
      <main className="pane">
        {view ? (
          <ChannelPane key={view.channel.id} view={view} username={session.username} canDeleteAny={canDeleteAny} />
        ) : (
          <div className="pane-empty muted">{text.length ? "Opening…" : "Nothing to show yet."}</div>
        )}
      </main>
      {dialog?.k === "create" && (
        <CreateChannelDialog
          call={call}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
          onCreated={(c) => {
            setDialog(null);
            void chat.refreshChannels().then(() => {
              if (c.kind === "text") setOpenId(c.id);
            });
          }}
        />
      )}
      {dialogChannel && (
        <ChannelSettingsDialog
          key={dialogChannel.id}
          call={call}
          channel={dialogChannel}
          canManage={canManage}
          canForcePTT={canForcePTT}
          onClose={() => {
            setDialog(null);
            void chat.refreshChannels().catch(() => {});
          }}
          onDeleted={() => {
            setDialog(null);
            void chat.refreshChannels().catch(() => {});
          }}
        />
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path fill="currentColor" d="M9.4 1l.3 1.8c.5.2.9.4 1.3.7l1.7-.7 1.4 2.4-1.4 1.1a5 5 0 0 1 0 1.5l1.4 1.1-1.4 2.4-1.7-.7c-.4.3-.8.5-1.3.7L9.4 15H6.6l-.3-1.8c-.5-.2-.9-.4-1.3-.7l-1.7.7-1.4-2.4 1.4-1.1a5 5 0 0 1 0-1.5L1.9 7.1l1.4-2.4 1.7.7c.4-.3.8-.5 1.3-.7L6.6 1h2.8zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="lock" viewBox="0 0 16 16" width="12" height="12" aria-label="encrypted" role="img">
      <path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2z" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg className="hash" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path fill="currentColor" d="M2 6h2.5L8 3v10L4.5 10H2zM10.5 5.2a4 4 0 0 1 0 5.6l-.9-.9a2.7 2.7 0 0 0 0-3.8z" />
    </svg>
  );
}

function UserPanel({ session, backup, notice, busy, onLogout, onBackUpNow, onSetUpKey, onEnterKey }: {
  session: Session;
  backup: BackupStatus | null;
  notice: string | null;
  busy: string | null;
  onLogout: () => void;
  onBackUpNow: () => void;
  onSetUpKey: () => void;
  onEnterKey: () => void;
}) {
  return (
    <div className="user-panel">
      <div className="who">
        <strong>{session.username}</strong>
        <span className="muted small">
          {!backup && <>No recovery key. <button className="link small" onClick={onSetUpKey}>Set one up</button></>}
          {backup && !backup.unlocked && <>Not backing up. <button className="link small" onClick={onEnterKey}>Enter key</button></>}
          {backup?.unlocked && (
            <>Backed up <TimeAgo at={backup.updatedAt} />. <button className="link small" onClick={onBackUpNow} disabled={!!busy}>Back up now</button></>
          )}
        </span>
        {notice && <span className="muted small" role="status">{notice}</span>}
      </div>
      <button className="secondary" onClick={onLogout} disabled={!!busy}>{busy ?? "Log out"}</button>
    </div>
  );
}

/** Re-render once a minute, for relative times. */
function useMinuteTick(): number {
  return useSyncExternalStore(
    (cb) => {
      const t = setInterval(cb, 60_000);
      return () => clearInterval(t);
    },
    () => Math.floor(Date.now() / 60_000),
  );
}

function TimeAgo({ at }: { at: string }) {
  useMinuteTick();
  return <>{timeAgo(at)}</>;
}

function timeAgo(at: string): string {
  const s = (Date.now() - Date.parse(at)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}
