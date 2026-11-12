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

import { useCallback, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent } from "react";
import type { ChannelCategory, ChannelInfo } from "@core/chat";
import { localStore } from "./core";
import { Modal } from "./ChannelDialogs";
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

type Dragged =
  | { what: "channel"; id: string; kind: Kind }
  | { what: "category"; id: string; kind: Kind };

/** Where a drop would land: a line above or below a row, or into a category. */
export type DropHint = { key: string; where: "before" | "after" | "into" } | null;

export interface DropProps {
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}
export interface DragProps {
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
}

function half(e: DragEvent): "before" | "after" {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? "before" : "after";
}

/** The id after `id` in list, skipping `skip`; null at the end. */
function nextAfter<T extends { id: string }>(list: readonly T[], id: string, skip: string): string | null {
  const rest = list.filter((x) => x.id !== skip);
  const i = rest.findIndex((x) => x.id === id);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1].id : null;
}

/**
 * Drag-to-reorder for the sidebar. Only for manage_channels (enabled
 * false: every prop is inert). Moves go to the server, which tells
 * everyone (channel_layout_changed); the list then refetches.
 */
export function useLayoutDrag(call: ApiCall, enabled: boolean,
  onError: (title: string, err: unknown, at: { x: number; y: number }) => void) {
  const dragged = useRef<Dragged | null>(null);
  const [hint, setHint] = useState<DropHint>(null);

  const send = useCallback((path: string, body: object, title: string, at: { x: number; y: number }) => {
    call(path, { method: "POST", body: JSON.stringify(body) }).catch((err) => onError(title, err, at));
  }, [call, onError]);

  const show = (key: string, where: "before" | "after" | "into") => {
    setHint((h) => (h && h.key === key && h.where === where ? h : { key, where }));
  };
  const leave = (key: string) => (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHint((h) => (h?.key === key ? null : h));
  };
  const ours = (e: DragEvent) => e.dataTransfer.types.includes(LAYOUT_DRAG_TYPE);
  const take = (e: DragEvent) => {
    e.preventDefault();
    setHint(null);
    const d = dragged.current;
    dragged.current = null;
    return { d, at: { x: e.clientX, y: e.clientY } };
  };

  const dragFor = (item: Dragged): DragProps => ({
    draggable: enabled,
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

  /** A channel row: another channel of its kind lands above or below it. */
  const channelDrop = (c: ChannelInfo, scope: readonly ChannelInfo[]): DropProps => !enabled ? none : {
    onDragOver: (e) => {
      const d = dragged.current;
      if (!ours(e) || !d || d.what !== "channel" || d.kind !== c.kind || d.id === c.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      show(c.id, half(e));
    },
    onDragLeave: leave(c.id),
    onDrop: (e) => {
      if (!ours(e)) return;
      const where = half(e);
      const { d, at } = take(e);
      if (!d || d.what !== "channel" || d.kind !== c.kind || d.id === c.id) return;
      const before = where === "before" ? c.id : nextAfter(scope, c.id, d.id);
      send(`/api/v1/channels/${d.id}/move`, { category_id: c.category_id ?? null, before_id: before },
        "Couldn't move the channel", at);
    },
  };

  /**
   * A category header: a channel dropped on it goes in at the end; a
   * category lands above or below it.
   */
  const categoryDrop = (cat: ChannelCategory, cats: readonly ChannelCategory[]): DropProps => !enabled ? none : {
    onDragOver: (e) => {
      const d = dragged.current;
      if (!ours(e) || !d || d.kind !== cat.kind || d.id === cat.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      show(cat.id, d.what === "channel" ? "into" : half(e));
    },
    onDragLeave: leave(cat.id),
    onDrop: (e) => {
      if (!ours(e)) return;
      const where = half(e);
      const { d, at } = take(e);
      if (!d || d.kind !== cat.kind || d.id === cat.id) return;
      if (d.what === "channel") {
        send(`/api/v1/channels/${d.id}/move`, { category_id: cat.id, before_id: null }, "Couldn't move the channel", at);
      } else {
        const before = where === "before" ? cat.id : nextAfter(cats, cat.id, d.id);
        send(`/api/v1/channel-categories/${d.id}/move`, { before_id: before }, "Couldn't move the category", at);
      }
    },
  };

  /** The section heading: a channel dropped on it goes to the end of the top level. */
  const sectionDrop = (kind: Kind): DropProps => !enabled ? none : {
    onDragOver: (e) => {
      const d = dragged.current;
      if (!ours(e) || !d || d.what !== "channel" || d.kind !== kind) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      show(`section-${kind}`, "into");
    },
    onDragLeave: leave(`section-${kind}`),
    onDrop: (e) => {
      if (!ours(e)) return;
      const { d, at } = take(e);
      if (!d || d.what !== "channel" || d.kind !== kind) return;
      send(`/api/v1/channels/${d.id}/move`, { category_id: null, before_id: null }, "Couldn't move the channel", at);
    },
  };

  const hintClass = (key: string) => (hint?.key === key ? ` drop-${hint.where}` : "");

  return {
    hintClass,
    channelDrag: (c: ChannelInfo) => dragFor({ what: "channel", id: c.id, kind: c.kind as Kind }),
    categoryDrag: (cat: ChannelCategory) => dragFor({ what: "category", id: cat.id, kind: cat.kind }),
    channelDrop,
    categoryDrop,
    sectionDrop,
  };
}

/** Both sets of drop handlers on one element (voice rows also take dragged people). */
export function mergeDrop(a: Partial<DropProps>, b: Partial<DropProps>): DropProps {
  return {
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

/** Create a category in a section, or edit one's name and colour. */
export function CategoryDialog({ call, kind, category, onClose }: {
  call: ApiCall;
  kind: Kind;
  /** Set: edit this one. */
  category?: ChannelCategory;
  onClose: () => void;
}) {
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
  const dirty = !category || trimmed !== category.name || (hex ?? "") !== (category.colour ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      if (category) {
        await call(`/api/v1/channel-categories/${category.id}`, {
          method: "PATCH", body: JSON.stringify({ name: trimmed, colour: hex ?? "" }),
        });
      } else {
        await call("/api/v1/channel-categories", {
          method: "POST", body: JSON.stringify({ kind, name: trimmed, colour: hex ?? "" }),
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
        {!category && (
          <p className="muted small">
            A folder in {SECTION[kind]}. Drag channels onto its name to put them in it. It has no permissions of
            its own: each channel keeps its own.
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
