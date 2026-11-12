// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Creating, configuring and deleting channels (needs manage_channels;
 * force push-to-talk needs force_ptt). The server already had every
 * endpoint; the debug page reached them through console helpers.
 *
 * What can change after creation: the name, who may view and post (the
 * allow-list), how long messages are kept, history sharing (encrypted
 * text channels) and forced push-to-talk (voice). Whether a text channel
 * is encrypted is fixed at creation: turning it on or off later would
 * strand either the history or the promise made to the people who wrote
 * it. Renaming is safe: everything is keyed by the channel's id.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ApiCall } from "@core/identity";
import type { ChannelAccess, ChannelCategory, ChannelInfo } from "@core/chat";

/** A permission group as GET /api/v1/groups lists it. */
export interface PermGroup {
  id: string;
  name: string;
  position: number;
  is_everyone: boolean;
  auto_assign: boolean;
}

/** One row of the permissions editor. */
export interface AccessRow {
  id: string;
  name: string;
  view: boolean;
  post: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -------------------------------------------------------------- modal

export function Modal({ title, onClose, children, wide, fixed }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Room for lists (Settings, Server settings). */
  wide?: boolean;
  /**
   * One height whatever the content, so tabs don't jump about: the
   * .modal-body child scrolls and a .modal-foot child stays at the bottom.
   */
  fixed?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}${fixed ? " fixed" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

// ----------------------------------------------------- shared editors

export function useGroups(call: ApiCall): { groups: PermGroup[] | null; error: string | null } {
  const [groups, setGroups] = useState<PermGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (call("/api/v1/groups") as Promise<PermGroup[]>)
      .then((g) => live && setGroups([...g].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))))
      .catch((err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [call]);
  return { groups, error };
}

/** Every group as a row, ticked as `access` says. */
export function rowsFrom(groups: readonly PermGroup[], access: readonly ChannelAccess[]): AccessRow[] {
  const on = new Map(access.map((a) => [a.group_id, a.can_post]));
  return groups.map((g) => ({ id: g.id, name: g.name, view: on.has(g.id), post: on.get(g.id) ?? false }));
}

/** The server's default for new channels: Everyone may view, groups new
 * accounts join may post. */
export function defaultRows(groups: readonly PermGroup[]): AccessRow[] {
  return groups.map((g) => ({
    id: g.id, name: g.name, view: g.is_everyone || g.auto_assign, post: g.auto_assign,
  }));
}

/** Permissions as one comparable string (order doesn't matter). */
export function accessKey(access: readonly { group_id: string; can_post: boolean }[]): string {
  return access.map((a) => `${a.group_id}:${a.can_post}`).sort().join(",");
}

export function AccessEditor({ rows, setRows, kind, disabled, legend = "Who can use it", note }: {
  rows: AccessRow[];
  setRows: (r: AccessRow[]) => void;
  kind: "text" | "voice";
  /** Shown greyed out (Same as category: edit the category instead). */
  disabled?: boolean;
  legend?: string;
  note?: ReactNode;
}) {
  const set = (id: string, change: Partial<AccessRow>) =>
    setRows(rows.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, ...change };
      // Posting needs viewing; taking away viewing takes posting too.
      if (change.post) next.view = true;
      if (change.view === false) next.post = false;
      return next;
    }));
  return (
    <fieldset className="access" disabled={disabled}>
      <legend>{legend}</legend>
      <table>
        <thead>
          <tr><th>Group</th><th>{kind === "voice" ? "Join" : "View"}</th><th>{kind === "voice" ? "Speak" : "Post"}</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td><input type="checkbox" checked={r.view} onChange={(e) => set(r.id, { view: e.target.checked })}
                aria-label={`${r.name} may ${kind === "voice" ? "join" : "view"}`} /></td>
              <td><input type="checkbox" checked={r.post} onChange={(e) => set(r.id, { post: e.target.checked })}
                aria-label={`${r.name} may ${kind === "voice" ? "speak" : "post"}`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        {note ?? <>
          Administrators can always see and use every channel.
          {!rows.some((r) => r.view) && " With nothing ticked, only administrators can."}
        </>}
      </p>
    </fieldset>
  );
}

export function accessBody(rows: AccessRow[]) {
  return rows.filter((r) => r.view).map((r) => ({ group_id: r.id, can_post: r.post }));
}

const RETENTION_CHOICES: { label: string; value: string; seconds: number | null }[] = [
  { label: "Forever", value: "", seconds: null },
  { label: "1 day", value: "1 day", seconds: 86400 },
  { label: "7 days", value: "7 days", seconds: 7 * 86400 },
  { label: "30 days", value: "30 days", seconds: 30 * 86400 },
  { label: "90 days", value: "90 days", seconds: 90 * 86400 },
  { label: "1 year", value: "365 days", seconds: 365 * 86400 },
];

/** The server reports retention as a Go duration ("720h0m0s") or "forever". */
export function retentionSeconds(r: string): number | null {
  if (r === "forever") return null;
  const m = r.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
}

/** "kept forever", "kept 30 days", "kept 12 hours". */
export function describeRetention(r: string): string {
  const s = retentionSeconds(r);
  if (s === null) return r === "forever" ? "forever" : r;
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  return `${Math.round(s / 60)} minutes`;
}

// ------------------------------------------------------------- create

/**
 * Same as category / Custom, above a channel's permissions. Same as
 * category is greyed out for a channel outside any category.
 */
function FollowPick({ category, follow, setFollow }: {
  category: ChannelCategory | undefined;
  follow: boolean;
  setFollow: (on: boolean) => void;
}) {
  return (
    <div className="follow-pick" role="radiogroup" aria-label="Permissions">
      <span>Permissions</span>
      <label className={`check${category ? "" : " disabled"}`} title={category ? undefined : "It isn't in a category"}>
        <input type="radio" name="follow" checked={follow} disabled={!category} onChange={() => setFollow(true)} />
        <span>
          Same as category{category ? ` (${category.name})` : ""}
          <span className="muted small block">Changes when the category's permissions change.</span>
        </span>
      </label>
      <label className="check">
        <input type="radio" name="follow" checked={!follow} onChange={() => setFollow(false)} />
        <span>
          Custom
          <span className="muted small block">Its own permissions, set here.</span>
        </span>
      </label>
    </div>
  );
}

export function CreateChannelDialog({ call, kind: initialKind, categories, categoryId, onClose, onCreated }: {
  call: ApiCall;
  kind: "text" | "voice";
  /** Sidebar categories; the dialog offers those of the chosen type. */
  categories: readonly ChannelCategory[];
  /** Opened from a category: start in it. */
  categoryId?: string;
  onClose: () => void;
  onCreated: (c: ChannelInfo) => void;
}) {
  const { groups, error: groupsError } = useGroups(call);
  const [kind, setKind] = useState(initialKind);
  const [category, setCategory] = useState(categoryId ?? "");
  const kindCategories = categories.filter((c) => c.kind === kind);
  const [name, setName] = useState("");
  const [encrypted, setEncrypted] = useState(true);
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  // In a category, a new channel uses its permissions unless set to Custom.
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cat = kindCategories.find((c) => c.id === category);
  const following = !!cat && follow;

  // Custom starts from the server default (Everyone may view, groups new
  // accounts join may post), or from the category's when in one.
  useEffect(() => {
    if (groups && !rows) setRows(defaultRows(groups));
  }, [groups, rows]);
  const catRows = groups && cat?.access ? rowsFrom(groups, cat.access) : null;
  const pickFollow = (on: boolean) => {
    if (!on && follow && catRows) setRows(catRows);
    setFollow(on);
  };

  const valid = /^[a-z0-9-]{1,32}$/.test(name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || !rows) return;
    setBusy(true);
    setError(null);
    try {
      const c = (await call("/api/v1/channels", {
        method: "POST",
        body: JSON.stringify({
          name,
          kind,
          // Voice is always end-to-end encrypted; the flag is for text.
          encrypted: kind === "text" ? encrypted : false,
          access: accessBody(rows),
          category_id: cat ? cat.id : null,
          follow_category: following,
        }),
      })) as ChannelInfo;
      onCreated(c);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Create channel" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <div className="kind-pick" role="radiogroup" aria-label="Channel type">
          {(["text", "voice"] as const).map((k) => (
            <label key={k} className={kind === k ? "on" : undefined}>
              <input type="radio" name="kind" checked={kind === k} onChange={() => {
                setKind(k);
                // Categories belong to one section.
                if (k !== kind) setCategory("");
              }} />
              <strong>{k === "text" ? "Text" : "Voice"}</strong>
              <span className="muted small">{k === "text" ? "Messages and files" : "Talk and share your screen"}</span>
            </label>
          ))}
        </div>
        <label>
          Name
          <input
            value={name}
            // Channel names are lowercase with hyphens; typing a space
            // makes a hyphen, as people expect.
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""))}
            maxLength={32}
            placeholder={kind === "text" ? "new-channel" : "lounge"}
            autoFocus
            required
          />
        </label>
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={!kindCategories.length}
            title={kindCategories.length ? undefined : `No ${kind} categories yet`}>
            <option value="">None</option>
            {kindCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {kind === "text" ? (
          <label className="check">
            <input type="checkbox" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} />
            <span>
              End-to-end encrypted
              <span className="muted small block">
                The server can't read messages. New members don't see anything from before they
                joined unless history sharing is on. Can't be changed later.
              </span>
            </span>
          </label>
        ) : (
          <p className="muted small">Voice and screen sharing are always end-to-end encrypted.</p>
        )}
        {groupsError && <p className="error">Couldn't load groups: {groupsError}</p>}
        <FollowPick category={cat} follow={following} setFollow={pickFollow} />
        {following
          ? catRows && <AccessEditor rows={catRows} setRows={() => {}} kind={kind} disabled
            note={<>The category's permissions. Change them with Edit Category.</>} />
          : rows && <AccessEditor rows={rows} setRows={setRows} kind={kind} />}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !valid || !rows}>
            {busy ? "Creating…" : "Create channel"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------- settings

export function ChannelSettingsDialog({ call, channel, categories, canManage, canForcePTT, focus, onClose, onDeleted }: {
  call: ApiCall;
  channel: ChannelInfo;
  /** For Same as category: the channel's category and its permissions. */
  categories: readonly ChannelCategory[];
  /** Opened from the channel menu: put the cursor in the name, or go straight to the delete confirmation. */
  focus?: "name" | "delete";
  canManage: boolean;
  canForcePTT: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { groups, error: groupsError } = useGroups(call);
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const currentSeconds = retentionSeconds(channel.retention);
  const preset = RETENTION_CHOICES.find((r) => r.seconds === currentSeconds);
  const [retention, setRetention] = useState(preset ? preset.value : "custom");
  const [customRetention, setCustomRetention] = useState(preset ? "" : describeRetention(channel.retention));
  const [sharing, setSharing] = useState(channel.history_sharing);
  const [forcePTT, setForcePTT] = useState(channel.force_ptt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(focus === "delete" && canManage);
  const [name, setName] = useState(channel.name);

  const voice = channel.kind === "voice";
  const cat = categories.find((c) => c.id === channel.category_id);
  const wasFollowing = !!cat && !!channel.follows_category;
  const [follow, setFollow] = useState(wasFollowing);

  useEffect(() => {
    if (groups && !rows) setRows(rowsFrom(groups, channel.access));
  }, [groups, rows, channel.access]);
  const catRows = groups && cat?.access ? rowsFrom(groups, cat.access) : null;
  // Custom starts as a copy of what it has now (the category's, if it
  // was following them).
  const pickFollow = (on: boolean) => {
    if (!on && follow && catRows) setRows(catRows);
    setFollow(on);
  };

  const accessChanged = follow !== wasFollowing ||
    (!follow && !!rows && accessKey(accessBody(rows)) !== accessKey(channel.access));
  const retentionValue = retention === "custom" ? customRetention.trim() : retention;
  const retentionChanged = retention === "custom"
    ? customRetention.trim() !== "" && customRetention.trim() !== describeRetention(channel.retention)
    : retention !== (preset?.value ?? null);
  const sharingChanged = sharing !== channel.history_sharing;
  const pttChanged = forcePTT !== channel.force_ptt;
  const newName = name.trim().toLowerCase();
  const nameChanged = newName !== channel.name;
  const nameValid = /^[a-z0-9-]{1,32}$/.test(newName);
  const dirty = accessChanged || retentionChanged || sharingChanged || pttChanged || nameChanged;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const base = `/api/v1/channels/${channel.id}`;
    try {
      // One call per setting, each its own server endpoint. Stops at the
      // first refusal so the message names what failed. The name goes
      // first: a name already taken is the likeliest refusal.
      if (canManage && nameChanged) {
        await call(`${base}/name`, { method: "PATCH", body: JSON.stringify({ name: newName }) });
      }
      if (canManage && accessChanged && rows) {
        await call(`${base}/access`, {
          method: "PUT",
          body: JSON.stringify(follow ? { follow_category: true } : { access: accessBody(rows), follow_category: false }),
        });
      }
      if (canManage && retentionChanged) {
        await call(`${base}/retention`, { method: "PATCH", body: JSON.stringify({ retention: retentionValue }) });
      }
      if (canManage && sharingChanged) {
        await call(`${base}/history-sharing`, { method: "PATCH", body: JSON.stringify({ enabled: sharing }) });
      }
      if (canForcePTT && pttChanged) {
        await call(`${base}/force-ptt`, { method: "PATCH", body: JSON.stringify({ force_ptt: forcePTT }) });
      }
      onClose();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/v1/channels/${channel.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`${voice ? "" : "#"}${channel.name} settings`} onClose={onClose}>
      <form className="modal-body" onSubmit={save}>
        <p className="muted small">
          {voice ? "Voice channel, always end-to-end encrypted."
            : channel.encrypted ? "Text channel, end-to-end encrypted." : "Text channel, not encrypted."}
          {voice ? "" : " Encryption is fixed when a channel is created."}
        </p>

        {canManage && (
          <>
            <label>
              Name
              <input value={name} maxLength={32} autoFocus={focus === "name"}
                onFocus={(e) => focus === "name" && e.currentTarget.select()}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""))} />
            </label>
            {nameChanged && !nameValid && <p className="error small">A name needs at least one character.</p>}
            {groupsError && <p className="error">Couldn't load groups: {groupsError}</p>}
            <FollowPick category={cat} follow={follow} setFollow={pickFollow} />
            {follow
              ? catRows && <AccessEditor rows={catRows} setRows={() => {}} kind={voice ? "voice" : "text"} disabled
                note={<>The category's permissions. Change them with Edit Category.</>} />
              : rows && <AccessEditor rows={rows} setRows={setRows} kind={voice ? "voice" : "text"} />}

            {!voice && (
              <label>
                Keep messages
                <select value={retention} onChange={(e) => setRetention(e.target.value)}>
                  {RETENTION_CHOICES.map((r) => <option key={r.label} value={r.value}>{r.label}</option>)}
                  <option value="custom">Other…</option>
                </select>
              </label>
            )}
            {!voice && retention === "custom" && (
              <label>
                Custom period
                <input value={customRetention} onChange={(e) => setCustomRetention(e.target.value)}
                  placeholder="e.g. 14 days or 12 hours" />
              </label>
            )}
            {!voice && retentionChanged && retention !== "" && (
              <p className="muted small">Messages older than this are deleted for everyone, including ones already sent.</p>
            )}

            {!voice && channel.encrypted && (
              <label className="check">
                <input type="checkbox" checked={sharing} onChange={(e) => setSharing(e.target.checked)} />
                <span>
                  Share history with new members
                  <span className="muted small block">
                    Members' apps send newcomers the messages they hold, marked "shared by". Off: newcomers
                    see nothing from before they joined.
                  </span>
                </span>
              </label>
            )}
          </>
        )}

        {voice && canForcePTT && (
          <label className="check">
            <input type="checkbox" checked={forcePTT} onChange={(e) => setForcePTT(e.target.checked)} />
            <span>
              Require push-to-talk
              <span className="muted small block">Nobody can use an open microphone in this channel.</span>
            </span>
          </label>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !dirty || (nameChanged && !nameValid)}>{busy ? "Saving…" : "Save"}</button>
        </div>

        {canManage && (
          <div className="danger-zone">
            {!confirmDelete ? (
              <button type="button" className="danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
                Delete channel
              </button>
            ) : (
              <>
                <p className="small">
                  Delete <strong>{channel.name}</strong>{voice ? "" : " and every message in it"}? This can't be undone.
                </p>
                <div className="modal-actions">
                  <button type="button" className="secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>Keep it</button>
                  <button type="button" className="danger solid" onClick={() => void remove()} disabled={busy}>
                    {busy ? "Deleting…" : "Delete for everyone"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
