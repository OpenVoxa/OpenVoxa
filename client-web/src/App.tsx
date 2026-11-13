// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import type { BackupStatus } from "@core/recovery";
import { call, isUnreachable, type Session } from "./api";
import { loadSession, saveSession } from "./session";
import { Login } from "./Login";
import { BackupManager, forgetAskedForKey, markAskedForKey, wasAskedForKey } from "./backup";
import { RecoveryRestore, RecoverySetup } from "./Recovery";
import { ChatApp } from "./ChatApp";
import type { Chat } from "@core/chat";
import { eraseIdentity, forgetIdentity } from "@core/index";
import { apiCall, cryptoSession, dropCryptoSession } from "./core";
import { lockStorage, unlockOnRefresh } from "./unlock";
import { TwoFactorRequired } from "./TwoFactor";
import { RulesGate } from "./home";
import { takeHandover, takeLinkFromLocation } from "./SignInLink";
import { handoverBytes } from "@core/signinlink";
import { storage } from "@core/storage";

// A QR login link this page was opened with, taken out of the address bar.
const openedLink = takeLinkFromLocation();

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  // Only true right after "Create account" in this tab: the recovery key
  // is then part of signup, with no "Not now".
  const [justRegistered, setJustRegistered] = useState(false);
  // A note for the next screen: after sign-in for Home, after a forced
  // sign-out for the login page.
  const [note, setNote] = useState<string | null>(() => openedLink && loadSession()
    ? "You're already signed in on this browser, so the sign-in link wasn't used." : null);
  // Used once: after that the login page is the plain one.
  const [link, setLink] = useState(openedLink);

  function update(s: Session | null, registered = false, message?: string) {
    // Signed out for any reason: the unlocked storage key goes too.
    if (!s) lockStorage();
    saveSession(s);
    setSession(s);
    setJustRegistered(registered);
    setNote(message ?? null);
    setLink(null);
  }

  if (!session) return <Login onSession={update} notice={note} link={link} />;
  return <Home key={session.user_id} session={session} justRegistered={justRegistered}
    initialNotice={note}
    onLoggedOut={(message) => update(null, false, message)}
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
  /** The server can't be reached; trying again by itself. */
  | { k: "offline" }
  | { k: "twofactor" }
  | { k: "rules" }
  | { k: "setup"; skippable: boolean; replacing: boolean; rotating?: boolean }
  | { k: "restore" }
  | { k: "ready" };

function Home({ session, justRegistered, initialNotice, onLoggedOut, onLocked }: {
  session: Session;
  justRegistered: boolean;
  initialNotice: string | null;
  onLoggedOut: (message?: string) => void;
  onLocked: () => void;
}) {
  const [manager, setManager] = useState<BackupManager | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  // Shown on the recovery-key screen instead of its usual text.
  const [restoreReason, setRestoreReason] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped when two-factor setup or the rules screen finishes, to carry on loading.
  const [gatePassed, setGatePassed] = useState(0);
  // Bumped to load again after the server couldn't be reached.
  const [attempt, setAttempt] = useState(0);

  // Offline (or the server restarting): try again on a growing delay, and
  // at once when the browser says the network is back. The installable
  // web app opens with no network too, so this is a normal state.
  useEffect(() => {
    if (phase.k !== "offline") return;
    const delay = Math.min(30, 2 ** Math.min(attempt, 5)) * 1000;
    const retry = () => { setPhase({ k: "loading" }); setAttempt((n) => n + 1); };
    const timer = setTimeout(retry, delay);
    window.addEventListener("online", retry);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", retry);
    };
  }, [phase.k, attempt]);

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
      // The server requires two-factor and this account has none: set it
      // up before anything else (the server refuses the rest until then).
      const me = await call<{ two_factor_setup_required?: boolean; rules_acceptance_required?: boolean }>(
        "/api/v1/me", { token: session.token });
      if (me.two_factor_setup_required) {
        if (live) setPhase({ k: "twofactor" });
        return;
      }
      // Then the server's rules, when it enforces them (home.tsx).
      if (me.rules_acceptance_required) {
        if (live) setPhase({ k: "rules" });
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
      let s = await m.status();
      // Just signed in by QR login: restore history with the key the
      // other device handed over (SignInLink.tsx), instead of asking for
      // the 12 words.
      const handover = takeHandover(session.user_id);
      if (handover?.backup && s && !s.unlocked) {
        try {
          const r = await m.backup.restoreWithKey(handover.backup.id, handoverBytes.decode(handover.backup.key));
          s = await m.status();
          if (live) setNotice(`Signed in. Message history restored (${r.added} message${r.added === 1 ? "" : "s"}).`);
        } catch (err) {
          console.warn("restoring with the handed-over key failed:", err);
        }
      }
      if (handover && s && !s.unlocked) {
        setRestoreReason("Signed in. Your other device couldn't send your message history (it doesn't have " +
          "your recovery key either). Enter your 12 words to bring it back.");
      }
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
    })().catch((err) => {
      if (!live) return;
      setPhase(isUnreachable(err) ? { k: "offline" } : { k: "failed", error: String(err?.message ?? err) });
    });
    return () => {
      live = false;
    };
  }, [session.user_id, session.token, justRegistered, gatePassed, attempt]);

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
   * Sign out and erase this browser (Settings, Devices): for a shared
   * computer. Like logout, but the device goes too: the backup is
   * uploaded first (if this browser can), the device is removed on the
   * server so it leaves every encrypted channel at once rather than after
   * 30 days, and this account's local database (keys, archive, keyring)
   * and its "asked for a recovery key" flag are deleted. Per-browser
   * preferences (colours, voice devices, notification switches) stay:
   * they say nothing about the account. Signing in here again is a new
   * device, which needs the recovery key for history.
   *
   * A failed backup or device removal does not stop the erase: the user
   * asked for this browser to be emptied. They are told on the login
   * page instead.
   */
  async function eraseAndLogout(chat: Chat, deviceId: string) {
    if (!manager) return;
    setBusy("Erasing…");
    const problems: string[] = [];
    const s = await manager.status().catch(() => null);
    if (s?.unlocked) {
      try {
        await manager.uploadNow();
      } catch (err) {
        console.warn("backup before erase failed:", err);
        problems.push("the last backup didn't upload");
      }
    }
    manager.close();
    chat.close();
    try {
      await call(`/api/v1/devices/${deviceId}`, { method: "DELETE", token: session.token });
    } catch (err) {
      console.warn("removing this device failed:", err);
      problems.push("this browser is still listed in your devices (remove it in Settings from another device, " +
        "or it expires after 30 days unused)");
    }
    // A browser signed in by QR login: its device secret on the server
    // goes too (nothing could use it once the keyring is erased).
    const secretId = await storage.deviceSecretId().catch(() => undefined);
    if (secretId) {
      await call(`/api/v1/me/device-secrets/${secretId}`, { method: "DELETE", token: session.token }).catch(() => {});
    }
    try {
      await eraseIdentity();
    } catch (err) {
      console.warn("could not erase this browser's data:", err);
      problems.push("some data could not be erased; clear this site's data in the browser settings");
    }
    forgetAskedForKey(session.user_id);
    dropCryptoSession(session.user_id);
    try {
      await call("/api/v1/auth/logout", { method: "POST", token: session.token });
    } catch {
      /* ignore */
    }
    onLoggedOut(problems.length
      ? `Signed out and erased, but ${problems.join("; ")}.`
      : "Signed out. This browser no longer holds anything from your account.");
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
  if (phase.k === "twofactor") {
    return <TwoFactorRequired session={session}
      onDone={() => { setPhase({ k: "loading" }); setGatePassed((n) => n + 1); }}
      onSignOut={() => {
        void call("/api/v1/auth/logout", { method: "POST", token: session.token }).catch(() => {});
        onLoggedOut();
      }} />;
  }
  if (phase.k === "rules") {
    return <RulesGate session={session}
      onDone={() => { setPhase({ k: "loading" }); setGatePassed((n) => n + 1); }}
      onSignOut={() => {
        void call("/api/v1/auth/logout", { method: "POST", token: session.token }).catch(() => {});
        onLoggedOut();
      }} />;
  }
  if (phase.k === "offline") {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Can't reach the server</h1>
          <p className="muted" role="status">
            You're offline, or the server is restarting. Trying again by itself; you stay signed in.
          </p>
          <button className="primary" onClick={() => { setPhase({ k: "loading" }); setAttempt((n) => n + 1); }}>
            Try Now
          </button>
        </div>
      </div>
    );
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
      onEraseAndLogout={eraseAndLogout}
      onExpired={onLoggedOut}
    />
  );
}
