// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The right-click menu on a channel in the sidebar (decisions.md Feature
 * decisions, "Channel menus"). On touchscreens a long press opens it.
 * Entries someone can't use are greyed out, not hidden.
 */

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Why it is greyed out, shown on hover. */
  reason?: string;
  danger?: boolean;
  /** Leave the menu open after a click (Move Up / Move Down, pressed a few times in a row). */
  keepOpen?: boolean;
}

export function ChannelMenu({ title, at, items, onClose }: {
  title: string;
  at: { x: number; y: number };
  items: (MenuItem | "sep")[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", off);
    window.addEventListener("touchstart", off);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("touchstart", off);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  // Focus the first entry on opening only: a menu that stays open
  // (keepOpen) re-renders, and focus shouldn't jump back to the top.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  const height = 44 + items.reduce((n, i) => n + (i === "sep" ? 9 : 32), 0);
  const left = Math.max(4, Math.min(at.x, window.innerWidth - 234));
  const top = Math.max(4, Math.min(at.y, window.innerHeight - height - 4));
  return (
    <div ref={ref} className="menu channel-menu" style={{ left, top }} role="menu" aria-label={title}
      onContextMenu={(e) => e.preventDefault()}>
      <strong className="channel-menu-title">{title}</strong>
      {items.map((i, n) => i === "sep"
        ? <div key={n} className="menu-sep" role="separator" />
        : (
          <button key={n} role="menuitem" className={`menu-item${i.danger ? " danger" : ""}`}
            disabled={i.disabled} title={i.disabled ? i.reason : undefined}
            onClick={() => {
              if (!i.keepOpen) onClose();
              i.onClick();
            }}>
            {i.label}
          </button>
        ))}
    </div>
  );
}

/** How long a finger has to stay down to open the menu, and how far it may drift. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
/** A click this soon after a touch we handled ourselves is the browser's copy of it. */
const TOUCH_CLICK_MS = 800;

type Point = { x: number; y: number };

/**
 * Dragging with a finger (the sidebar's channels and categories): a long
 * press, then moving the finger, picks the row up. HTML drag and drop
 * doesn't work on touchscreens, so this runs on touch events.
 */
export interface TouchDrag {
  /** The finger moved after a long press. false: this row can't be dragged (it stays a menu). */
  start: (id: string, at: Point) => boolean;
  move: (at: Point) => void;
  /** The finger lifted at `at`; null: the touch was cancelled. */
  end: (at: Point | null) => void;
}

/**
 * Handlers for the sidebar's buttons. With a mouse: right-click opens the
 * menu, a click is a click. With a finger:
 *   - a tap calls onTap at once (the browser's own click isn't waited
 *     for: on a draggable row some browsers never send it);
 *   - a long press opens the menu, which stays open when the finger lifts;
 *   - a long press, then moving the finger, closes the menu and drags the
 *     row (when `drag` is given and allows it);
 *   - moving before the long press is a scroll, and nothing happens.
 * onClick handlers should start with `if (touchHandled()) return;` so the
 * browser's click after a touch doesn't act twice. One press at a time,
 * so one hook serves every row.
 */
export function useMenuTrigger(open: (id: string, at: Point) => void, drag?: TouchDrag) {
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const press = useRef<{
    id: string; x: number; y: number; timer: number;
    fired: boolean; moved: boolean; dragging: boolean;
    listen: (e: TouchEvent) => void;
  } | null>(null);
  const handledAt = useRef(0);

  const finish = () => {
    const p = press.current;
    if (!p) return null;
    clearTimeout(p.timer);
    window.removeEventListener("touchmove", p.listen);
    press.current = null;
    return p;
  };
  // A press still running when the sidebar unmounts.
  useEffect(() => () => {
    const p = finish();
    if (p?.dragging) dragRef.current?.end(null);
  }, []);

  const handlers = (id: string, onTap?: () => void) => ({
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      // A long press on some touch browsers also sends contextmenu.
      if (press.current?.fired || Date.now() - handledAt.current < TOUCH_CLICK_MS) return;
      open(id, { x: e.clientX, y: e.clientY });
    },
    onTouchStart: (e: ReactTouchEvent) => {
      const old = finish();
      if (old?.dragging) dragRef.current?.end(null);
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      // React's touchmove is passive (can't stop scrolling), so this one
      // is the window's own, only for the length of the press.
      const listen = (ev: TouchEvent) => {
        const p = press.current;
        const f = ev.touches[0];
        if (!p || !f) return;
        const at = { x: f.clientX, y: f.clientY };
        const far = Math.hypot(at.x - p.x, at.y - p.y) > LONG_PRESS_SLOP;
        if (!p.fired) {
          // Moving first is a scroll: let the browser have it.
          if (far) {
            p.moved = true;
            clearTimeout(p.timer);
            window.removeEventListener("touchmove", p.listen);
          }
          return;
        }
        // Held: the page mustn't scroll under the finger.
        if (ev.cancelable) ev.preventDefault();
        if (!p.dragging && far) p.dragging = !!dragRef.current?.start(p.id, at);
        if (p.dragging) dragRef.current?.move(at);
      };
      const p = {
        id, x: t.clientX, y: t.clientY, fired: false, moved: false, dragging: false, listen,
        timer: window.setTimeout(() => {
          p.fired = true;
          navigator.vibrate?.(10);
          open(id, { x: p.x, y: p.y });
        }, LONG_PRESS_MS),
      };
      press.current = p;
      window.addEventListener("touchmove", listen, { passive: false });
    },
    onTouchEnd: (e: ReactTouchEvent) => {
      const p = finish();
      if (!p) return;
      const t = e.changedTouches[0];
      if (p.dragging) {
        e.preventDefault();
        handledAt.current = Date.now();
        dragRef.current?.end(t ? { x: t.clientX, y: t.clientY } : null);
      } else if (p.fired) {
        // The menu is open; the lift mustn't also click.
        e.preventDefault();
        handledAt.current = Date.now();
      } else if (!p.moved && onTap) {
        e.preventDefault();
        handledAt.current = Date.now();
        onTap();
      }
    },
    onTouchCancel: () => {
      const p = finish();
      if (p?.dragging) dragRef.current?.end(null);
    },
  });
  /** True if the click being handled is the browser's copy of a touch already acted on. */
  const touchHandled = () => Date.now() - handledAt.current < TOUCH_CLICK_MS;
  return { handlers, touchHandled };
}
