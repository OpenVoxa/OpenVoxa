// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server settings (build order 13, M5 sessions B and C): permission groups
 * and who is in them, then moderation: reports, bans, deleting accounts
 * and the moderation log. Opened from the gear beside the server name,
 * which only staff (anyone holding a permission switch) see. Each
 * moderation tab shows only to holders of the switch it needs.
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
 *   - Ban works on people ranked below you; unban on anyone. Purging a
 *     banned person's messages, and deleting an account, need
 *     administrator (deletion also only below your rank).
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { ApiCall } from "@core/identity";
import { Modal } from "./ChannelDialogs";
import { StickerMessage, StickersTab } from "./stickers";
import { VoiceTab } from "./shareLimit";
import { SignupTab } from "./SignupTab";
import { SecurityTab } from "./SecurityTab";
import { BugReportsTab } from "./BugReports";
import { GeneralTab } from "./GeneralTab";
import { MUTE_DURATIONS } from "./VoiceUI";
import { stickerIdOf } from "@core/stickers";
import { splitReply } from "@core/replies";
import { ColouredName, MIN_NAME_CONTRAST, nameContrast, refreshNames, useServerNameColours } from "./names";

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
  /** Name colour, #rrggbb, or null (names.tsx). */
  colour: string | null;
  members: number;
}

interface UserSummary {
  id: string;
  username: string;
  rank: number;
  groups: { id: string; name: string }[];
  created_at: string;
  banned: boolean;
  /** null with banned: permanent. */
  banned_until: string | null;
  voice_muted: boolean;
  /** null with voice_muted: until unmuted. */
  voice_muted_until: string | null;
  /** Two-factor sign-in is on. */
  two_factor: boolean;
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
  { id: "server_mute", label: "Server mute", help: "Take away the microphone of people below their rank, in every voice channel." },
  { id: "move_members", label: "Move members", help: "Move people below their rank who are in a call to another voice channel, or disconnect them from voice." },
  { id: "manage_stickers", label: "Manage stickers", help: "Add, rename and remove the server's stickers." },
  { id: "direct_messages", label: "Direct messages", help: "Start and send direct messages. Staff (any other switch) always can." },
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

function useUserList(call: ApiCall, reload: number) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
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
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { users, error, refresh };
}

const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export type ServerTab = "general" | "groups" | "members" | "reports" | "bugs" | "bans" | "log" | "stickers" | "voice" | "signup" | "security";

/**
 * reload changes whenever the server says permissions moved, so the lists
 * follow changes made elsewhere (another admin, the CLI).
 */
export function ServerSettingsDialog({ call, me, reload, openReports, openBugReports, initialTab, onClose }: {
  call: ApiCall;
  me: Me;
  reload: number;
  /** Shown on the Reports tab; with any open, the dialog opens there. */
  openReports: number;
  /** Shown on the Bug Reports tab; opens there when no message reports wait. */
  openBugReports: number;
  /** Open on this tab instead (Home's Edit button opens General). */
  initialTab?: ServerTab;
  onClose: () => void;
}) {
  const has = (p: string) => me.permissions.includes(p);
  const [tab, setTab] = useState<ServerTab>(() => initialTab ?? (openReports > 0 && has("view_reports") ? "reports"
    : openBugReports > 0 && has("view_reports") ? "bugs" : has("administrator") ? "general" : "groups"));
  const tabs: [ServerTab, string][] = has("administrator") ? [["general", "General"]] : [];
  tabs.push(["groups", "Groups"], ["members", "Members"]);
  if (has("view_reports")) tabs.push(["reports", openReports ? `Reports (${openReports})` : "Reports"]);
  if (has("view_reports")) tabs.push(["bugs", openBugReports ? `Bug Reports (${openBugReports})` : "Bug Reports"]);
  if (has("ban")) tabs.push(["bans", "Bans"]);
  if (has("ban") || has("view_reports") || has("delete_messages") || has("server_mute") || has("move_members")) tabs.push(["log", "Log"]);
  // Every staff member can see the set; managing it needs the switch.
  tabs.push(["stickers", "Stickers"]);
  if (has("administrator")) tabs.push(["voice", "Voice and Video"], ["signup", "Sign-Up"], ["security", "Security"]);
  return (
    <Modal title="Server settings" onClose={onClose} wide fixed>
      <div className="settings-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : undefined}
            onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === "general" ? <GeneralTab call={call} onClose={onClose} />
        : tab === "voice" ? <VoiceTab call={call} onClose={onClose} />
        : tab === "signup" ? <SignupTab call={call} onClose={onClose} />
        : tab === "security" ? <SecurityTab call={call} onClose={onClose} /> : (<>
      <div className="modal-body">
        {tab === "groups" && <GroupsTab call={call} me={me} reload={reload} />}
        {tab === "members" && <MembersTab call={call} me={me} reload={reload} />}
        {tab === "reports" && <ReportsTab call={call} me={me} reload={reload} />}
        {tab === "bugs" && <BugReportsTab call={call} reload={reload} isAdmin={has("administrator")} />}
        {tab === "bans" && <BansTab call={call} reload={reload} />}
        {tab === "log" && <LogTab call={call} me={me} reload={reload} />}
        {tab === "stickers" && (
          <StickersTab call={call} canManage={has("manage_stickers")} isAdmin={has("administrator")} />
        )}
      </div>
      <div className="modal-actions modal-foot">
        <button className="primary" onClick={onClose}>Done</button>
      </div>
      </>)}
    </Modal>
  );
}

// ---------------------------------------------------------------- groups

function GroupsTab({ call, me, reload }: { call: ApiCall; me: Me; reload: number }) {
  const { groups, error, refresh } = useGroupList(call, reload);
  // null: the list; "new": creating; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  // The group whose colour is being picked, inline in the list.
  const [colouring, setColouring] = useState<string | null>(null);
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
      <NameColoursSwitch call={call} canManage={canManage} onReset={refresh} />
      <ul className="device-list">
        {groups.map((g) => {
          const lock = editLock(me, g);
          // A colour is cosmetic: allowed on your own rank's group too, so
          // an administrator can recolour Administrator.
          const canColour = canManage && g.position <= me.rank;
          return (
            <li key={g.id} className={colouring === g.id ? "group-row open" : "group-row"}>
              <div className="member-row">
              <span className="device-name">
                <span className="swatch" style={{ background: g.colour ?? "transparent" }}
                  title={g.colour ? `Name colour ${g.colour}` : "No name colour"} aria-hidden />
                <strong style={g.colour ? { color: g.colour } : undefined}>{g.name}</strong>
                <span className="tag small" title="Rank">{g.position}</span>
                {g.auto_assign && <span className="tag small" title="New accounts join this group">New accounts</span>}
                <span className="muted small block">
                  {g.is_everyone ? "Everyone, always" : `${g.members} member${g.members === 1 ? "" : "s"}`}
                  {" · "}
                  {g.permissions.length ? g.permissions.map(switchLabel).join(", ") : "no switches"}
                </span>
              </span>
              <span className="row-actions">
                {canColour && (
                  <button className="secondary" onClick={() => setColouring(colouring === g.id ? null : g.id)}>
                    Colour
                  </button>
                )}
                {canManage && (lock
                  ? <span className="muted small" title={lock}>Locked</span>
                  : <button className="secondary" onClick={() => setEditing(g.id)}>Edit</button>)}
              </span>
              </div>
              {colouring === g.id && (
                <GroupColour call={call} group={g}
                  onDone={() => {
                    setColouring(null);
                    refresh();
                    refreshNames();
                  }}
                  onCancel={() => setColouring(null)} />
              )}
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

/** The server-wide on/off for name colours (Groups tab). */
function NameColoursSwitch({ call, canManage, onReset }: { call: ApiCall; canManage: boolean; onReset: () => void }) {
  const enabled = useServerNameColours();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function reset() {
    if (!confirm("Put the default name colours back?\n\nAdministrator orange, Moderator magenta, Member cyan, " +
      "Everyone none (white). Other groups keep their colours.")) return;
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const r = await call("/api/v1/name-colours/defaults", { method: "POST" }) as { reset: number; skipped: number };
      setFlash(r.skipped
        ? `Defaults restored, except ${r.skipped} group${r.skipped === 1 ? "" : "s"} ranked above you.`
        : "Default colours restored.");
      refreshNames();
      onReset();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function set(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      await call("/api/v1/name-colours", { method: "PUT", body: JSON.stringify({ enabled: on }) });
      refreshNames();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label className="check">
        <input type="checkbox" checked={!!enabled} disabled={!canManage || busy || enabled === null}
          onChange={(e) => void set(e.target.checked)} />
        <span>
          Colour names by group
          <span className="muted small block">
            A name shows in the colour of the person's highest group that has one. Everyone on the server sees the
            same colours; each person can still hide them in Settings, Appearance.
          </span>
        </span>
      </label>
      {canManage && (
        <div className="row-actions">
          <button className="secondary" onClick={() => void reset()} disabled={busy}>Default colours</button>
        </div>
      )}
      {flash && <p className="muted small" role="status">{flash}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

/** Pick (or clear) a group's name colour, with the contrast check. */
function GroupColour({ call, group, onDone, onCancel }: {
  call: ApiCall;
  group: PermGroup;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(group.colour ?? "#ffffff");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
  const ratio = hex ? nameContrast(hex) : 0;
  const readable = ratio >= MIN_NAME_CONTRAST;

  async function save(colour: string) {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/v1/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ colour }) });
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form className="group-colour" onSubmit={(e) => { e.preventDefault(); if (hex && readable) void save(hex); }}>
      <div className="colour-row">
        <input type="color" value={hex ?? "#ffffff"} onChange={(e) => setValue(e.target.value)}
          aria-label={`Name colour for ${group.name}`} />
        <input className="hex" value={value} onChange={(e) => setValue(e.target.value.trim())} maxLength={7}
          spellCheck={false} aria-label="Colour as #rrggbb" />
        <strong className="colour-preview" style={hex ? { color: hex } : undefined}>{group.name}</strong>
      </div>
      <p className={`small ${hex && !readable ? "error" : "muted"}`}>
        {!hex ? "Type a colour as #rrggbb."
          : readable ? `Contrast ${ratio.toFixed(1)}:1 against the background. Readable.`
          : `Contrast ${ratio.toFixed(1)}:1 is too low (needs ${MIN_NAME_CONTRAST}:1). Pick a lighter colour.`}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        {group.colour && (
          <button type="button" className="secondary" onClick={() => void save("")} disabled={busy}>No colour</button>
        )}
        <button type="submit" className="primary" disabled={busy || !hex || !readable}>
          {busy ? "Saving…" : "Save colour"}
        </button>
      </div>
    </form>
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
  const { users, error, refresh: refreshUsers } = useUserList(call, reload);
  const [filter, setFilter] = useState("");
  // Which row is open, and on what.
  const [open, setOpen] = useState<{ id: string; mode: "groups" | "ban" | "mute" | "delete" | "twofactor" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const canManage = me.permissions.includes("manage_groups");
  const canBan = me.permissions.includes("ban");
  const isAdmin = me.permissions.includes("administrator");
  const canMute = isAdmin || me.permissions.includes("server_mute");

  async function unmute(u: UserSummary) {
    setBusy(`${u.id}:unmute`);
    setRowError(null);
    try {
      await call(`/api/v1/users/${u.id}/voice-mute`, { method: "DELETE" });
      setFlash(`${u.username} is unmuted.`);
    } catch (err) {
      setRowError({ id: u.id, msg: errText(err) });
    } finally {
      setBusy(null);
      refreshUsers();
    }
  }

  async function unban(u: UserSummary) {
    setBusy(`${u.id}:unban`);
    setRowError(null);
    try {
      await call(`/api/v1/users/${u.id}/ban`, { method: "DELETE" });
      setFlash(`${u.username} is unbanned.`);
    } catch (err) {
      setRowError({ id: u.id, msg: errText(err) });
    } finally {
      setBusy(null);
      refreshUsers();
    }
  }

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
      refreshUsers();
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
        {canBan ? " You can ban people ranked below you." : ""}
        {canMute ? " You can server-mute people ranked below you." : ""}
      </p>
      {flash && <p className="small" role="status">{flash}</p>}
      <ul className="device-list">
        {shown.map((u) => {
          const self = u.id === me.userId;
          const lock = self ? "That's you." : u.rank >= me.rank ? "Ranked at or above you." : null;
          const mode = open?.id === u.id ? open.mode : null;
          const toggle = (m: "groups" | "ban" | "mute" | "delete" | "twofactor") => {
            setRowError(null);
            setFlash(null);
            setOpen(mode === m ? null : { id: u.id, mode: m });
          };
          const actions = !lock && (canManage || canBan || canMute || isAdmin);
          return (
            <li key={u.id} className={mode ? "member open" : "member"}>
              <div className="member-row">
                <span className="device-name">
                  <strong><ColouredName userId={u.id}>{u.username}</ColouredName></strong>
                  {self && <span className="tag small">You</span>}
                  {u.two_factor && <span className="tag small" title="Two-factor sign-in is on">2FA</span>}
                  {u.banned && (
                    <span className="tag small danger-tag"
                      title={u.banned_until ? `Until ${when(u.banned_until)}` : "Permanent"}>Banned</span>
                  )}
                  {u.voice_muted && (
                    <span className="tag small danger-tag"
                      title={u.voice_muted_until ? `Until ${when(u.voice_muted_until)}` : "Until unmuted"}>Muted</span>
                  )}
                  <span className="muted small block">
                    {u.groups.length ? u.groups.map((g) => g.name).join(", ") : "No groups"} · rank {u.rank}
                    {" · joined "}{new Date(u.created_at).toLocaleDateString()}
                    {u.banned && (u.banned_until ? ` · banned until ${when(u.banned_until)}` : " · banned permanently")}
                    {u.voice_muted && (u.voice_muted_until ? ` · muted until ${when(u.voice_muted_until)}` : " · muted until unmuted")}
                  </span>
                </span>
                {canBan && u.banned && (
                  <button className="secondary" onClick={() => void unban(u)} disabled={busy !== null}>
                    {busy === `${u.id}:unban` ? "Unbanning…" : "Unban"}
                  </button>
                )}
                {canMute && u.voice_muted && (
                  <button className="secondary" onClick={() => void unmute(u)} disabled={busy !== null}>
                    {busy === `${u.id}:unmute` ? "Unmuting…" : "Unmute"}
                  </button>
                )}
                {actions && canMute && !u.voice_muted && (
                  <button className="secondary" onClick={() => toggle("mute")} aria-expanded={mode === "mute"}>
                    {mode === "mute" ? "Close" : "Mute"}
                  </button>
                )}
                {actions && canManage && (
                  <button className="secondary" onClick={() => toggle("groups")} aria-expanded={mode === "groups"}>
                    {mode === "groups" ? "Close" : "Groups"}
                  </button>
                )}
                {actions && canBan && !u.banned && (
                  <button className="secondary" onClick={() => toggle("ban")} aria-expanded={mode === "ban"}>
                    {mode === "ban" ? "Close" : "Ban"}
                  </button>
                )}
                {actions && isAdmin && u.two_factor && (
                  <button className="secondary" onClick={() => toggle("twofactor")} aria-expanded={mode === "twofactor"}>
                    {mode === "twofactor" ? "Close" : "Remove 2FA"}
                  </button>
                )}
                {actions && isAdmin && (
                  <button className="danger" onClick={() => toggle("delete")} aria-expanded={mode === "delete"}>
                    {mode === "delete" ? "Close" : "Delete"}
                  </button>
                )}
                {lock && !self && (canManage || canBan || canMute) && <span className="muted small" title={lock}>Locked</span>}
              </div>
              {mode === "ban" && !lock && (
                <div className="member-groups">
                  <BanForm call={call} me={me} user={u}
                    onCancel={() => setOpen(null)}
                    onDone={(msg) => {
                      setOpen(null);
                      setFlash(msg);
                      refreshUsers();
                    }} />
                </div>
              )}
              {mode === "mute" && !lock && (
                <div className="member-groups">
                  <MuteForm call={call} user={u}
                    onCancel={() => setOpen(null)}
                    onDone={(msg) => {
                      setOpen(null);
                      setFlash(msg);
                      refreshUsers();
                    }} />
                </div>
              )}
              {mode === "twofactor" && !lock && (
                <div className="member-groups">
                  <RemoveTwoFactor call={call} user={u}
                    onCancel={() => setOpen(null)}
                    onDone={() => {
                      setOpen(null);
                      setFlash(`${u.username}'s two-factor is removed. They sign in with their password alone and can set it up again.`);
                      refreshUsers();
                    }} />
                </div>
              )}
              {mode === "delete" && !lock && (
                <div className="member-groups">
                  <DeleteAccount call={call} user={u}
                    onCancel={() => setOpen(null)}
                    onDone={() => {
                      setOpen(null);
                      setFlash(`${u.username}'s account is deleted.`);
                      refreshUsers();
                      refreshGroups();
                    }} />
                </div>
              )}
              {mode === "groups" && !lock && (
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
                </div>
              )}
              {rowError?.id === u.id && <p className="error" role="alert">{rowError.msg}</p>}
            </li>
          );
        })}
        {!shown.length && <li className="muted small">Nobody matches.</li>}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------ moderation

/** Postgres interval strings the server accepts; "" is permanent. */
const DURATIONS: [string, string][] = [
  ["1 hour", "1 hour"],
  ["1 day", "1 day"],
  ["7 days", "7 days"],
  ["30 days", "30 days"],
  ["", "Permanent"],
];

/**
 * Ban one account. The server signs them out everywhere at once, drops
 * them from voice, and their devices leave every encrypted channel.
 */
function BanForm({ call, me, user, onDone, onCancel }: {
  call: ApiCall;
  me: Me;
  user: { id: string; username: string };
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState("1 day");
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = me.permissions.includes("administrator");

  async function ban(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await call(`/api/v1/users/${user.id}/ban`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim(), duration, purge_messages: purge }),
      }) as { purged_messages?: number };
      const span = duration ? `for ${duration}` : "permanently";
      const purged = purge ? ` and ${res?.purged_messages ?? 0} of their messages deleted` : "";
      onDone(`${user.username} is banned ${span}${purged}.`);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={ban}>
      <label>
        Reason <span className="muted small">(other staff see it in Bans and the log)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
      </label>
      <label>
        How long
        <select value={duration} onChange={(e) => setDuration(e.target.value)}>
          {DURATIONS.map(([v, label]) => <option key={label} value={v}>{label}</option>)}
        </select>
      </label>
      {isAdmin && (
        <label className="check">
          <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
          <span>
            Also delete everything they've written
            <span className="muted small block">
              For spam floods and abuse campaigns. Every message and file they sent is removed for everyone, which
              also removes the evidence. Unbanning later doesn't bring any of it back.
            </span>
          </span>
        </label>
      )}
      <p className="muted small">
        {user.username} is signed out everywhere straight away and can't sign in until the ban ends. Their account and
        {purge ? " groups stay." : " messages stay."}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="danger solid" disabled={busy}>
          {busy ? "Banning…" : purge ? `Ban ${user.username} and delete messages` : `Ban ${user.username}`}
        </button>
      </div>
    </form>
  );
}

/** Server-mute one account: no microphone in any voice channel. */
function MuteForm({ call, user, onDone, onCancel }: {
  call: ApiCall;
  user: { id: string; username: string };
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [duration, setDuration] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mute(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(`/api/v1/users/${user.id}/voice-mute`, { method: "PUT", body: JSON.stringify({ duration }) });
      onDone(`${user.username} is server-muted ${duration ? `for ${duration}` : "until unmuted"}.`);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={mute}>
      <label>
        How long
        <select value={duration} onChange={(e) => setDuration(e.target.value)} autoFocus>
          {MUTE_DURATIONS.map(([v, label]) => <option key={label} value={v}>{label}</option>)}
        </select>
      </label>
      <p className="muted small">
        {user.username} can still join voice channels and listen, but can't speak or share sound, straight away and
        every time they join until the mute ends. Sharing a screen without sound still works.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="danger solid" disabled={busy}>
          {busy ? "Muting…" : `Mute ${user.username}`}
        </button>
      </div>
    </form>
  );
}

/** Administrator only: remove someone's two-factor (lost phone and backup codes). */
function RemoveTwoFactor({ call, user, onDone, onCancel }: {
  call: ApiCall;
  user: { id: string; username: string };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(`/api/v1/users/${user.id}/two-factor`, { method: "DELETE" });
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={remove}>
      <p className="muted small">
        For when {user.username} has lost their phone and their backup codes. Their password alone then signs them
        in, so make sure it's really them asking. This is recorded in the log. If the server requires two-factor
        for them, they set it up again at their next sign-in.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="danger solid" disabled={busy}>
          {busy ? "Removing…" : `Remove ${user.username}'s two-factor`}
        </button>
      </div>
    </form>
  );
}

/** Administrator only: delete someone else's account for good. */
function DeleteAccount({ call, user, onDone, onCancel }: {
  call: ApiCall;
  user: { id: string; username: string };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(e: FormEvent) {
    e.preventDefault();
    if (typed !== user.username) return;
    setBusy(true);
    setError(null);
    try {
      await call(`/api/v1/users/${user.id}`, { method: "DELETE" });
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={remove}>
      <p className="small">
        Delete <strong>{user.username}</strong>'s account? They're signed out, their devices are removed, and every
        message they wrote is emptied for everyone (shown as "Deleted user"). This can't be undone. To stop someone
        without destroying anything, ban them instead.
      </p>
      <label>
        Type <strong className="as-typed">{user.username}</strong> to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row-actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="danger solid" disabled={busy || typed !== user.username}>
          {busy ? "Deleting…" : "Delete account"}
        </button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------- reports

interface Report {
  id: string;
  message_id: string | null;
  channel_id: string | null;
  channel: string;
  message_gone: boolean;
  reporter: string;
  accused: string;
  accused_id: string | null;
  reason: string;
  claimed_body: string;
  // The accused deleted their account (or was deleted), which destroyed
  // this copy of their words along with everything else they wrote.
  content_deleted: boolean;
  verified: boolean | null;
  status: "open" | "dismissed" | "actioned" | "rejected";
  created_at: string;
}

const REPORT_STATUSES: [Report["status"], string][] = [
  ["open", "Open"],
  ["actioned", "Actioned"],
  ["dismissed", "No action"],
  ["rejected", "Rejected"],
];

function ReportsTab({ call, me, reload }: { call: ApiCall; me: Me; reload: number }) {
  const [status, setStatus] = useState<Report["status"]>("open");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);
  const [banning, setBanning] = useState<string | null>(null);
  // Report whose "Delete message" is waiting for confirmation.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // For the Ban button: who is already banned or ranked too high.
  const { users, refresh: refreshUsers } = useUserList(call, reload);
  const canDelete = me.permissions.includes("delete_messages");
  const canBan = me.permissions.includes("ban");

  useEffect(() => {
    let live = true;
    setReports(null);
    (call(`/api/v1/reports?status=${status}`) as Promise<Report[]>)
      .then((r) => {
        if (!live) return;
        setReports(r);
        setError(null);
      })
      .catch((err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [call, status, reload, tick]);

  const resolve = (r: Report, resolution: "dismiss" | "action") =>
    call(`/api/v1/reports/${r.id}/resolve`, { method: "POST", body: JSON.stringify({ resolution }) });

  // Deleting the message or banning the author IS acting on the report, so
  // either one also marks it Actioned. Without that, a moderator could
  // delete a message and then pick "No action needed", and the record
  // would say nothing was done.
  async function act(r: Report, what: "dismiss" | "action" | "delete") {
    setBusy(`${r.id}:${what}`);
    setRowError(null);
    setFlash(null);
    setConfirmDelete(null);
    let deleted = false;
    try {
      if (what === "delete") {
        await call(`/api/v1/messages/${r.message_id}`, { method: "DELETE" });
        deleted = true;
        await resolve(r, "action");
        setFlash(`Message by ${r.accused} deleted; report marked actioned.`);
      } else {
        await resolve(r, what);
      }
    } catch (err) {
      setRowError({
        id: r.id,
        msg: deleted ? `The message was deleted, but the report couldn't be marked actioned: ${errText(err)}` : errText(err),
      });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  }

  async function banned(r: Report, msg: string) {
    setBanning(null);
    refreshUsers();
    try {
      await resolve(r, "action");
      setFlash(`${msg} Report marked actioned.`);
    } catch (err) {
      setFlash(msg);
      setRowError({ id: r.id, msg: `The ban worked, but the report couldn't be marked actioned: ${errText(err)}` });
    }
    setTick((t) => t + 1);
  }

  const userById = new Map((users ?? []).map((u) => [u.id, u]));

  return (
    <section className="settings-section">
      <div className="settings-tabs sub" role="tablist" aria-label="Report status">
        {REPORT_STATUSES.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={status === id} className={status === id ? "on" : undefined}
            onClick={() => setStatus(id)}>{label}</button>
        ))}
      </div>
      <p className="muted small">
        {status === "open" && "Review each report, then choose one: Delete message or Ban (either one also marks it"
          + " Actioned), No action needed (reviewed, nothing to do), or Mark actioned if you dealt with it another"
          + " way, such as a warning."}
        {status === "rejected" && "Reports the server refused because the reported text didn't match the message on"
          + " record: the reporter changed it. Filing those is itself worth a look."}
        {status === "actioned" && "Reports where a moderator acted: deleted the message, banned the author, or"
          + " dealt with it another way. The newest 100."}
        {status === "dismissed" && "Reports a moderator reviewed and decided needed no action. The newest 100."}
      </p>
      {flash && <p className="small" role="status">{flash}</p>}
      {error && <p className="error" role="alert">Couldn't load reports: {error}</p>}
      {!error && !reports && <p className="muted">Loading…</p>}
      {reports && (
        <ul className="device-list">
          {reports.map((r) => {
            const accused = r.accused_id ? userById.get(r.accused_id) : undefined;
            const banLock = !r.accused_id ? "The account is gone."
              : !accused ? null
              : accused.banned ? "Already banned."
              : accused.id === me.userId ? "That's you."
              : accused.rank >= me.rank ? "Ranked at or above you." : null;
            return (
              <li key={r.id} className="member">
                <div className="report-head small">
                  <strong>{r.accused}</strong>
                  <span className="muted">
                    {r.channel ? ` in #${r.channel}` : " in a deleted channel"} · reported by {r.reporter} · {when(r.created_at)}
                  </span>
                  <VerifiedTag v={r.verified} />
                  {r.message_gone && <span className="tag small">Message deleted</span>}
                </div>
                <blockquote className="quoted small">{r.content_deleted
                  ? <em className="muted">(content deleted with the account)</em>
                  : <ReportedText body={r.claimed_body} />}</blockquote>
                {r.reason
                  ? <p className="small report-reason"><span className="muted">Reason:</span> {r.reason}</p>
                  : <p className="small muted report-reason">No reason given.</p>}
                {r.status === "open" && (
                  <div className="row-actions">
                    {canDelete && r.message_id && !r.message_gone && (
                      <button className="danger" disabled={busy !== null}
                        onClick={() => {
                          setBanning(null);
                          setConfirmDelete(confirmDelete === r.id ? null : r.id);
                        }}
                        aria-expanded={confirmDelete === r.id}>
                        {busy === `${r.id}:delete` ? "Deleting…" : confirmDelete === r.id ? "Close" : "Delete message"}
                      </button>
                    )}
                    {canBan && (banLock
                      ? <span className="muted small" title={banLock}>Can't ban</span>
                      : (
                        <button className="secondary" onClick={() => {
                          setConfirmDelete(null);
                          setBanning(banning === r.id ? null : r.id);
                        }}
                          aria-expanded={banning === r.id}>{banning === r.id ? "Close" : `Ban ${r.accused}`}</button>
                      ))}
                    <span className="spacer" />
                    <button className="secondary" disabled={busy !== null} onClick={() => void act(r, "dismiss")}
                      title="Reviewed, and nothing needs doing. Closes the report.">
                      {busy === `${r.id}:dismiss` ? "…" : "No action needed"}
                    </button>
                    <button className="secondary" disabled={busy !== null} onClick={() => void act(r, "action")}
                      title="You dealt with it some other way, such as a warning. Closes the report.">
                      {busy === `${r.id}:action` ? "…" : "Mark actioned"}
                    </button>
                  </div>
                )}
                {confirmDelete === r.id && r.status === "open" && (
                  <div className="member-groups">
                    <p className="small">
                      Delete this message by <strong>{r.accused}</strong> for everyone? This can't be undone, and the
                      report will be marked actioned.
                    </p>
                    <div className="row-actions">
                      <button className="danger" disabled={busy !== null} onClick={() => void act(r, "delete")}>
                        {busy === `${r.id}:delete` ? "Deleting…" : "Delete message"}
                      </button>
                      <button className="secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </div>
                  </div>
                )}
                {banning === r.id && r.accused_id && (
                  <div className="member-groups">
                    <p className="small muted">Banning {r.accused} also marks this report actioned.</p>
                    <BanForm call={call} me={me} user={{ id: r.accused_id, username: r.accused }}
                      onCancel={() => setBanning(null)}
                      onDone={(msg) => void banned(r, msg)} />
                  </div>
                )}
                {rowError?.id === r.id && <p className="error" role="alert">{rowError.msg}</p>}
              </li>
            );
          })}
          {!reports.length && (
            <li className="muted small">
              No {(REPORT_STATUSES.find(([id]) => id === status)?.[1] ?? status).toLowerCase()} reports.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** A reported message's text, as its reporter's app showed it: a reply
 * says what it replied to above the text. */
function ReportedText({ body }: { body: string }) {
  const { text, reply } = splitReply(body);
  const sticker = stickerIdOf(text);
  return (
    <>
      {reply && (
        <span className="muted block">
          Replying to {reply.username}{reply.preview ? `: ${reply.preview}` : ""}
        </span>
      )}
      {sticker ? <StickerMessage id={sticker} /> : text || <em className="muted">(no text)</em>}
    </>
  );
}

function VerifiedTag({ v }: { v: boolean | null }) {
  if (v === true) return <span className="tag small" title="The reported text matches the server's copy">Checked</span>;
  if (v === false) return <span className="tag small danger-tag" title="The reported text didn't match the message on record">Didn't match</span>;
  return (
    <span className="tag small" title="Encrypted channel: the server can't read the message, so it can't check the reported text yet">
      Unchecked
    </span>
  );
}

// ------------------------------------------------------------------ bans

interface Ban {
  username: string;
  user_id: string;
  actor: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
}

function BansTab({ call, reload }: { call: ApiCall; reload: number }) {
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);

  useEffect(() => {
    let live = true;
    (call("/api/v1/bans") as Promise<Ban[]>)
      .then((b) => {
        if (!live) return;
        setBans(b);
        setError(null);
      })
      .catch((err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [call, reload, tick]);

  async function unban(b: Ban) {
    setBusy(b.user_id);
    setRowError(null);
    try {
      await call(`/api/v1/users/${b.user_id}/ban`, { method: "DELETE" });
    } catch (err) {
      setRowError({ id: b.user_id, msg: errText(err) });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  }

  if (error) return <p className="error" role="alert">Couldn't load bans: {error}</p>;
  if (!bans) return <p className="muted">Loading…</p>;

  return (
    <section className="settings-section">
      <p className="muted small">Bans in force now. To ban someone, use Ban on their row in Members, or on a report.</p>
      <ul className="device-list">
        {bans.map((b) => (
          <li key={b.user_id} className="member">
            <div className="member-row">
              <span className="device-name">
                <strong>{b.username}</strong>
                <span className="tag small">{b.expires_at ? `until ${when(b.expires_at)}` : "Permanent"}</span>
                <span className="muted small block">
                  By {b.actor} · {when(b.created_at)}{b.reason ? ` · ${b.reason}` : " · no reason given"}
                </span>
              </span>
              <button className="secondary" onClick={() => void unban(b)} disabled={busy !== null}>
                {busy === b.user_id ? "Unbanning…" : "Unban"}
              </button>
            </div>
            {rowError?.id === b.user_id && <p className="error" role="alert">{rowError.msg}</p>}
          </li>
        ))}
        {!bans.length && <li className="muted small">Nobody is banned.</li>}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------- log

interface LogEntry {
  id: string;
  actor: string;
  action: string;
  subject_id: string | null;
  subject_user: string;
  subject_channel: string;
  detail: string;
  created_at: string;
}

/** One sentence per entry. Names can be empty once rows are gone. */
function describe(e: LogEntry): { text: string; note?: string } {
  const who = e.subject_user || "a deleted account";
  const where = e.subject_channel ? ` in #${e.subject_channel}` : "";
  switch (e.action) {
    case "ban":
      return { text: `banned ${who}`, note: e.detail || undefined };
    case "ban_and_purge":
      return { text: `banned ${who} and deleted their messages`, note: e.detail || undefined };
    case "unban":
      return { text: `unbanned ${who}` };
    case "voice_mute":
      return { text: `server-muted ${who}`, note: e.detail ? `For ${e.detail}` : "Until unmuted" };
    case "voice_unmute":
      return { text: `unmuted ${who}` };
    case "voice_move":
      return { text: `moved ${who} to ${e.detail || "another voice channel"}` };
    case "voice_disconnect":
      return { text: `disconnected ${who} from voice` };
    case "delete_message":
      return { text: `deleted a message by ${e.subject_user || "a deleted account"}${where}` };
    case "resolve_report":
      return {
        text: e.detail === "dismissed"
          ? `marked a report about ${e.subject_user || "a deleted account"}${where} as needing no action`
          : `${e.detail === "actioned" ? "actioned" : "resolved"} a report about ${e.subject_user || "a deleted account"}${where}`,
      };
    case "delete_user":
      return { text: `deleted the account ${e.detail || "(unknown)"}` };
    case "set_signup_mode":
      return { text: `set sign-up to ${e.detail === "password" ? "Server Password" : e.detail === "closed" ? "Closed" : "Open"}` };
    case "set_signup_rotation":
      return { text: e.detail === "never" ? "stopped changing the server password automatically" : `set the server password to change ${e.detail}` };
    case "change_signup_password":
      return { text: "changed the server password" };
    case "rotate_signup_password":
      return { text: "generated a new server password" };
    case "two_factor_reset":
      return { text: `removed two-factor sign-in from ${who}` };
    case "two_factor_policy":
      return {
        text: e.detail === "off" ? "stopped requiring two-factor sign-in"
          : `required two-factor sign-in for ${e.detail === "everyone" ? "everyone" : "staff"}`,
      };
    case "create_channel":
      return { text: `created the channel ${e.detail}` };
    case "rename_channel":
      return { text: `renamed the channel ${e.detail}` };
    case "delete_channel":
      return { text: `deleted the channel ${e.detail}` };
    case "set_server_name":
      return { text: e.detail ? `named the server ${e.detail}` : "removed the server's name" };
    case "set_server_icon":
      return { text: "changed the server icon" };
    case "remove_server_icon":
      return { text: "removed the server icon" };
    case "remove_avatar":
      return { text: `removed ${who}'s avatar` };
    case "clear_bio":
      return { text: `cleared ${who}'s bio` };
    case "set_server_banner":
      return { text: "changed the Home banner" };
    case "remove_server_banner":
      return { text: "removed the Home banner" };
    case "set_home":
      return { text: e.detail === "rules" ? "changed the rules"
        : e.detail === "welcome" ? "changed the Home welcome" : "changed the Home welcome and the rules" };
    case "enforce_rules":
      return { text: e.detail === "on" ? "required everyone to accept the rules" : "stopped requiring the rules to be accepted" };
    case "ask_rules_again":
      return { text: "asked everyone to accept the changed rules" };
    case "add_sticker":
      return { text: `added the sticker :${e.detail}:` };
    case "delete_sticker":
      return { text: `removed the sticker :${e.detail}:` };
    default:
      return { text: e.action.replace(/_/g, " "), note: e.detail || undefined };
  }
}

function LogTab({ call, me, reload }: { call: ApiCall; me: Me; reload: number }) {
  const [view, setView] = useState<"recent" | "archived">("recent");
  const [days, setDays] = useState<number | null>(null);
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settingsTick, setSettingsTick] = useState(0);
  const isAdmin = me.permissions.includes("administrator");
  const PAGE = 100;
  const base = `/api/v1/moderation-log${view === "archived" ? "?archived=1" : ""}`;

  useEffect(() => {
    let live = true;
    (call("/api/v1/moderation-log/settings") as Promise<{ archive_days: number }>)
      .then((s) => live && setDays(s.archive_days))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [call, reload, settingsTick]);

  useEffect(() => {
    let live = true;
    setEntries(null);
    (call(base) as Promise<LogEntry[]>)
      .then((e) => {
        if (!live) return;
        setEntries(e);
        setMore(e.length === PAGE);
        setError(null);
      })
      .catch((err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [call, base, reload, settingsTick]);

  async function older() {
    if (!entries?.length) return;
    setLoading(true);
    try {
      const before = encodeURIComponent(entries[entries.length - 1].created_at);
      const page = await call(`${base}${base.includes("?") ? "&" : "?"}before=${before}`) as LogEntry[];
      setEntries([...entries, ...page]);
      setMore(page.length === PAGE);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }

  const period = days === null ? "" : `${days} day${days === 1 ? "" : "s"}`;

  return (
    <section className="settings-section">
      <div className="settings-tabs sub" role="tablist" aria-label="Log view">
        {([["recent", "Recent"], ["archived", "Archived"]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={view === id} className={view === id ? "on" : undefined}
            onClick={() => setView(id)}>{label}</button>
        ))}
      </div>
      <p className="muted small">
        Moderation actions, newest first: bans, server mutes, deleting other people's messages, closing reports and deleting accounts.
        People deleting their own messages aren't listed.
        {period && (view === "recent"
          ? ` Entries older than ${period} move to Archived.`
          : ` Entries older than ${period}. Nothing is ever deleted from the log.`)}
      </p>
      {isAdmin && days !== null && <ArchivePeriod call={call} days={days} onSaved={() => setSettingsTick((t) => t + 1)} />}
      {error && <p className="error" role="alert">Couldn't load the log: {error}</p>}
      {!error && !entries && <p className="muted">Loading…</p>}
      {entries && (
        <ul className="device-list log-list">
          {entries.map((e) => {
            const d = describe(e);
            return (
              <li key={e.id}>
                <span className="device-name small">
                  <strong>{e.actor}</strong> {d.text}
                  {d.note && <span className="muted block">{d.note}</span>}
                </span>
                <time className="muted small" dateTime={e.created_at}>{when(e.created_at)}</time>
              </li>
            );
          })}
          {!entries.length && <li className="muted small">{view === "archived" ? "Nothing archived yet." : "Nothing yet."}</li>}
        </ul>
      )}
      {more && (
        <div className="row-actions">
          <button className="secondary" onClick={() => void older()} disabled={loading}>
            {loading ? "Loading…" : "Older"}
          </button>
        </div>
      )}
    </section>
  );
}

/** Administrator only: how old an entry is before it moves to Archived. */
function ArchivePeriod({ call, days, onSaved }: { call: ApiCall; days: number; onSaved: () => void }) {
  const [value, setValue] = useState(String(days));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValue(String(days)), [days]);
  const n = Number(value);
  const valid = /^\d+$/.test(value) && n >= 1 && n <= 3650;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid || n === days) return;
    setBusy(true);
    setError(null);
    try {
      await call("/api/v1/moderation-log/settings", { method: "PUT", body: JSON.stringify({ archive_days: n }) });
      onSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form small" onSubmit={save}>
      <label className="inline">
        Archive after
        <input value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} inputMode="numeric"
          className="narrow" aria-label="Days before an entry is archived" />
        days
      </label>
      <button type="submit" className="secondary" disabled={busy || !valid || n === days}>
        {busy ? "Saving…" : "Save"}
      </button>
      {!valid && <span className="error">1 to 3650</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </form>
  );
}
