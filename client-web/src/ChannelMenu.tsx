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
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("touchstart", off);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

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
          <button key={i.label} role="menuitem" className={`menu-item${i.danger ? " danger" : ""}`}
            disabled={i.disabled} title={i.disabled ? i.reason : undefined}
            onClick={() => {
              onClose();
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

/**
 * Handlers for the channel buttons: right-click, or a long press on a
 * touchscreen, calls open with the channel and where to put the menu.
 * The tap that ends a long press doesn't also click the button: onTouchEnd
 * cancels it, and onClick handlers should check consumeLongPress() for
 * browsers that click anyway. One press at a time, so one hook serves
 * every row.
 */
export function useMenuTrigger(open: (id: string, at: { x: number; y: number }) => void) {
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
  };
  const handlers = (id: string) => ({
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      // A long press on some touch browsers also sends contextmenu.
      if (press.current?.fired) return;
      open(id, { x: e.clientX, y: e.clientY });
    },
    onTouchStart: (e: ReactTouchEvent) => {
      cancel();
      const t = e.touches[0];
      const p = {
        x: t.clientX,
        y: t.clientY,
        fired: false,
        timer: window.setTimeout(() => {
          p.fired = true;
          navigator.vibrate?.(10);
          open(id, { x: p.x, y: p.y });
        }, LONG_PRESS_MS),
      };
      press.current = p;
    },
    onTouchMove: (e: ReactTouchEvent) => {
      const p = press.current;
      const t = e.touches[0];
      if (p && Math.hypot(t.clientX - p.x, t.clientY - p.y) > LONG_PRESS_SLOP) cancel();
    },
    onTouchEnd: (e: ReactTouchEvent) => {
      cancel();
      if (press.current?.fired) e.preventDefault();
    },
    onTouchCancel: cancel,
  });
  /** True if the click being handled ended a long press (then ignore it). */
  const consumeLongPress = () => {
    const fired = !!press.current?.fired;
    press.current = null;
    return fired;
  };
  return { handlers, consumeLongPress };
}
