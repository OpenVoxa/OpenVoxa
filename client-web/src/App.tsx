// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import type { BackupStatus } from "@core/recovery";
import { call, type Session } from "./api";
import { loadSession, saveSession } from "./session";
import { Login } from "./Login";
import { BackupManager, markAskedForKey, wasAskedForKey } from "./backup";
import { RecoveryRestore, RecoverySetup } from "./Recovery";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  // Only true right after "Create account" in this tab: the recovery key
  // is then part of signup, with no "Not now".
  const [justRegistered, setJustRegistered] = useState(false);

  function update(s: Session | null, registered = false) {
    saveSession(s);
    setSession(s);
    setJustRegistered(registered);
  }

  if (!session) return <Login onSession={update} />;
  return <Home key={session.user_id} session={session} justRegistered={justRegistered}
    onLoggedOut={() => update(null)} />;
}

type Phase =
  | { k: "loading" }
  | { k: "failed"; error: string }
  | { k: "setup"; skippable: boolean; replacing: boolean }
  | { k: "restore" }
  | { k: "ready" };

function Home({ session, justRegistered, onLoggedOut }: {
  session: Session;
  justRegistered: boolean;
  onLoggedOut: () => void;
}) {
  const [manager, setManager] = useState<BackupManager | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Decide which recovery screen, if any, this sign-in needs.
  useEffect(() => {
    let live = true;
    (async () => {
      const m = await BackupManager.open(session.user_id, session.token);
      m.onLocked = () => setPhase({ k: "restore" });
      const s = await m.status();
      if (!live) return;
      setManager(m);
      setStatus(s);
      if (!s) {
        if (justRegistered) setPhase({ k: "setup", skippable: false, replacing: false });
        else if (!wasAskedForKey(session.user_id)) setPhase({ k: "setup", skippable: true, replacing: false });
        else setPhase({ k: "ready" });
      } else {
        setPhase(s.unlocked ? { k: "ready" } : { k: "restore" });
      }
    })().catch((err) => live && setPhase({ k: "failed", error: String(err?.message ?? err) }));
    return () => {
      live = false;
    };
  }, [session.user_id, session.token, justRegistered]);

  async function refresh(note?: string) {
    if (note !== undefined) setNotice(note);
    if (manager) setStatus(await manager.status().catch(() => status));
    setPhase({ k: "ready" });
  }

  async function backUpNow() {
    if (!manager) return;
    setBusy("Backing up…");
    try {
      await manager.uploadNow();
      await refresh("Backed up.");
    } catch (err) {
      setNotice(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    // Signing out will wipe this device's message archive, so the backup
    // has to be current first. uploadNow() skips when there is no backup.
    if (manager) {
      setBusy("Backing up before signing out…");
      try {
        await manager.uploadNow();
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        if (!confirm(`Your history couldn't be backed up (${why}).\n\nLog out anyway?`)) {
          setBusy(null);
          return;
        }
      }
      manager.close();
    }
    // Clear locally even if the server call fails: a dead token is harmless.
    try {
      await call("/api/v1/auth/logout", { method: "POST", token: session.token });
    } catch {
      /* ignore */
    }
    onLoggedOut();
  }

  if (phase.k === "loading") {
    return <div className="auth-page"><p className="muted">Loading…</p></div>;
  }
  if (phase.k === "failed") {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Something went wrong</h1>
          <p className="error">{phase.error}</p>
          <button className="primary" onClick={() => location.reload()}>Try again</button>
        </div>
      </div>
    );
  }
  if (phase.k === "setup" && manager) {
    return (
      <RecoverySetup
        manager={manager}
        replacing={phase.replacing}
        onDone={() => { markAskedForKey(session.user_id); void refresh("Recovery key saved and history backed up."); }}
        onSkip={phase.skippable ? () => { markAskedForKey(session.user_id); void refresh(); } : undefined}
      />
    );
  }
  if (phase.k === "restore" && manager) {
    return (
      <RecoveryRestore
        manager={manager}
        onDone={(summary) => void refresh(summary)}
        onSkip={() => void refresh("Not backing up from this device until you enter your recovery key.")}
        onLostKey={() => setPhase({ k: "setup", skippable: false, replacing: true })}
      />
    );
  }

  // Placeholder home until the text UI (M2).
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>OpenVoxa</h1>
        <p>Logged in as <strong>{session.username}</strong></p>
        <p className="muted">Groups: {session.groups.map((g) => g.name).join(", ") || "none"}</p>

        <div className="panel-row">
          <strong>History backup</strong>
          {!status && (
            <>
              <span className="muted">No recovery key yet.</span>
              <button className="link" onClick={() => setPhase({ k: "setup", skippable: true, replacing: false })}>
                Set one up
              </button>
            </>
          )}
          {status && !status.unlocked && (
            <>
              <span className="muted">This device isn't backing up.</span>
              <button className="link" onClick={() => setPhase({ k: "restore" })}>Enter recovery key</button>
            </>
          )}
          {status?.unlocked && (
            <>
              <span className="muted">
                Last saved {new Date(status.updatedAt).toLocaleString()} ({Math.max(1, Math.round(status.totalBytes / 1024))} KB)
              </span>
              <button className="link" onClick={backUpNow} disabled={!!busy}>Back up now</button>
            </>
          )}
        </div>
        {notice && <p className="muted" role="status">{notice}</p>}

        <p className="muted">The new client is under construction. Chat still lives in the debug page.</p>
        <a href="/debug/chat.html">Open the debug page</a>
        <button className="primary" onClick={logout} disabled={!!busy}>{busy ?? "Log out"}</button>
      </div>
    </div>
  );
}
