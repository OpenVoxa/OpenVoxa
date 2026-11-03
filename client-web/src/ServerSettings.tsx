// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server settings (build order 13, M5 session B): permission groups and
 * who is in them. Opened from the gear beside the server name, which only
 * staff (anyone holding a permission switch) see. Session C adds
 * moderation tabs here.
 *
 * The server enforces every rule; this dialog only mirrors them so that
 * controls you could not use are disabled with a reason instead of
 * failing on save. The rules (server/internal/httpapi/groups.go):
 *
 *   - Changing anything needs manage_groups.
 *   - You can only change groups ranked strictly below you, and only give
 *     them a rank below yours.
 *   - You can only grant (or take away) switches you hold yourself.
 *   - You can only change the groups of people ranked below you, never
 *     your own. You may put them in a group at your own rank.
 *   - The server refuses anything that would leave it without an
 *     administrator; that refusal is shown as the server words it.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { ApiCall } from "@core/identity";
import { Modal } from "./ChannelDialogs";

/** What the dialog needs to know about the signed-in account. */
export interface Me {
  userId: string;
  /** Expanded by the server: an administrator gets every switch. */
  permissions: readonly string[];
  rank: number;
}

interface PermGroup {
  id: string;
  name: string;
  position: number;
  permissions: string[];
  is_everyone: boolean;
  auto_assign: boolean;
  members: number;
}

interface UserSummary {
  id: string;
  username: string;
  rank: number;
  groups: { id: string; name: string }[];
  created_at: string;
}

/** Every switch, in the server's display order (perm.All). */
const SWITCHES: { id: string; label: string; help: string }[] = [
  { id: "administrator", label: "Administrator", help: "Every switch below, and sees every channel." },
  { id: "manage_groups", label: "Manage groups", help: "Create and edit groups below their rank, and put people below them in and out of groups." },
  { id: "manage_channels", label: "Manage channels", help: "Create and delete channels, and set who can use them and how long messages are kept." },
  { id: "delete_messages", label: "Delete messages", help: "Remove other people's messages." },
  { id: "view_reports", label: "View reports", help: "Read and resolve reported messages." },
  { id: "ban", label: "Ban", help: "Ban and unban people below their rank." },
  { id: "force_ptt", label: "Force push-to-talk", help: "Require push-to-talk in a voice channel." },
];
const switchLabel = (id: string) => SWITCHES.find((s) => s.id === id)?.label ?? id;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const byRank = (a: PermGroup, b: PermGroup) => b.position - a.position || a.name.localeCompare(b.name);

function useGroupList(call: ApiCall, reload: number) {
  const [groups, setGroups] = useState<PermGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    (call("/api/v1/groups") as Promise<PermGroup[]>)
      .then((g) => {
        if (!live) return;
        setGroups([...g].sort(byRank));
        setError(null);
      })
      .catch((err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [call, reload, tick]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { groups, error, refresh };
}

export type ServerTab = "groups" | "members";

/**
 * reload changes whenever the server says permissions moved, so the lists
 * follow changes made elsewhere (another admin, the CLI).
 */
export function ServerSettingsDialog({ call, me, reload, onClose }: {
  call: ApiCall;
  me: Me;
  reload: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ServerTab>("groups");
  const tabs: [ServerTab, string][] = [["groups", "Groups"], ["members", "Members"]];
  return (
    <Modal title="Server settings" onClose={onClose} wide>
      <div className="settings-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : undefined}
            onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="modal-body">
        {tab === "groups" && <GroupsTab call={call} me={me} reload={reload} />}
        {tab === "members" && <MembersTab call={call} me={me} reload={reload} />}
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- groups

function GroupsTab({ call, me, reload }: { call: ApiCall; me: Me; reload: number }) {
  const { groups, error, refresh } = useGroupList(call, reload);
  // null: the list; "new": creating; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const canManage = me.permissions.includes("manage_groups");

  if (error) return <p className="error" role="alert">Couldn't load groups: {error}</p>;
  if (!groups) return <p className="muted">Loading…</p>;

  // A group deleted meanwhile (elsewhere) falls back to the list.
  const target = editing === "new" ? null : groups.find((g) => g.id === editing);
  if (editing === "new" || target) {
    return (
      <GroupEditor key={editing} call={call} me={me} group={target ?? null} groups={groups}
        onDone={() => {
          setEditing(null);
          refresh();
        }}
        onCancel={() => setEditing(null)} />
    );
  }

  return (
    <section className="settings-section">
      <p className="muted small">
        People get every switch of every group they're in. Rank decides <em>who</em> a switch works on: you can
        only act on people and groups ranked below you. Your rank is {me.rank}, from your highest group.
        Which channels a group can use is set on each channel.
      </p>
      <ul className="device-list">
        {groups.map((g) => {
          const lock = editLock(me, g);
          return (
            <li key={g.id}>
              <span className="device-name">
                <strong>{g.name}</strong>
                <span className="tag small" title="Rank">{g.position}</span>
                {g.auto_assign && <span className="tag small" title="New accounts join this group">New accounts</span>}
                <span className="muted small block">
                  {g.is_everyone ? "Everyone, always" : `${g.members} member${g.members === 1 ? "" : "s"}`}
                  {" · "}
                  {g.permissions.length ? g.permissions.map(switchLabel).join(", ") : "no switches"}
                </span>
              </span>
              {canManage && (lock
                ? <span className="muted small" title={lock}>Locked</span>
                : <button className="secondary" onClick={() => setEditing(g.id)}>Edit</button>)}
            </li>
          );
        })}
      </ul>
      {canManage ? (
        <div className="row-actions">
          <button className="secondary" onClick={() => setEditing("new")} disabled={me.rank <= 1}>New group</button>
        </div>
      ) : (
        <p className="muted small">You need the Manage groups switch to change groups.</p>
      )}
    </section>
  );
}

/** Why a group can't be opened for editing at all, or null if it can. */
function editLock(me: Me, g: PermGroup): string | null {
  if (g.position >= me.rank) return "Ranked at or above you";
  return null;
}

function GroupEditor({ call, me, group, groups, onDone, onCancel }: {
  call: ApiCall;
  me: Me;
  group: PermGroup | null;
  groups: PermGroup[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const everyone = group?.is_everyone ?? false;
  const [name, setName] = useState(group?.name ?? "");
  const [rank, setRank] = useState(group ? String(group.position) : "");
  const [perms, setPerms] = useState<string[]>(group?.permissions ?? []);
  const [autoAssign, setAutoAssign] = useState(group?.auto_assign ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const holds = (p: string) => me.permissions.includes(p);
  // The server refuses any switch change on a group carrying a switch you
  // lack, even to switches you do hold.
  const foreign = (group?.permissions ?? []).filter((p) => !holds(p));
  const switchesLocked = foreign.length > 0;

  const rankN = Number(rank);
  const rankValid = everyone || (/^\d+$/.test(rank) && rankN >= 1 && rankN < me.rank);
  const nameTrim = name.trim();
  const nameValid = everyone || (nameTrim.length >= 1 && nameTrim.length <= 32);

  // "between Member (10) and VIP (15)", from the other groups.
  const neighbours = useMemo(() => {
    if (!rankValid || everyone) return null;
    const others = groups.filter((g) => g.id !== group?.id);
    const below = others.filter((g) => g.position < rankN).sort(byRank)[0];
    const above = [...others.filter((g) => g.position > rankN)].sort((a, b) => a.position - b.position)[0];
    const same = others.filter((g) => g.position === rankN);
    if (same.length) return `Same rank as ${same.map((g) => g.name).join(", ")}: neither outranks the other.`;
    const fmt = (g: PermGroup) => `${g.name} (${g.position})`;
    if (below && above) return `Between ${fmt(below)} and ${fmt(above)}.`;
    if (above) return `Below ${fmt(above)}.`;
    if (below) return `Above ${fmt(below)}.`;
    return null;
  }, [rankValid, everyone, groups, group, rankN]);

  function toggle(p: string, on: boolean) {
    setPerms((cur) => (on ? [...cur, p] : cur.filter((x) => x !== p)));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!rankValid || !nameValid) return;
    // Send only what changed: the server checks each field present, and
    // an untouched switch list on a group with switches you lack must not
    // be sent at all.
    const body: Record<string, unknown> = {};
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    if (!group) {
      Object.assign(body, { name: nameTrim, position: rankN, permissions: perms, auto_assign: autoAssign });
    } else {
      if (!everyone && nameTrim !== group.name) body.name = nameTrim;
      if (!everyone && rankN !== group.position) body.position = rankN;
      if (!everyone && autoAssign !== group.auto_assign) body.auto_assign = autoAssign;
      if (!sameSet(perms, group.permissions)) body.permissions = perms;
      if (!Object.keys(body).length) return onCancel();
    }
    setBusy(true);
    setError(null);
    try {
      await call(group ? `/api/v1/groups/${group.id}` : "/api/v1/groups", {
        method: group ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!group) return;
    setBusy(true);
    setError(null);
    try {
      await call(`/api/v1/groups/${group.id}`, { method: "DELETE" });
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={save}>
      <h3 className="settings-head">{group ? `Edit ${group.name}` : "New group"}</h3>
      {everyone ? (
        <p className="muted small">
          Everyone is the group every account is always in, at rank 0. Only its switches can change, and a switch
          here goes to every account, including new ones.
        </p>
      ) : (
        <>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} autoFocus={!group} required />
          </label>
          <label>
            Rank
            <input value={rank} onChange={(e) => setRank(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric" placeholder={`1 to ${me.rank - 1}`} required />
            <span className="muted small block">
              {neighbours ?? ""} You can use 1 to {me.rank - 1} (below your own {me.rank}).
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} />
            <span>
              New accounts join this group
              <span className="muted small block">Only affects accounts created from now on.</span>
            </span>
          </label>
        </>
      )}

      <fieldset className="access">
        <legend>Switches</legend>
        {SWITCHES.map((s) => {
          const implied = s.id !== "administrator" && perms.includes("administrator");
          const disabled = switchesLocked || !holds(s.id) || implied;
          return (
            <label key={s.id} className="check" title={!holds(s.id) ? "You don't hold this switch" : undefined}>
              <input type="checkbox" checked={perms.includes(s.id) || implied} disabled={disabled}
                onChange={(e) => toggle(s.id, e.target.checked)} />
              <span>
                {s.label}
                <span className="muted small block">{s.help}</span>
              </span>
            </label>
          );
        })}
        {switchesLocked && (
          <p className="muted small">
            This group has {foreign.map(switchLabel).join(", ")}, which you don't hold, so you can't change its
            switches.
          </p>
        )}
      </fieldset>

      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !rankValid || !nameValid}>
          {busy ? "Saving…" : group ? "Save" : "Create group"}
        </button>
      </div>

      {group && !everyone && (
        <div className="danger-zone">
          {!confirmDelete ? (
            <button type="button" className="danger" onClick={() => setConfirmDelete(true)}
              disabled={busy || switchesLocked}>Delete group</button>
          ) : (
            <>
              <p className="small">
                Delete <strong>{group.name}</strong>? Its {group.members} member{group.members === 1 ? "" : "s"} lose
                its switches and any channels only it gave them. This can't be undone.
              </p>
              <div className="row-actions">
                <button type="button" className="secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>Keep it</button>
                <button type="button" className="danger solid" onClick={() => void remove()} disabled={busy}>
                  {busy ? "Deleting…" : "Delete"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </form>
  );
}

// --------------------------------------------------------------- members

function MembersTab({ call, me, reload }: { call: ApiCall; me: Me; reload: number }) {
  const { groups, error: groupsError, refresh: refreshGroups } = useGroupList(call, reload);
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);
  const canManage = me.permissions.includes("manage_groups");

  useEffect(() => {
    let live = true;
    (call("/api/v1/users") as Promise<UserSummary[]>)
      .then((u) => {
        if (!live) return;
        setUsers(u);
        setError(null);
      })
      .catch((err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [call, reload, tick]);

  // Groups you could put someone in or take them out of.
  const assignable = useMemo(
    () => (groups ?? []).filter((g) => !g.is_everyone && g.position <= me.rank
      && g.permissions.every((p) => me.permissions.includes(p))),
    [groups, me],
  );

  async function setMembership(u: UserSummary, g: PermGroup, on: boolean) {
    setBusy(`${u.id}:${g.id}`);
    setRowError(null);
    try {
      await call(`/api/v1/users/${u.id}/groups/${g.id}`, { method: on ? "PUT" : "DELETE" });
    } catch (err) {
      setRowError({ id: u.id, msg: errText(err) });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
      refreshGroups();
    }
  }

  if (error) return <p className="error" role="alert">Couldn't load members: {error}</p>;
  if (groupsError) return <p className="error" role="alert">Couldn't load groups: {groupsError}</p>;
  if (!users || !groups) return <p className="muted">Loading…</p>;

  const q = filter.trim().toLowerCase();
  const shown = q ? users.filter((u) => u.username.toLowerCase().includes(q)) : users;

  return (
    <section className="settings-section">
      <label>
        Find
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Username" type="search" />
      </label>
      <p className="muted small">
        {users.length} account{users.length === 1 ? "" : "s"}. Everyone is in Everyone, so it isn't listed.
        {canManage ? " You can change the groups of people ranked below you." : ""}
      </p>
      <ul className="device-list">
        {shown.map((u) => {
          const self = u.id === me.userId;
          const lock = self ? "You can't change your own groups." : u.rank >= me.rank ? "Ranked at or above you." : null;
          const isOpen = open === u.id;
          return (
            <li key={u.id} className={isOpen ? "member open" : "member"}>
              <div className="member-row">
                <span className="device-name">
                  <strong>{u.username}</strong>
                  {self && <span className="tag small">You</span>}
                  <span className="muted small block">
                    {u.groups.length ? u.groups.map((g) => g.name).join(", ") : "No groups"} · rank {u.rank}
                    {" · joined "}{new Date(u.created_at).toLocaleDateString()}
                  </span>
                </span>
                {canManage && (lock
                  ? <span className="muted small" title={lock}>Locked</span>
                  : (
                    <button className="secondary" onClick={() => setOpen(isOpen ? null : u.id)} aria-expanded={isOpen}>
                      {isOpen ? "Close" : "Groups"}
                    </button>
                  ))}
              </div>
              {isOpen && !lock && (
                <div className="member-groups">
                  {assignable.map((g) => {
                    const on = u.groups.some((x) => x.id === g.id);
                    return (
                      <label key={g.id} className="check">
                        <input type="checkbox" checked={on} disabled={busy !== null}
                          onChange={(e) => void setMembership(u, g, e.target.checked)} />
                        <span>
                          {g.name} <span className="muted small">rank {g.position}</span>
                          {busy === `${u.id}:${g.id}` && <span className="muted small"> · saving…</span>}
                        </span>
                      </label>
                    );
                  })}
                  {!assignable.length && <p className="muted small">There are no groups you can hand out.</p>}
                  {groups.some((g) => !g.is_everyone && !assignable.includes(g)) && (
                    <p className="muted small">
                      Groups above your rank, or with switches you don't hold, aren't listed.
                    </p>
                  )}
                  {rowError?.id === u.id && <p className="error" role="alert">{rowError.msg}</p>}
                </div>
              )}
            </li>
          );
        })}
        {!shown.length && <li className="muted small">Nobody matches.</li>}
      </ul>
    </section>
  );
}
