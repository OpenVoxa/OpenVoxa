// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import type { BackupStatus } from "@core/recovery";
import { call, type Session } from "./api";
import { loadSession, saveSession } from "./session";
import { Login } from "./Login";
import { BackupManager, markAskedForKey, wasAskedForKey } from "./backup";
import { RecoveryRestore, RecoverySetup } from "./Recovery";
import { ChatApp } from "./ChatApp";
import type { Chat } from "@core/chat";
import { dropCryptoSession } from "./core";

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
      m.onUploaded = () => {
        m.status().then((s) => live && setStatus(s), () => {});
      };
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

  /**
   * Sign out. client-web owns this browser's device for the account, so
   * signing out also revokes the device and wipes its keys and message
   * archive, like the debug page's "Forget device". The backup is
   * uploaded first; the next sign-in restores from it with the recovery
   * key.
   */
  async function logout(chat: Chat | null) {
    if (!manager) return;
    setBusy("Backing up before signing out…");
    const s = await manager.status().catch(() => null);
    if (!s?.unlocked) {
      const why = !s
        ? "You have no recovery key, so your encrypted message history isn't backed up."
        : "This device isn't backing up (it needs your recovery key).";
      if (!confirm(`${why}\n\nSigning out erases it from this browser for good. Sign out anyway?`)) {
        setBusy(null);
        return;
      }
    } else {
      try {
        await manager.uploadNow();
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        if (!confirm(`Your history couldn't be backed up (${why}).\n\nSigning out erases it from this browser. Sign out anyway?`)) {
          setBusy(null);
          return;
        }
      }
    }
    manager.close();

    setBusy("Signing out…");
    if (chat) {
      try {
        await chat.forgetDevice();
        dropCryptoSession(session.user_id);
      } catch (err) {
        // The server still lists the device: wiping its keys now would
        // leave members adding a device nobody holds. Keep them; the next
        // sign-in in this browser uses the same device.
        chat.close();
        console.warn("could not revoke this device; keeping its keys:", err);
      }
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

  if (!manager) return null;
  return (
    <ChatApp
      session={session}
      manager={manager}
      backup={status}
      notice={notice}
      busy={busy}
      onLogout={(chat) => void logout(chat)}
      onBackUpNow={backUpNow}
      onSetUpKey={() => setPhase({ k: "setup", skippable: true, replacing: false })}
      onEnterKey={() => setPhase({ k: "restore" })}
      onExpired={onLoggedOut}
    />
  );
}
