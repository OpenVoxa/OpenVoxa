// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The tab column of Settings and Server settings (decisions.md Feature
 * decisions, "Settings layout"): tabs in a column on the left, the open
 * tab on a stage to the right that scrolls on its own, with the tab's
 * footer (Save bottom left, Done) under the stage. On narrow screens
 * (styles.css) the tabs go back to the top and wrap onto rows, and the
 * headings hide.
 *
 * Children are what used to follow the tab row: a .modal-body plus a
 * .modal-foot, or a tab that draws both itself.
 */

import type { ReactNode } from "react";

export type NavItem<T extends string> =
  | { id: T; label: string }
  /** A small heading above a block of tabs; colour: its role's name colour. */
  | { heading: string; colour?: string };

export function SettingsLayout<T extends string>({ items, tab, onTab, label, children }: {
  items: NavItem<T>[];
  tab: T;
  onTab: (t: T) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-layout">
      <div className="settings-nav" role="tablist" aria-label={label}>
        {items.map((it) => "heading" in it
          ? (
            <div key={`h:${it.heading}`} className="settings-nav-head" role="presentation"
              style={it.colour ? { color: it.colour } : undefined}>{it.heading}</div>
          )
          : (
            <button key={it.id} role="tab" aria-selected={tab === it.id} className={tab === it.id ? "on" : undefined}
              onClick={() => onTab(it.id)}>{it.label}</button>
          ))}
      </div>
      <div className="settings-stage">{children}</div>
    </div>
  );
}
