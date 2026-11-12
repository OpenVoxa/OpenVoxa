// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel ordering and categories in the sidebar (decisions.md Feature
 * decisions, "Channel ordering and categories"; server categories.go).
 *
 * The Text and Voice sections each list their top-level channels, then
 * their categories (named folders, one level deep). People with
 * manage_channels drag channels and categories to reorder them, and drop
 * a channel on a category's header to put it inside. The order is shared
 * by everyone; collapsing a category is each person's own choice, kept per
 * browser like the sidebar width.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent, type PointerEvent } from "react";
import type { ChannelAccess, ChannelCategory, ChannelInfo } from "@core/chat";
import { localStore } from "./core";
import { AccessEditor, accessBody, accessKey, defaultRows, Modal, rowsFrom, useGroups, type AccessRow } from "./ChannelDialogs";
import { MIN_NAME_CONTRAST, nameContrast } from "./names";
import type { ApiCall } from "@core/identity";

type Kind = "text" | "voice";

// ------------------------------------------------------------- layout

export interface SectionLayout {
  top: ChannelInfo[];
  groups: { cat: ChannelCategory; channels: ChannelInfo[] }[];
}

/**
 * One section's channels arranged for the sidebar. The server already
 * sends both lists in order; a channel whose category isn't listed (it
 * can't happen, but a refresh could race) shows at the top level.
 */
export function sectionLayout(channels: readonly ChannelInfo[], categories: readonly ChannelCategory[], kind: Kind): SectionLayout {
  const cats = categories.filter((c) => c.kind === kind);
  const known = new Set(cats.map((c) => c.id));
  const mine = channels.filter((c) => c.kind === kind);
  return {
    top: mine.filter((c) => !c.category_id || !known.has(c.category_id)),
    groups: cats.map((cat) => ({ cat, channels: mine.filter((c) => c.category_id === cat.id) })),
  };
}

/**
 * Move Up / Move Down from a menu (touchscreens can't drag): the before_id
 * that swaps an item with its visible neighbour in `scope` (its place:
 * the top level, one category, or the section's categories). undefined:
 * it's already first (up) or last (down). Hidden channels keep their
 * places on the server, as with dragging.
 */
export function stepMoves(scope: readonly { id: string }[], id: string):
  { up: string | undefined; down: string | null | undefined } {
  const i = scope.findIndex((x) => x.id === id);
  if (i < 0) return { up: undefined, down: undefined };
  return {
    up: i > 0 ? scope[i - 1].id : undefined,
    down: i < scope.length - 1 ? (scope[i + 2]?.id ?? null) : undefined,
  };
}

// ----------------------------------------------------------- collapse

const COLLAPSED_KEY = "layout.collapsedCategories";
const collapseListeners = new Set<() => void>();
let collapsed: ReadonlySet<string> = (() => {
  try {
    const v = JSON.parse(localStore.get(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set<string>();
  }
})();

function setCollapsed(id: string, on: boolean) {
  const next = new Set(collapsed);
  if (on) next.add(id);
  else next.delete(id);
  collapsed = next;
  localStore.set(COLLAPSED_KEY, JSON.stringify([...next]));
  collapseListeners.forEach((f) => f());
}

/** Which categories this browser has collapsed, and a toggle. */
export function useCollapsedCategories(): [ReadonlySet<string>, (id: string, on: boolean) => void] {
  const set = useSyncExternalStore(
    (f) => {
      collapseListeners.add(f);
      return () => collapseListeners.delete(f);
    },
    () => collapsed,
  );
  return [set, setCollapsed];
}

// --------------------------------------------------------------- drag

/** Our own drag type, so drags of people (voice moves) and files are told apart. */
export const LAYOUT_DRAG_TYPE = "application/x-openvoxa-layout";

export type Dragged =
  | { what: "channel"; id: string; kind: Kind }
  | { what: "category"; id: string; kind: Kind };

/** Where a drop would land: a line above or below a row, or into a category. */
export type DropHint = { key: string; where: "before" | "after" | "into" } | null;
type Where = "before" | "after" | "into";
type Point = { x: number; y: number };

/** Something a dragged row can land on. */
type Target =
  | { type: "channel"; c: ChannelInfo; scope: readonly ChannelInfo[] }
  | { type: "category"; cat: ChannelCategory; cats: readonly ChannelCategory[] }
  | { type: "section"; kind: Kind };

export interface DropProps {
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  /** Finds the target under a finger (touch drags use elementFromPoint). */
  "data-drop-key"?: string;
}
export interface DragProps {
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onPointerDown: (e: PointerEvent) => void;
}

function halfOf(el: Element, y: number): "before" | "after" {
  const r = el.getBoundingClientRect();
  return y < r.top + r.height / 2 ? "before" : "after";
}

/** The id after `id` in list, skipping `skip`; null at the end. */
function nextAfter<T extends { id: string }>(list: readonly T[], id: string, skip: string): string | null {
  const rest = list.filter((x) => x.id !== skip);
  const i = rest.findIndex((x) => x.id === id);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1].id : null;
}

function keyOf(t: Target): string {
  return t.type === "channel" ? t.c.id : t.type === "category" ? t.cat.id : `section-${t.kind}`;
}

/**
 * Where `d` would land on `t` with the pointer in `half` of it, or null
 * if it can't land there. One set of rules for mouse and finger.
 */
function whereOn(d: Dragged, t: Target, half: "before" | "after"): Where | null {
  if (t.type === "channel") {
    return d.what === "channel" && d.kind === t.c.kind && d.id !== t.c.id ? half : null;
  }
  if (t.type === "category") {
    if (d.kind !== t.cat.kind || d.id === t.cat.id) return null;
    return d.what === "channel" ? "into" : half;
  }
  return d.what === "channel" && d.kind === t.kind ? "into" : null;
}

/** Scroll the sidebar while a finger holds a row near its top or bottom edge. */
const EDGE = 48;
const EDGE_SPEED = 12;

/**
 * Drag-to-reorder for the sidebar, with a mouse (HTML drag and drop) or
 * a finger (long press, then move: `touch`, given to useMenuTrigger).
 * Only for manage_channels (enabled false: every prop is inert). Moves go
 * to the server, which tells everyone (channel_layout_changed); the list
 * then refetches.
 */
export function useLayoutDrag(call: ApiCall, enabled: boolean,
  onError: (title: string, err: unknown, at: Point) => void,
  /**
   * Before a channel moves: resolves to extra fields for the move
   * (keep_access, follow_category), or null to cancel. Asks before every
   * move to another place (MoveChannelDialog).
   */
  confirmMove?: (channelId: string, categoryId: string | null) =>
    Promise<{ keep_access?: boolean; follow_category?: boolean } | null>) {
  const confirmRef = useRef(confirmMove);
  confirmRef.current = confirmMove;
  const dragged = useRef<Dragged | null>(null);
  const [hint, setHint] = useState<DropHint>(null);
  // Every drop target from the last render, for finding one under a finger.
  const targets = useRef(new Map<string, Target>());
  // A finger drag: what's carried and where the finger is (the label
  // that follows it), plus the scroll loop near the edges.
  const [ghost, setGhost] = useState<{ id: string; label: string; x: number; y: number } | null>(null);
  const finger = useRef<{ at: Point; scroller: HTMLElement | null; raf: number } | null>(null);

  const send = useCallback((path: string, body: object, title: string, at: Point) =>
    call(path, { method: "POST", body: JSON.stringify(body) }).then(() => true, (err) => {
      onError(title, err, at);
      return false;
    }), [call, onError]);

  const moveCh = useCallback(async (id: string, categoryId: string | null, before: string | null, at: Point) => {
    const extra = confirmRef.current ? await confirmRef.current(id, categoryId) : {};
    if (!extra) return false;
    return send(`/api/v1/channels/${id}/move`, { category_id: categoryId, before_id: before, ...extra },
      "Couldn't move the channel", at);
  }, [send]);

  /** Drop `d` on `t`. */
  const land = (d: Dragged, t: Target, where: Where, at: Point) => {
    if (t.type === "channel") {
      const before = where === "before" ? t.c.id : nextAfter(t.scope, t.c.id, d.id);
      void moveCh(d.id, t.c.category_id ?? null, before, at);
    } else if (t.type === "category") {
      if (d.what === "channel") {
        void moveCh(d.id, t.cat.id, null, at);
      } else {
        const before = where === "before" ? t.cat.id : nextAfter(t.cats, t.cat.id, d.id);
        void send(`/api/v1/channel-categories/${d.id}/move`, { before_id: before }, "Couldn't move the category", at);
      }
    } else {
      void moveCh(d.id, null, null, at);
    }
  };

  const show = (key: string, where: Where) => {
    setHint((h) => (h && h.key === key && h.where === where ? h : { key, where }));
  };
  const ours = (e: DragEvent) => e.dataTransfer.types.includes(LAYOUT_DRAG_TYPE);

  const dragFor = (item: Dragged): DragProps => ({
    draggable: enabled,
    // A finger drags with our own touch code (long press, then move), not
    // the browser's: switch the browser's off for touches before it starts.
    onPointerDown: (e) => {
      if (enabled) (e.currentTarget as HTMLElement).draggable = e.pointerType !== "touch";
    },
    // On the row, not the button (Firefox won't drag a button). Drags
    // that start inside it (people in a voice roster) aren't ours.
    onDragStart: (e) => {
      if (!enabled || e.target !== e.currentTarget) return;
      e.stopPropagation();
      dragged.current = item;
      e.dataTransfer.effectAllowed = "move";
      // Firefox only starts a drag with some data set.
      e.dataTransfer.setData(LAYOUT_DRAG_TYPE, item.id);
    },
    onDragEnd: () => {
      dragged.current = null;
      setHint(null);
    },
  });

  const none: DropProps = { onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {} };

  /** Mouse drop handlers for a target; also registers it for finger drags. */
  const dropFor = (t: Target): DropProps => {
    if (!enabled) return none;
    const key = keyOf(t);
    targets.current.set(key, t);
    return {
      "data-drop-key": key,
      onDragOver: (e) => {
        const d = dragged.current;
        if (!ours(e) || !d) return;
        const where = whereOn(d, t, halfOf(e.currentTarget, e.clientY));
        if (!where) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        show(key, where);
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHint((h) => (h?.key === key ? null : h));
      },
      onDrop: (e) => {
        if (!ours(e)) return;
        e.preventDefault();
        setHint(null);
        const d = dragged.current;
        dragged.current = null;
        const where = d && whereOn(d, t, halfOf(e.currentTarget, e.clientY));
        if (d && where) land(d, t, where, { x: e.clientX, y: e.clientY });
      },
    };
  };

  /** The target under a finger, and where on it `d` would land. */
  const under = (d: Dragged, at: Point): { t: Target; where: Where } | null => {
    const el = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>("[data-drop-key]");
    const t = el && targets.current.get(el.dataset.dropKey ?? "");
    const where = el && t ? whereOn(d, t, halfOf(el, at.y)) : null;
    return t && where ? { t, where } : null;
  };

  const stopFinger = () => {
    if (finger.current) cancelAnimationFrame(finger.current.raf);
    finger.current = null;
    dragged.current = null;
    setGhost(null);
    setHint(null);
  };

  /** Finger drags: `item` and its label (shown under the finger). */
  const touch = {
    start: (item: Dragged, label: string, at: Point, from: Element | null): boolean => {
      if (!enabled) return false;
      dragged.current = item;
      const scroller = from?.closest<HTMLElement>(".channel-list") ?? null;
      const f = { at, scroller, raf: 0 };
      // Near the top or bottom of the list, keep scrolling while held.
      const tick = () => {
        const r = f.scroller?.getBoundingClientRect();
        if (r && f.scroller) {
          const dy = f.at.y < r.top + EDGE ? -EDGE_SPEED : f.at.y > r.bottom - EDGE ? EDGE_SPEED : 0;
          if (dy) {
            f.scroller.scrollTop += dy;
            const u = dragged.current && under(dragged.current, f.at);
            if (u) show(keyOf(u.t), u.where);
          }
        }
        f.raf = requestAnimationFrame(tick);
      };
      f.raf = requestAnimationFrame(tick);
      finger.current = f;
      setGhost({ id: item.id, label, x: at.x, y: at.y });
      return true;
    },
    move: (at: Point) => {
      const d = dragged.current;
      if (!d || !finger.current) return;
      finger.current.at = at;
      setGhost((g) => g && { ...g, x: at.x, y: at.y });
      const u = under(d, at);
      if (u) show(keyOf(u.t), u.where);
      else setHint(null);
    },
    end: (at: Point | null) => {
      const d = dragged.current;
      const u = d && at ? under(d, at) : null;
      stopFinger();
      if (d && u && at) land(d, u.t, u.where, at);
    },
  };

  const hintClass = (key: string) =>
    (hint?.key === key ? ` drop-${hint.where}` : "") + (ghost?.id === key ? " dragging" : "");

  return {
    hintClass,
    ghost,
    touch,
    channelDrag: (c: ChannelInfo) => dragFor({ what: "channel", id: c.id, kind: c.kind as Kind }),
    categoryDrag: (cat: ChannelCategory) => dragFor({ what: "category", id: cat.id, kind: cat.kind }),
    /** A channel row: another channel of its kind lands above or below it. */
    channelDrop: (c: ChannelInfo, scope: readonly ChannelInfo[]) => dropFor({ type: "channel", c, scope }),
    /** A category header: a channel goes in at the end; a category lands above or below it. */
    categoryDrop: (cat: ChannelCategory, cats: readonly ChannelCategory[]) => dropFor({ type: "category", cat, cats }),
    /** The section heading: a channel dropped on it goes to the end of the top level. */
    sectionDrop: (kind: Kind) => dropFor({ type: "section", kind }),
    /** The same moves from a menu; resolves false if it failed (shown via onError). */
    moveChannel: moveCh,
    moveCategory: (id: string, before: string | null, at: Point) =>
      send(`/api/v1/channel-categories/${id}/move`, { before_id: before }, "Couldn't move the category", at),
  };
}

/** Both sets of drop handlers on one element (voice rows also take dragged people). */
export function mergeDrop(a: Partial<DropProps>, b: Partial<DropProps>): DropProps {
  return {
    "data-drop-key": a["data-drop-key"] ?? b["data-drop-key"],
    onDragOver: (e) => { a.onDragOver?.(e); b.onDragOver?.(e); },
    onDragLeave: (e) => { a.onDragLeave?.(e); b.onDragLeave?.(e); },
    onDrop: (e) => { a.onDrop?.(e); b.onDrop?.(e); },
  };
}

// ------------------------------------------------------------ dialogs

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const SECTION = { text: "Text channels", voice: "Voice channels" } as const;

/**
 * Create a category in a section, or edit one's name, colour and
 * permissions. Channels in it set to Same as category use its
 * permissions; saving can also switch the Custom ones over.
 */
export function CategoryDialog({ call, kind, category, channels, onClose }: {
  call: ApiCall;
  kind: Kind;
  /** Set: edit this one. */
  category?: ChannelCategory;
  /** The channels in it (editing). */
  channels?: readonly ChannelInfo[];
  onClose: () => void;
}) {
  const { groups, error: groupsError } = useGroups(call);
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  useEffect(() => {
    if (groups && !rows) setRows(category?.access ? rowsFrom(groups, category.access) : defaultRows(groups));
  }, [groups, rows, category]);
  const [applyAll, setApplyAll] = useState(false);
  const following = (channels ?? []).filter((c) => c.follows_category).length;
  const custom = (channels ?? []).length - following;
  const accessChanged = !!category && !!rows && accessKey(accessBody(rows)) !== accessKey(category.access ?? []);
  const [name, setName] = useState(category?.name ?? "");
  // "" is no colour (the default grey); otherwise what's typed or picked.
  const [colour, setColour] = useState(category?.colour ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim().replace(/\s+/g, " ");
  const hex = /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : null;
  const ratio = hex ? nameContrast(hex) : 0;
  // The same contrast rule as name colours (the server checks it too).
  const colourOk = colour === "" || (!!hex && ratio >= MIN_NAME_CONTRAST);
  const valid = trimmed.length > 0 && [...trimmed].length <= 32 && colourOk;
  const labelChanged = !category || trimmed !== category.name || (hex ?? "") !== (category.colour ?? "");
  const dirty = labelChanged || accessChanged || applyAll;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      if (category) {
        if (labelChanged) {
          await call(`/api/v1/channel-categories/${category.id}`, {
            method: "PATCH", body: JSON.stringify({ name: trimmed, colour: hex ?? "" }),
          });
        }
        if ((accessChanged || applyAll) && rows) {
          await call(`/api/v1/channel-categories/${category.id}/access`, {
            method: "PUT", body: JSON.stringify({ access: accessBody(rows), apply_to_all: applyAll }),
          });
        }
      } else {
        await call("/api/v1/channel-categories", {
          method: "POST",
          body: JSON.stringify({ kind, name: trimmed, colour: hex ?? "", ...(rows ? { access: accessBody(rows) } : {}) }),
        });
      }
      onClose();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={category ? "Edit Category" : "Create Category"} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
            placeholder="Gaming" autoFocus required />
        </label>
        <div className="category-colour">
          <span>Colour</span>
          <div className="colour-row">
            <input type="color" value={hex ?? "#ffffff"} aria-label="Category colour"
              onChange={(e) => setColour(e.target.value)} />
            <input className="hex" value={colour} onChange={(e) => setColour(e.target.value.trim())} maxLength={7}
              spellCheck={false} placeholder="Default" aria-label="Colour as #rrggbb" />
            <span className="category-preview" style={hex ? { color: hex } : undefined}>
              ▾ {trimmed || "Category"}
            </span>
            <button type="button" className="secondary" disabled={colour === ""} onClick={() => setColour("")}>
              No Colour
            </button>
          </div>
          <p className={`small ${colour !== "" && !colourOk ? "error" : "muted"}`}>
            {colour === "" ? "Default grey. Pick a colour to make the heading stand out."
              : !hex ? "Type a colour as #rrggbb."
              : colourOk ? `Contrast ${ratio.toFixed(1)}:1 against the background. Readable.`
              : `Contrast ${ratio.toFixed(1)}:1 is too low (needs ${MIN_NAME_CONTRAST}:1). Pick a lighter colour.`}
          </p>
        </div>
        {groupsError && <p className="error">Couldn't load groups: {groupsError}</p>}
        {rows && <AccessEditor rows={rows} setRows={setRows} kind={kind} legend="Permissions"
          note={category
            ? <>
              {following === 0 ? "No channel in it uses these yet."
                : `${following} ${following === 1 ? "channel uses" : "channels use"} these (Same as category) and ${following === 1 ? "changes" : "change"} with them.`}
              {" "}Administrators can always see and use every channel.
            </>
            : <>Channels created in it use these unless set to Custom. Administrators can always see and use every channel.</>} />}
        {category && (
          <label className={`check${custom ? "" : " disabled"}`} title={custom ? undefined : "Every channel in it already uses these"}>
            <input type="checkbox" checked={applyAll} disabled={!custom} onChange={(e) => setApplyAll(e.target.checked)} />
            <span>
              Make all channels in this category use these
              <span className="muted small block">
                {custom
                  ? `${custom} ${custom === 1 ? "channel has" : "channels have"} Custom permissions; ${custom === 1 ? "it" : "they"} would be set to Same as category.`
                  : "Every channel in it already does."}
              </span>
            </span>
          </label>
        )}
        {!category && (
          <p className="muted small">
            A folder in {SECTION[kind]}. Drag channels onto its name to put them in it, or use Move to Category in a
            channel's menu.
          </p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          {category ? (
            <>
              <button type="submit" className="save" disabled={busy || !valid || !dirty}>{busy ? "Saving…" : "Save"}</button>
              <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="primary" disabled={busy || !valid}>{busy ? "Creating…" : "Create Category"}</button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** Delete a category; its channels move to the section's top level. */
export function DeleteCategoryDialog({ call, category, onClose }: {
  call: ApiCall;
  category: ChannelCategory;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/v1/channel-categories/${category.id}`, { method: "DELETE" });
      onClose();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }
  return (
    <Modal title="Delete Category" onClose={onClose}>
      <div className="modal-body">
        <p>
          Delete the category <strong>{category.name}</strong>? Its channels move to the top
          of {SECTION[category.kind]}. No channels or messages are deleted.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>Keep It</button>
          <button type="button" className="danger solid" onClick={() => void remove()} disabled={busy}>
            {busy ? "Deleting…" : "Delete Category"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** What a group may do, in words, for MoveAccessDialog. */
function levelOf(access: readonly { group_id: string; can_post: boolean }[], groupId: string, kind: Kind): string {
  const a = access.find((x) => x.group_id === groupId);
  if (!a) return "no access";
  if (kind === "voice") return a.can_post ? "join and speak" : "join";
  return a.can_post ? "view and post" : "view";
}

/** What changes for each group going from `from` to `to`. */
function accessChanges(from: readonly ChannelAccess[], to: readonly ChannelAccess[], kind: Kind) {
  const names = new Map<string, string>();
  for (const a of [...from, ...to]) names.set(a.group_id, a.group);
  return [...names].flatMap(([id, group]) => {
    const was = levelOf(from, id, kind);
    const now = levelOf(to, id, kind);
    return was === now ? [] : [{ group, was, now }];
  });
}

/** One choice's outcome: each group whose access changes, or "No changes". */
function ChangeList({ changes }: { changes: { group: string; was: string; now: string }[] }) {
  if (!changes.length) return <span className="muted small block">No changes: everyone keeps the access they have.</span>;
  return (
    <ul className="small access-changes">
      {changes.map((c) => <li key={c.group}><strong>{c.group}</strong>: {c.was} → {c.now}</li>)}
    </ul>
  );
}

/**
 * Asked before every move of a channel to another place (into, out of or
 * between categories; dragged or from Move to Category…): says what is
 * moving where, and what each permissions choice changes, even when it
 * changes nothing. Starts on what the channel does now: Same as category
 * takes the new category's, Custom keeps its own. Reordering within one
 * place doesn't ask (permissions can't change).
 */
export function MoveChannelDialog({ channel, from, to, onPick }: {
  channel: ChannelInfo;
  /** Where it is now; undefined: No Category. */
  from: ChannelCategory | undefined;
  /** Where it's going; undefined: No Category. */
  to: ChannelCategory | undefined;
  /** The move's extra fields, or null to cancel. */
  onPick: (choice: { keep_access?: boolean; follow_category?: boolean } | null) => void;
}) {
  const kind: Kind = channel.kind === "voice" ? "voice" : "text";
  const following = !!channel.follows_category;
  const [use, setUse] = useState(following && !!to);
  const label = `${kind === "text" ? "#" : ""}${channel.name}`;
  const fromName = from ? from.name : "No Category";
  const toName = to ? to.name : "No Category";
  const move = () => onPick(!to ? {} : use ? { follow_category: true } : { keep_access: true });
  return (
    <Modal title="Move Channel" onClose={() => onPick(null)}>
      <div className="modal-body">
        <p>Move <strong>{label}</strong> from <strong>{fromName}</strong> to <strong>{toName}</strong>.</p>
        {to ? (
          <div className="follow-pick" role="radiogroup" aria-label="Permissions">
            <span>Permissions</span>
            <label className="check">
              <input type="radio" name="move-perms" checked={use} onChange={() => setUse(true)} />
              <span>
                Use {to.name}'s permissions (Same as category)
                <ChangeList changes={accessChanges(channel.access, to.access ?? [], kind)} />
              </span>
            </label>
            <label className="check">
              <input type="radio" name="move-perms" checked={!use} onChange={() => setUse(false)} />
              <span>
                Keep its own permissions (Custom)
                <ChangeList changes={[]} />
              </span>
            </label>
          </div>
        ) : (
          <div className="follow-pick">
            <span>Permissions</span>
            <p className="small">
              It keeps the permissions it has now{following ? " and becomes Custom" : ""}.
              <span className="muted block">No changes: everyone keeps the access they have.</span>
            </p>
          </div>
        )}
        {to && use && channel.encrypted && accessChanges(channel.access, to.access ?? [], kind).length > 0 && (
          <p className="muted small">People who lose access are removed from the channel's encryption.</p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={() => onPick(null)}>Cancel</button>
          <button type="button" className="primary" autoFocus onClick={move}>Move</button>
        </div>
      </div>
    </Modal>
  );
}
