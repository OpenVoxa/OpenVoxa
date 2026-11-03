// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One open text channel: header, message list with history paging, and
 * the composer. Edit and delete act on your own messages (delete also on
 * anyone's with the delete_messages permission); Report on other people's.
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type FormEvent, type KeyboardEvent, type ReactNode,
} from "react";
import type { AttachmentInfo, ChannelSnapshot, ChannelView, ChatMessage, CryptoState, Notice, Upload } from "@core/chat";
import type { ApiCall } from "@core/identity";
import { describeRetention, Modal } from "./ChannelDialogs";
import { firstLink, Markdown } from "./markdown";
import { LinkPreview } from "./previews";
import { GifPicker, useGifsEnabled } from "./gifs";
import { PREVIEWS_ENCRYPTED, useToggle } from "./settings";
import { PlainAttachment, SealedAttachment, UploadTray, useUploads } from "./attachments";

function useSnapshot(view: ChannelView): ChannelSnapshot {
  const subscribe = useCallback((cb: () => void) => view.on(cb), [view]);
  return useSyncExternalStore(subscribe, () => view.snapshot());
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ChannelPane({ view, call, username, canDeleteAny }: {
  view: ChannelView;
  call: ApiCall;
  username: string;
  canDeleteAny: boolean;
}) {
  const snap = useSnapshot(view);
  const previewsEncrypted = useToggle(PREVIEWS_ENCRYPTED);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = snap.channel;
  const previews = !c.encrypted || previewsEncrypted;

  const lastOwn = [...snap.messages].reverse().find((m) => m.own && !m.deleted && !m.pending && !m.unreadable);
  const uploads = useUploads(view, setError);
  const canAttach = composeBlocker(snap) === null;

  // Drag and drop anywhere on the pane. dragenter/leave fire for every
  // child element crossed, so count them rather than trusting one event.
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  return (
    <section className="channel-pane" aria-label={`#${c.name}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = canAttach ? "copy" : "none";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        if (--depth.current <= 0) {
          depth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (canAttach) uploads.add(e.dataTransfer.files);
      }}>
      {dragging && (
        <div className="drop-overlay" aria-hidden>
          {canAttach ? `Drop to attach to #${c.name}` : composeBlocker(snap)}
        </div>
      )}
      <header className="pane-head">
        <h1><span className="hash" aria-hidden>#</span>{c.name}</h1>
        <CryptoBadge encrypted={c.encrypted} crypto={snap.crypto} />
        <span className="muted small">
          kept {describeRetention(c.retention)}
          {c.encrypted && c.history_sharing ? " · history shared with new members" : ""}
        </span>
        {snap.connection !== "open" && (
          <span className="conn small">{snap.connection === "connecting" ? "Connecting…" : "Disconnected, retrying…"}</span>
        )}
      </header>

      <CryptoBanner crypto={snap.crypto} />

      <MessageList
        view={view}
        snap={snap}
        call={call}
        previews={previews}
        username={username}
        canDeleteAny={canDeleteAny}
        editing={editing}
        setEditing={setEditing}
        onError={setError}
      />

      {error && (
        <div className="pane-error" role="alert">
          {error} <button className="link small" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <Composer
        snap={snap}
        call={call}
        uploads={uploads}
        onSend={async (text, attachments) => {
          setError(null);
          try {
            await view.send(text, attachments);
            return true;
          } catch (err) {
            setError(errText(err));
            return false;
          }
        }}
        onEditLast={() => lastOwn && setEditing(lastOwn.id)}
      />
    </section>
  );
}

function CryptoBadge({ encrypted, crypto }: { encrypted: boolean; crypto: CryptoState }) {
  if (!encrypted) return <span className="badge plain" title="The server can read messages in this channel">Not encrypted</span>;
  const title = crypto.kind === "ready" ? `End-to-end encrypted (epoch ${crypto.epoch})` : "End-to-end encrypted";
  return <span className="badge enc" title={title}>Encrypted</span>;
}

function CryptoBanner({ crypto }: { crypto: CryptoState }) {
  let text: string | null = null;
  switch (crypto.kind) {
    case "opening": text = "Opening encryption…"; break;
    case "waiting": text = `${crypto.detail} Messages appear once a member's app adds this device; that happens automatically.`; break;
    case "removed": text = "This device was removed from this channel's encryption. It's added back automatically if it regains access."; break;
    case "unavailable": text = `Encryption unavailable: ${crypto.detail}`; break;
  }
  return text ? <div className="banner" role="status">{text}</div> : null;
}

// --------------------------------------------------------------- list

/** Close enough to the bottom to keep following new messages. */
const STICK_PX = 80;
/** Start loading older history this close to the top. */
const OLDER_PX = 300;

function MessageList({ view, snap, call, previews, username, canDeleteAny, editing, setEditing, onError }: {
  view: ChannelView;
  snap: ChannelSnapshot;
  call: ApiCall;
  previews: boolean;
  username: string;
  canDeleteAny: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
  onError: (e: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The message at the top of the view and its offset from the top, so
  // the view can stay still while older messages are added above it.
  const anchor = useRef<{ id: string; delta: number } | null>(null);
  const [reporting, setReporting] = useState<ChatMessage | null>(null);

  const remember = (el: HTMLDivElement) => {
    anchor.current = null;
    for (const node of el.querySelectorAll<HTMLElement>(".msg[data-id]")) {
      if (node.offsetTop + node.offsetHeight > el.scrollTop) {
        anchor.current = { id: node.dataset.id!, delta: node.offsetTop - el.scrollTop };
        break;
      }
    }
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
    } else if (anchor.current) {
      const node = el.querySelector<HTMLElement>(`.msg[data-id="${CSS.escape(anchor.current.id)}"]`);
      if (node) el.scrollTop = node.offsetTop - anchor.current.delta;
    }
    remember(el);
  });

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    remember(el);
    if (el.scrollTop < OLDER_PX && snap.hasMore && !snap.loadingOlder) void view.loadOlder();
  };

  // A short first page may not fill the screen, so there is nothing to
  // scroll; load more until it does or history runs out.
  useEffect(() => {
    const el = ref.current;
    if (!el || !snap.loaded || !snap.hasMore || snap.loadingOlder) return;
    if (el.scrollHeight <= el.clientHeight + OLDER_PX) void view.loadOlder();
  }, [snap.loaded, snap.hasMore, snap.loadingOlder, snap.messages.length, view]);

  // Notices sit among the messages by time, after any sent at the same
  // moment. Pending messages carry the time they were sent from here.
  const rows: ReactNode[] = [];
  const notices = snap.notices;
  let ni = 0;
  let lastDay = "";
  /** A day separator when `at` starts a new day; true if it did. */
  const dayBreak = (at: string, key: string) => {
    const day = new Date(at).toDateString();
    if (day === lastDay) return false;
    lastDay = day;
    rows.push(<div key={`day:${day}:${key}`} className="day" role="separator"><span>{formatDay(at)}</span></div>);
    return true;
  };
  const noticesBefore = (at: string | null) => {
    const t = at === null ? Infinity : Date.parse(at);
    while (ni < notices.length && Date.parse(notices[ni].at) < t) {
      const n = notices[ni];
      dayBreak(n.at, `n${n.id}`);
      rows.push(<NoticeRow key={`n${n.id}`} n={n} />);
      ni++;
    }
  };
  let prev: ChatMessage | undefined;
  for (const m of snap.messages) {
    const before = ni;
    noticesBefore(m.createdAt);
    // A notice breaks up a run of messages from one person.
    if (ni !== before) prev = undefined;
    const newDay = dayBreak(m.createdAt, m.id);
    const compact = !newDay && !!prev && prev.authorId === m.authorId && !prev.deleted &&
      Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
    rows.push(
      <Message
        key={m.id}
        m={m}
        call={call}
        encrypted={snap.channel.encrypted}
        previews={previews}
        compact={compact}
        username={username}
        canDelete={!m.pending && !m.deleted && (m.own || canDeleteAny)}
        canEdit={snap.canPost && m.own && !m.pending && !m.deleted && !m.unreadable}
        canReport={!m.own && !!m.authorId && !m.pending && !m.deleted && !m.unreadable}
        onReport={() => setReporting(m)}
        editing={editing === m.id}
        onEdit={() => setEditing(m.id)}
        onCancelEdit={() => setEditing(null)}
        onSaveEdit={async (text) => {
          try {
            await view.edit(m.id, text);
            setEditing(null);
          } catch (err) {
            onError(errText(err));
          }
        }}
        onDelete={async (skipConfirm) => {
          if (!skipConfirm && !confirm(m.own ? "Delete this message?" : `Delete this message by ${m.username}?`)) return;
          try {
            await view.remove(m.id);
          } catch (err) {
            onError(errText(err));
          }
        }}
        onDismiss={() => view.dismiss(m.id)}
      />,
    );
    prev = m;
  }
  noticesBefore(null);

  // An image finishing loading makes the list taller; keep following the
  // bottom if we were. (load doesn't bubble, so listen in capture.)
  const onLoad = () => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="messages" ref={ref} onScroll={onScroll} onLoadCapture={onLoad} role="log" aria-live="polite">
      <div className="history-top muted small">
        {snap.loadingOlder ? "Loading older messages…"
          : snap.hasMore ? <button className="link small" onClick={() => void view.loadOlder()}>Load older messages</button>
          : snap.loaded ? (snap.channel.encrypted
            ? "Start of what this device can show. Encrypted channels have no history from before you joined."
            : `This is the start of #${snap.channel.name}.`)
          : null}
      </div>
      {!snap.loaded && <div className="muted small center">Loading…</div>}
      {rows}
      {reporting && (
        <ReportDialog m={reporting} call={call} encrypted={snap.channel.encrypted} onClose={() => setReporting(null)} />
      )}
    </div>
  );
}

/**
 * Report someone's message to the moderators. The server is sent the
 * text as this device shows it: in a plain channel it checks that against
 * its own copy and refuses a mismatch; in an encrypted channel it can't
 * check yet (decisions.md Open items), so moderators see it as unchecked.
 */
function ReportDialog({ m, call, encrypted, onClose }: {
  m: ChatMessage;
  call: ApiCall;
  encrypted: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(`/api/v1/messages/${m.id}/report`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim(), body: m.text }),
      });
      setDone(true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Report message" onClose={onClose}>
      <div className="modal-body">
        {done ? (
          <>
            <p>Reported. The moderators will take a look.</p>
            <div className="modal-actions">
              <button className="primary" onClick={onClose} autoFocus>Done</button>
            </div>
          </>
        ) : (
          <form className="settings-form" onSubmit={send}>
            <blockquote className="quoted small">
              <strong>{m.username}</strong>
              <span className="block">{m.text || <em className="muted">(files only)</em>}</span>
            </blockquote>
            <label>
              Why are you reporting it? <span className="muted small">(optional)</span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} autoFocus />
            </label>
            <p className="muted small">
              Moderators will see this message, who wrote it, your reason and your username.
              {encrypted && " This channel is encrypted, so reporting sends the message's text to the server as your device"
                + " shows it. The server can't check that text yet, so moderators see the report as unchecked."}
            </p>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="primary" disabled={busy}>{busy ? "Reporting…" : "Report"}</button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

function NoticeRow({ n }: { n: Notice }) {
  return (
    <div className={`notice small${n.kind === "membership" ? " membership" : ""}`} role="status">
      <time className="muted" dateTime={n.at}>{formatTime(n.at)}</time> {n.text}
    </div>
  );
}

function formatDay(at: string): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function formatTime(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const UNREADABLE: Record<NonNullable<ChatMessage["unreadable"]>, string> = {
  before_join: "Sent before this device joined, so it can't be read here.",
  other_device: "Sent from another of your devices; not readable here.",
  not_member: "Encrypted. This device hasn't been added to the channel yet.",
  failed: "Couldn't be decrypted.",
};

// ------------------------------------------------------------ message

function Message({ m, call, encrypted, previews, compact, username, canDelete, canEdit, canReport, editing, onEdit, onCancelEdit, onSaveEdit, onDelete, onReport, onDismiss }: {
  m: ChatMessage;
  call: ApiCall;
  encrypted: boolean;
  previews: boolean;
  compact: boolean;
  username: string;
  canDelete: boolean;
  canEdit: boolean;
  canReport: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (text: string) => Promise<void>;
  onDelete: (skipConfirm: boolean) => void;
  onReport: () => void;
  onDismiss: () => void;
}) {
  // No author: the account was deleted (the server sends author_id "" and
  // username "[deleted]"; client-core does the same for the live view).
  const gone = !m.authorId;
  const name = gone ? "Deleted user" : m.username || (m.own ? username : "unknown");
  const classes = ["msg", compact ? "compact" : "", m.pending ? "pending" : "", m.failed ? "failed" : "",
    m.deleted || m.unreadable ? "faint" : ""].filter(Boolean).join(" ");

  let body: ReactNode;
  if (m.deleted) body = <em>Message deleted.</em>;
  else if (m.unreadable) body = <em>{UNREADABLE[m.unreadable]}</em>;
  else if (editing) body = <EditBox initial={m.text} onSave={onSaveEdit} onCancel={onCancelEdit} />;
  else body = m.text ? <Markdown text={m.text} /> : null;
  const link = !m.deleted && !m.unreadable && !m.pending && !editing ? firstLink(m.text) : null;

  return (
    <article className={classes} data-id={m.id} aria-label={`${name} at ${formatTime(m.createdAt)}`}>
      {compact
        ? <time className="side-time small" dateTime={m.createdAt}>{formatTime(m.createdAt)}</time>
        : (
          <header>
            <strong className={m.own ? "own" : gone ? "muted" : undefined}>{name}</strong>
            <time className="muted small" dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
              {formatTime(m.createdAt)}
            </time>
          </header>
        )}
      <div className="body">
        {body}
        {!editing && !m.deleted && !m.unreadable && m.editedAt && (
          <span className="muted small edited" title={new Date(m.editedAt).toLocaleString()}>
            {m.staleEdit ? " (edited; the newest version can't be read here)" : " (edited)"}
          </span>
        )}
      </div>
      {!m.deleted && m.attachments.length > 0 && <Attachments m={m} encrypted={encrypted} />}
      {link && <LinkPreview call={call} url={link} fetch={previews} />}
      {m.sharedBy && !m.deleted && (
        <div className="muted small">
          Shared by {m.sharedBy.verified ? (m.sharedBy.username ?? "a member") : "an unverified member"}
        </div>
      )}
      {m.failed && (
        <div className="error small">
          Not sent: {m.failed}. <button className="link small" onClick={onDismiss}>Dismiss</button>
        </div>
      )}
      {!editing && (canEdit || canDelete || canReport) && (
        <div className="actions">
          {canEdit && <button onClick={onEdit} title="Edit">Edit</button>}
          {canReport && <button onClick={onReport} title="Report to the moderators">Report</button>}
          {canDelete && (
            <button className="danger" onClick={(e) => onDelete(e.shiftKey)} title="Delete (Shift-click skips the question)">
              Delete
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * A message's files. What the server stores as-is (anything in a plain
 * channel, and provider GIFs in any channel) shows from its signed URL;
 * files encrypted by their sender are decrypted here (attachments.tsx).
 */
function Attachments({ m, encrypted }: { m: ChatMessage; encrypted: boolean }) {
  const keys = new Map(m.files.map((f) => [f.id, f]));
  return (
    <div className="attachments">
      {m.attachments.map((a) => {
        const sealed = encrypted && (keys.has(a.id) ||
          (a.filename === "encrypted" && a.content_type === "application/octet-stream"));
        return sealed
          ? <SealedAttachment key={a.id} a={a} k={keys.get(a.id)} />
          : <PlainAttachment key={a.id} a={a} />;
      })}
    </div>
  );
}

function EditBox({ initial, onSave, onCancel }: {
  initial: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  async function save() {
    if (busy) return;
    if (!text.trim()) return;
    setBusy(true);
    await onSave(text);
    setBusy(false);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  }

  return (
    <div className="edit-box">
      <AutoTextarea ref={ref} value={text} onChange={setText} onKeyDown={onKey} disabled={busy} label="Edit message" />
      <span className="muted small">
        Esc to <button className="link small" onClick={onCancel}>cancel</button> · Enter to{" "}
        <button className="link small" onClick={() => void save()}>save</button>
      </span>
    </div>
  );
}

// ----------------------------------------------------------- composer

/** Why nothing can be sent or attached right now, or null. */
function composeBlocker(snap: ChannelSnapshot): string | null {
  return !snap.canPost ? "You can't post in this channel."
    : snap.connection !== "open" ? "Connecting…"
    : snap.channel.encrypted && snap.crypto.kind !== "ready" ? "Waiting for encryption…"
    : null;
}

function Composer({ snap, call, uploads, onSend, onEditLast }: {
  snap: ChannelSnapshot;
  call: ApiCall;
  uploads: ReturnType<typeof useUploads>;
  onSend: (text: string, attachments?: (AttachmentInfo | Upload)[]) => Promise<boolean>;
  onEditLast: () => void;
}) {
  const [text, setText] = useState("");
  const [gifs, setGifs] = useState(false);
  const gifsEnabled = useGifsEnabled(call);
  const closeGifs = useCallback(() => setGifs(false), []);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const reason = composeBlocker(snap);
  const files = uploads.items;
  const uploading = files.some((f) => f.status === "uploading");
  const ready = files.flatMap((f) => (f.status === "ready" && f.result ? [f.result] : []));
  const canSend = !reason && !uploading && (!!text.trim() || ready.length > 0);

  // Focus follows the channel.
  useEffect(() => {
    ref.current?.focus();
  }, [snap.channel.id]);

  async function send() {
    if (!canSend) return;
    const value = text;
    setText("");
    // A failed upload in the tray is left out; the user sees it marked.
    if (await onSend(value, ready)) uploads.clear();
    else setText(value);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "ArrowUp" && !text) {
      e.preventDefault();
      onEditLast();
    }
  }

  return (
    <div className="composer-wrap">
    <UploadTray items={files} onRemove={uploads.remove} />
    <div className="composer">
      {gifs && !reason && (
        <GifPicker call={call} channelId={snap.channel.id} onClose={closeGifs}
          onPick={async (a) => {
            // Sent on its own straight away, like other chat apps; whatever
            // is typed stays in the box.
            if (!(await onSend("", [a]))) throw new Error("Couldn't send the GIF.");
            ref.current?.focus();
          }} />
      )}
      <input ref={picker} type="file" multiple hidden onChange={(e) => {
        if (e.target.files) uploads.add(e.target.files);
        e.target.value = ""; // so picking the same file again still fires
        ref.current?.focus();
      }} />
      <button className="secondary attach-btn" disabled={!!reason}
        onClick={() => picker.current?.click()} title="Attach files" aria-label="Attach files">+</button>
      <AutoTextarea
        ref={ref}
        value={text}
        onChange={setText}
        onKeyDown={onKey}
        onPaste={(e) => {
          // A pasted screenshot or copied file. Text pastes as usual.
          if (reason || !e.clipboardData.files.length) return;
          e.preventDefault();
          uploads.add(e.clipboardData.files);
        }}
        disabled={!!reason}
        placeholder={reason ?? `Message #${snap.channel.name}`}
        label={`Message #${snap.channel.name}`}
      />
      {gifsEnabled && (
        <button className={`secondary gif-btn${gifs ? " on" : ""}`} disabled={!!reason}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setGifs((g) => !g)} title="Send a GIF" aria-expanded={gifs}>GIF</button>
      )}
      <button className="primary" onClick={() => void send()} disabled={!canSend}
        title={uploading ? "Waiting for uploads to finish" : undefined}>Send</button>
    </div>
    </div>
  );
}

/** A textarea that grows with its content, up to a limit (CSS). */
function AutoTextarea({ ref, value, onChange, onKeyDown, onPaste, disabled, placeholder, label }: {
  ref: React.Ref<HTMLTextAreaElement>;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  disabled?: boolean;
  placeholder?: string;
  label: string;
}) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as React.RefObject<HTMLTextAreaElement | null>).current = el;
      }}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
    />
  );
}
