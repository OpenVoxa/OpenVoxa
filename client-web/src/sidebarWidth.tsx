// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel sidebar's width, set by dragging its right edge (decisions.md
 * Feature decisions, "Resizable sidebar"). Kept per browser in localStorage,
 * like the other layout settings: each desktop app server view and each
 * browser remembers its own. Double-click the edge to go back to 240 px.
 *
 * The width is a CSS variable on `.app` (--sidebar-width) so the narrow
 * screen rule in styles.css can still override it.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { localStore } from "./core";

const KEY = "layout.sidebarWidth";
export const SIDEBAR_DEFAULT = 240;
const MIN = 200;
const MAX = 480;
const STEP = 16; // arrow keys

function clamp(w: number): number {
  return Math.round(Math.min(MAX, Math.max(MIN, w)));
}

function load(): number {
  const n = Number(localStore.get(KEY));
  return Number.isFinite(n) && n > 0 ? clamp(n) : SIDEBAR_DEFAULT;
}

/** The current width and a setter that also saves it. */
export function useSidebarWidth(): [number, (w: number, save: boolean) => void] {
  const [width, setWidth] = useState(load);
  const set = useCallback((w: number, save: boolean) => {
    const c = clamp(w);
    setWidth(c);
    if (save) localStore.set(KEY, String(c));
  }, []);
  return [width, set];
}

/**
 * The drag handle on the sidebar's right edge. A focusable separator, so
 * the arrow keys resize it too (Home resets).
 */
export function SidebarResizer({ width, onWidth }: {
  width: number;
  onWidth: (w: number, save: boolean) => void;
}) {
  const drag = useRef<{ startX: number; startW: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // While dragging, keep the resize cursor and stop text from being
  // selected even when the pointer is over the chat or the stage.
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("resizing-sidebar");
    return () => document.body.classList.remove("resizing-sidebar");
  }, [dragging]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startW: width, last: width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = d.startW + e.clientX - d.startX;
    onWidth(d.last, false);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    onWidth(d.last, true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") onWidth(width - STEP, true);
    else if (e.key === "ArrowRight") onWidth(width + STEP, true);
    else if (e.key === "Home") onWidth(SIDEBAR_DEFAULT, true);
    else return;
    e.preventDefault();
  };

  return (
    <div className={dragging ? "sidebar-resizer dragging" : "sidebar-resizer"}
      role="separator" aria-orientation="vertical" aria-label="Resize sidebar"
      aria-valuemin={MIN} aria-valuemax={MAX} aria-valuenow={width} tabIndex={0}
      title="Drag to resize; double-click to reset"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onDoubleClick={() => onWidth(SIDEBAR_DEFAULT, true)} onKeyDown={onKeyDown} />
  );
}
