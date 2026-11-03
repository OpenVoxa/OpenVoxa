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
import { forgetIdentity } from "@core/index";
import { apiCall, cryptoSession, dropCryptoSession } from "./core";
import { lockStorage, unlockOnRefresh } from "./unlock";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  // Only true right after "Create account" in this tab: the recovery key
  // is then part of signup, with no "Not now".
  const [justRegistered, setJustRegistered] = useState(false);
  // A note for the next screen: after sign-in for Home, after a forced
  // sign-out for the login page.
  const [note, setNote] = useState<string | null>(null);

  function update(s: Session | null, registered = false, message?: string) {
    // Signed out for any reason: the unlocked storage key goes too.
    if (!s) lockStorage();
    saveSession(s);
    setSession(s);
    setJustRegistered(registered);
    setNote(message ?? null);
  }

  if (!session) return <Login onSession={update} notice={note} />;
  return <Home key={session.user_id} session={session} justRegistered={justRegistered}
    initialNotice={note}
    onLoggedOut={() => update(null)}
    onLocked={() => {
      // The refresh could not unlock storage (session ended, or this tab
      // predates encryption). End the session; the password unlocks.
      void call("/api/v1/auth/logout", { method: "POST", token: session.token }).catch(() => {});
      update(null, false, "Sign in again to unlock this browser's encrypted storage.");
    }} />;
}

type Phase =
  | { k: "loading" }
  | { k: "failed"; error: string }
  | { k: "setup"; skippable: boolean; replacing: boolean; rotating?: boolean }
  | { k: "restore" }
  | { k: "ready" };

function Home({ session, justRegistered, initialNotice, onLoggedOut, onLocked }: {
  session: Session;
  justRegistered: boolean;
  initialNotice: string | null;
  onLoggedOut: () => void;
  onLocked: () => void;
}) {
  const [manager, setManager] = useState<BackupManager | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  // Shown on the recovery-key screen instead of its usual text.
  const [restoreReason, setRestoreReason] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Decide which recovery screen, if any, this sign-in needs.
  useEffect(() => {
    let live = true;
    (async () => {
      // Signed in just now: Login already unlocked. Refreshed: unlock from
      // the tab's session copy, or sign in again.
      if (!(await unlockOnRefresh(session))) {
        if (live) onLocked();
        return;
      }
      // Start this browser's device before choosing a recovery screen. A
      // device that was revoked (unused for 30 days, or removed in
      // Settings, Devices) is wiped and replaced here, which drops its
      // backup key, so the status below asks for the recovery key.
      // ChatApp reuses this same session (cryptoSession caches it).
      const crypto = await cryptoSession(session.user_id, apiCall(session.token, onLoggedOut));
      const m = await BackupManager.open(session.user_id, session.token);
      m.onLocked = () => setPhase({ k: "restore" });
      m.onUploaded = () => {
        m.status().then((s) => live && setStatus(s), () => {});
      };
      const s = await m.status();
      if (!live) return;
      if (crypto.status.replaced) {
        if (s) {
          setRestoreReason("This browser was removed from your devices, or wasn't used for 30 days, " +
            "so it has been set up again. Enter your 12 words to bring your message history back.");
        } else {
          setNotice("This browser was removed from your devices, or wasn't used for 30 days, so it " +
            "has been set up again. With no recovery backup, earlier encrypted history can't be brought back.");
        }
      }
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
   * Sign out. The device stays: its keys, groups and message archive stay
   * in this browser, encrypted under the password, and the next sign-in
   * here unlocks them with the password alone (decided by Ryan,
   * 2026-11-03). The recovery key is needed only once the device is
   * revoked: unused for 30 days (server expiry) or removed in Settings,
   * Devices. Identity.start then wipes this browser and registers anew.
   *
   * The backup is still uploaded first, quietly: it is what other
   * devices restore from.
   */
  async function logout(chat: Chat | null) {
    if (!manager) return;
    setBusy("Signing out…");
    try {
      await manager.uploadNow();
    } catch (err) {
      console.warn("backup before sign-out failed:", err);
    }
    manager.close();
    chat?.close();
    dropCryptoSession(session.user_id);
    // Clear locally even if the server call fails: a dead token is harmless.
    try {
      await call("/api/v1/auth/logout", { method: "POST", token: session.token });
    } catch {
      /* ignore */
    }
    onLoggedOut();
  }

  /**
   * Delete the account (Settings, Account). The server erases it first;
   * only then is this browser wiped, so a refusal (wrong password, the
   * last-two-administrators rule) leaves everything as it was. There is
   * no device to revoke afterwards: deleting the account removed it.
   */
  async function deleteAccount(chat: Chat, password: string) {
    await call("/api/v1/me", { method: "DELETE", token: session.token, body: { password } });
    manager?.close();
    chat.close();
    try {
      await forgetIdentity();
    } catch (err) {
      console.warn("could not wipe this browser's keys:", err);
    }
    dropCryptoSession(session.user_id);
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
        rotating={phase.rotating}
        onDone={() => { markAskedForKey(session.user_id); void refresh(phase.rotating ? "New recovery key saved; the old one no longer works." : "Recovery key saved and history backed up."); }}
        onSkip={phase.skippable ? () => { markAskedForKey(session.user_id); void refresh(); } : undefined}
      />
    );
  }
  if (phase.k === "restore" && manager) {
    return (
      <RecoveryRestore
        manager={manager}
        onDone={(summary) => { setRestoreReason(null); void refresh(summary); }}
        onSkip={() => { setRestoreReason(null); void refresh("Not backing up from this device until you enter your recovery key."); }}
        onLostKey={() => setPhase({ k: "setup", skippable: false, replacing: true })}
        reason={restoreReason}
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
      onNewKey={() => setPhase({ k: "setup", skippable: true, replacing: true, rotating: true })}
      onDeleteAccount={deleteAccount}
      onExpired={onLoggedOut}
    />
  );
}
