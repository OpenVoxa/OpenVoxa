// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Home page and community rules (server home.go; decisions.md
 * Feature decisions, "Home page and community rules").
 *
 * Home: the banner, the administrators' Welcome text and the Rules, all
 * in the same markdown as messages. Opened from the Home item at the top
 * of the channel list; you land on it when an administrator changed it
 * since you last looked (a dot on Home until you do).
 *
 * The rules screen (RulesGate) replaces the whole app while the server
 * enforces its rules and this account hasn't accepted the current ones.
 * The server refuses everything else meanwhile (rules_acceptance_required).
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ApiCall } from "@core/identity";
import { call as plainCall, type Session } from "./api";
import { Markdown } from "./markdown";
import { AuthHeading, useServerInfo } from "./serverInfo";
import { iconLetter } from "./GeneralTab";

export interface HomeInfo {
  welcome: string;
  rules: string;
  /** Goes up with every change to the welcome, rules or banner. */
  version: number;
  /** The version this account last opened. */
  seen_version: number;
  /** A path on this server, with the version in it, or null. */
  banner: string | null;
  rules_enforced: boolean;
  rules_version: number;
  rules_accepted_version: number;
}

let home: HomeInfo | null = null;
let api: ApiCall | null = null;
const listeners = new Set<() => void>();

function set(next: HomeInfo | null): void {
  home = next;
  for (const l of listeners) l();
}

/** ChatApp hands over its request function once signed in. */
export function configureHome(call: ApiCall): () => void {
  api = call;
  void refreshHome();
  return () => {
    if (api === call) {
      api = null;
      set(null);
    }
  };
}

/** Fetch Home again (after home_changed, or a socket reconnect). */
export async function refreshHome(): Promise<void> {
  const call = api;
  if (!call) return;
  try {
    const h = (await call("/api/v1/home")) as HomeInfo;
    if (api === call) set(h);
  } catch {
    /* keep what is shown */
  }
}

/** Home is open and in view: it counts as seen up to its version. */
export function markHomeSeen(): void {
  const call = api;
  if (!call || !home || home.seen_version >= home.version) return;
  const version = home.version;
  set({ ...home, seen_version: version });
  void call("/api/v1/home/seen", { method: "POST", body: JSON.stringify({ version }) }).catch(() => {});
}

/** null until the first fetch answers. */
export function useHome(): HomeInfo | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => home,
  );
}

/** The Home item's own icon: the server icon, else its letter. */
export function HomeIcon() {
  const { name, icon } = useServerInfo();
  return (
    <span className="home-icon" aria-hidden>
      {icon ? <img src={icon} alt="" /> : iconLetter(name)}
    </span>
  );
}

/** The page in the main pane. */
export function HomePane({ isAdmin, onEdit }: { isAdmin: boolean; onEdit: () => void }) {
  const h = useHome();
  const { name } = useServerInfo();
  const empty = h && !h.banner && !h.welcome && !h.rules;
  return (
    <div className="channel-pane home-pane">
      <header className="pane-head">
        <h1>{name || "Home"}</h1>
        {isAdmin && (
          <button className="outline home-edit" onClick={onEdit} title="Server settings, General">
            Edit Home
          </button>
        )}
      </header>
      <div className="home-scroll">
        <article className="home-body">
          {!h ? <p className="muted">Loading…</p> : (
            <>
              {h.banner && <img className="home-banner" src={h.banner} alt="" />}
              {h.welcome && <div className="home-text"><Markdown text={h.welcome} /></div>}
              {h.rules && (
                <section className="home-rules" aria-label="Rules">
                  <h2>Rules</h2>
                  <div className="home-text"><Markdown text={h.rules} /></div>
                </section>
              )}
              {empty && (
                <p className="muted">
                  Nothing here yet.
                  {isAdmin && " Add a banner, a welcome and the rules in Server settings, General."}
                </p>
              )}
            </>
          )}
        </article>
      </div>
    </div>
  );
}

/**
 * The rules screen at sign-in: banner, server heading, the rules, and
 * Accept or Sign out. Uses the plain request function: the app (and its
 * crypto session) hasn't started yet.
 */
export function RulesGate({ session, onDone, onSignOut }: {
  session: Session;
  onDone: () => void;
  onSignOut: () => void;
}) {
  const [h, setH] = useState<HomeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setH(await plainCall<HomeInfo>("/api/v1/home", { token: session.token }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), []);

  async function accept() {
    if (!h) return;
    setBusy(true);
    setError(null);
    try {
      await plainCall("/api/v1/home/accept-rules", {
        method: "POST", token: session.token, body: { version: h.rules_version },
      });
      onDone();
    } catch (err) {
      // 409: changed while being read. Show the new ones.
      setError(err instanceof Error ? err.message : String(err));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const changed = !!h && h.rules_accepted_version > 0;
  return (
    <div className="auth-page">
      <div className="auth-card wide rules-card">
        <AuthHeading />
        <h2 className="rules-title">{changed ? "The Rules Have Changed" : "Server Rules"}</h2>
        <p className="muted small rules-intro">
          {changed
            ? "Please read the updated rules and accept them to carry on."
            : "This server asks everyone to accept its rules before joining in."}
        </p>
        {h ? <div className="rules-box"><Markdown text={h.rules} /></div> : !error && <p className="muted">Loading…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" onClick={() => void accept()} disabled={busy || !h}>
          {busy ? "Accepting…" : "Accept the Rules"}
        </button>
        <button className="link" onClick={onSignOut} disabled={busy}>Sign out</button>
      </div>
    </div>
  );
}
