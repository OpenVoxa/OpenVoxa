// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Settings dialog (build order 13, M5 session A): Account, Voice,
 * Chat, Sounds, Appearance and About tabs. The user-panel gear opens it on Account, the voice bar's cog
 * on Voice. The Voice tab loads the voice client (and with it LiveKit)
 * only when it is picked, so text-only use never pays for it.
 *
 * Account calls that check the password (change password, delete
 * account) go through api.ts `call`, not the ApiCall that signs out on
 * any 401: there a 401 means "wrong password", not "session ended".
 */

import { useEffect, useState, type FormEvent } from "react";
import type { ApiCall } from "@core/identity";
import type { Chat } from "@core/chat";
import type { BackupStatus } from "@core/recovery";
import { storage } from "@core/storage";
import type { VoiceClient, VoiceSnapshot } from "@core/voice";
import { call as plainCall, type Session } from "./api";
import { Modal } from "./ChannelDialogs";
import { usePasswordCheck } from "./password";
import { PasswordRules } from "./PasswordRules";
import { IMAGES_IN_TAB, MENTION_NOTIFY, NAME_COLOURS, PREVIEWS_ENCRYPTED, setToggle, useToggle } from "./settings";
import { VoiceSettings } from "./VoiceUI";
import { SoundSettings } from "./SoundSettings";
import { AboutSettings } from "./AboutSettings";
import { COLOURS, getColour, setColour, useColour, type ColourSetting } from "./appearance";
import { TwoFactorSection } from "./TwoFactor";
import { SignInOtherDevice } from "./SignInLink";

export type SettingsTab = "account" | "voice" | "chat" | "sounds" | "appearance" | "about";

export interface AccountActions {
  onBackUpNow: () => void;
  onSetUpKey: () => void;
  onEnterKey: () => void;
  /** Replace a working recovery key with a new one. */
  onNewKey: () => void;
  /** Resolves once the account is gone and this browser wiped; throws the server's refusal. */
  onDeleteAccount: (password: string) => Promise<void>;
  /** Shared computer: back up, remove this device, erase this browser, sign out. */
  onEraseAndLogout: () => void;
}

export function SettingsDialog({ tab: initialTab, session, call, chat, deviceId, backup, busy, actions, voice, snap, loadVoice, onClose }: {
  tab: SettingsTab;
  session: Session;
  call: ApiCall;
  chat: Chat;
  deviceId: string;
  backup: BackupStatus | null;
  busy: string | null;
  actions: AccountActions;
  voice: VoiceClient | null;
  snap: VoiceSnapshot | null;
  loadVoice: () => Promise<VoiceClient | null>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "voice" || voice) return;
    loadVoice().catch((err) => setVoiceError(errText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, voice]);

  const tabs: [SettingsTab, string][] = [["account", "Account"], ["voice", "Voice"], ["chat", "Chat"], ["sounds", "Sounds"], ["appearance", "Appearance"], ["about", "About"]];
  return (
    <Modal title="Settings" onClose={onClose} wide fixed>
      <div className="settings-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : undefined}
            onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="modal-body">
        {tab === "account" && (
          <AccountSettings session={session} call={call} deviceId={deviceId} backup={backup} busy={busy}
            actions={actions} onClose={onClose} />
        )}
        {tab === "voice" && (voice
          ? <VoiceSettings voice={voice} snap={snap} />
          : voiceError ? <p className="error" role="alert">{voiceError}</p> : <p className="muted">Loading…</p>)}
        {tab === "chat" && <ChatSettings />}
        {tab === "sounds" && <SoundSettings />}
        {tab === "appearance" && <AppearanceSettings />}
        {tab === "about" && <AboutSettings call={call} chat={chat} voice={voice} snap={snap} />}
      </div>
      <div className="modal-actions modal-foot">
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ chat

function ChatSettings() {
  const previews = useToggle(PREVIEWS_ENCRYPTED);
  const imagesInTab = useToggle(IMAGES_IN_TAB);
  const mentionNotify = useToggle(MENTION_NOTIFY);
  const supported = typeof Notification !== "undefined";
  const [denied, setDenied] = useState(supported && Notification.permission === "denied");

  async function toggleNotify(on: boolean) {
    if (!on || !supported) {
      setToggle(MENTION_NOTIFY, false);
      return;
    }
    // The browser asks once; after a "no" only its own settings can undo it.
    const answer = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    setDenied(answer === "denied");
    setToggle(MENTION_NOTIFY, answer === "granted");
  }

  return (
    <>
      <label className="check">
        <input type="checkbox" checked={mentionNotify && !denied} disabled={!supported}
          onChange={(e) => void toggleNotify(e.target.checked)} />
        <span>
          Desktop notification when someone mentions you
          <span className="muted small block">
            {!supported ? "This browser doesn't support notifications."
              : denied ? "Notifications are blocked for this site. Allow them in the browser's site settings, then turn this on."
              : "Shown while this tab is in the background or another channel is open. It says who mentioned you and"
                + " where, never the message itself. Only while OpenVoxa is open in a tab."}
          </span>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={previews} onChange={(e) => setToggle(PREVIEWS_ENCRYPTED, e.target.checked)} />
        <span>
          Link previews in encrypted channels
          <span className="muted small block">
            Messages stay encrypted, but to build a preview the server fetches the link, so it learns which
            links you see there. Preview images load from the linked site. Plain channels always show previews.
          </span>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={imagesInTab} onChange={(e) => setToggle(IMAGES_IN_TAB, e.target.checked)} />
        <span>
          Open images in a new tab
          <span className="muted small block">Off: clicking an image shows it larger in a viewer on this page.</span>
        </span>
      </label>
    </>
  );
}

// ------------------------------------------------------------ appearance

function AppearanceSettings() {
  const nameColours = useToggle(NAME_COLOURS);
  return (
    <>
      <p className="muted small">Saved in this browser only. Changes show straight away.</p>
      <label className="check">
        <input type="checkbox" checked={nameColours} onChange={(e) => setToggle(NAME_COLOURS, e.target.checked)} />
        <span>
          Show name colours
          <span className="muted small block">
            Names in the colour of the person's highest group, as the server's staff set them. Off: every name
            in the normal text colour.
          </span>
        </span>
      </label>
      {COLOURS.map((c) => <ColourRow key={c.cssVar} c={c} />)}
      <div className="modal-actions">
        <button className="secondary" onClick={() => COLOURS.forEach((c) => setColour(c, null))}>
          Reset all to default
        </button>
      </div>
    </>
  );
}

function ColourRow({ c }: { c: ColourSetting }) {
  const value = useColour(c);
  const custom = getColour(c) !== null;
  const id = `colour${c.cssVar}`;
  return (
    <div className="colour-row">
      <input id={id} type="color" value={value} onChange={(e) => setColour(c, e.target.value)} />
      <label htmlFor={id} className="grow">
        {c.label}
        {c.help && <span className="muted small block">{c.help}</span>}
      </label>
      {custom && <button className="link small" onClick={() => setColour(c, null)}>Default</button>}
    </div>
  );
}

// --------------------------------------------------------------- account

function AccountSettings({ session, call, deviceId, backup, busy, actions, onClose }: {
  session: Session;
  call: ApiCall;
  deviceId: string;
  backup: BackupStatus | null;
  busy: string | null;
  actions: AccountActions;
  onClose: () => void;
}) {
  // The recovery screens replace the whole app, so the dialog closes first.
  const leave = (f: () => void) => () => {
    onClose();
    f();
  };
  return (
    <>
      <section className="settings-section">
        <h3 className="settings-head">Account</h3>
        <p>
          Signed in as <strong>{session.username}</strong>
          {session.groups.length > 0 && (
            <span className="muted"> · {session.groups.map((g) => g.name).join(", ")}</span>
          )}
        </p>
      </section>

      <PasswordSection session={session} />

      <TwoFactorSection session={session} />

      <SignInOtherDevice session={session} />

      <section className="settings-section">
        <h3 className="settings-head">Recovery key</h3>
        {!backup && (
          <>
            <p className="muted small">
              You have no recovery key, so your encrypted message history exists only in this browser.
              Signing out or losing this device loses it.
            </p>
            <div className="row-actions">
              <button className="secondary" onClick={leave(actions.onSetUpKey)}>Set up a recovery key</button>
            </div>
          </>
        )}
        {backup && !backup.unlocked && (
          <>
            <p className="muted small">
              A backup exists, but this browser doesn't have its key, so it isn't backing up. Enter your
              recovery key to restore your history and resume backups.
            </p>
            <div className="row-actions">
              <button className="secondary" onClick={leave(actions.onEnterKey)}>Enter recovery key</button>
            </div>
          </>
        )}
        {backup?.unlocked && (
          <>
            <p className="muted small">
              Your encrypted history is backed up ({formatBytes(backup.totalBytes)}, last{" "}
              {new Date(backup.updatedAt).toLocaleString()}). Backups run about a minute after new messages
              and before you sign out. The key itself was shown once and can't be shown again.
            </p>
            <div className="row-actions">
              <button className="secondary" onClick={actions.onBackUpNow} disabled={!!busy}>{busy ?? "Back up now"}</button>
              <button className="secondary" onClick={leave(actions.onNewKey)} disabled={!!busy}>Make a new key</button>
            </div>
            <p className="muted small">
              Make a new key if you lost the old one's words or think someone else has seen them. The old key
              stops working and this browser uploads your history again under the new one.
            </p>
          </>
        )}
      </section>

      <DevicesSection call={call} deviceId={deviceId} backup={backup} busy={busy}
        onErase={leave(actions.onEraseAndLogout)} />

      <DeleteAccount username={session.username} onDelete={actions.onDeleteAccount} />
    </>
  );
}

function PasswordSection({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pw = usePasswordCheck(next, session.username);
  const mismatch = pw.ok && confirm !== "" && confirm !== next;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!pw.ok) {
      setError("New password doesn't meet the requirements yet.");
      return;
    }
    if (next !== confirm) return;
    setBusy(true);
    try {
      const r = await plainCall<{ other_sessions_ended: number }>("/api/v1/me/password", {
        method: "PUT",
        token: session.token,
        body: { current_password: current, new_password: next },
      });
      const n = r?.other_sessions_ended ?? 0;
      let msg = n === 0 ? "Password changed."
        : `Password changed. ${n} other sign-in${n === 1 ? " was" : "s were"} signed out.`;
      // This browser's encrypted storage opens with the password, so
      // re-lock its key under the new one (client-core storage.rewrap).
      // Other browsers find out at their next sign-in (unlock.ts).
      try {
        await storage.rewrap(next);
      } catch (err) {
        console.warn("could not re-lock local storage under the new password:", err);
        msg += " This browser's saved keys are still locked with the old password, so the " +
          "next sign-in here will set it up as a new device (restore history with your recovery key).";
      }
      setDone(msg);
      setOpen(false);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3 className="settings-head">Password</h3>
      {done && <p className="small" role="status">{done}</p>}
      {!open ? (
        <div className="row-actions">
          <button className="secondary" onClick={() => { setOpen(true); setDone(null); }}>Change password</button>
        </div>
      ) : (
        <form className="settings-form" onSubmit={submit}>
          <label>
            Current password
            <input type="password" value={current} onChange={(e) => { setCurrent(e.target.value); setError(null); }}
              autoComplete="current-password" autoFocus required />
          </label>
          <label>
            New password
            <input type="password" value={next} onChange={(e) => { setNext(e.target.value); setError(null); }}
              autoComplete="new-password" required />
          </label>
          <PasswordRules pw={pw} empty={next === ""} />
          <label>
            Confirm new password
            <input type="password" value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(null); }}
              autoComplete="new-password" required aria-invalid={mismatch} />
            {mismatch && <span className="error">Passwords don't match.</span>}
          </label>
          <p className="muted small">
            Every other place you're signed in is signed out. This browser stays signed in. Your recovery key
            doesn't change.
          </p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row-actions">
            <button type="submit" className="primary" disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
            <button type="button" className="secondary" onClick={() => { setOpen(false); setError(null); }}
              disabled={busy}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

interface Device {
  id: string;
  label: string;
  created_at: string;
  last_seen_at: string;
}

function DevicesSection({ call, deviceId, backup, busy, onErase }: {
  call: ApiCall;
  deviceId: string;
  backup: BackupStatus | null;
  busy: string | null;
  onErase: () => void;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function load() {
    try {
      setDevices(await call("/api/v1/devices") as Device[]);
    } catch (err) {
      setError(errText(err));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(d: Device) {
    if (!confirm(`Remove "${d.label || "Unnamed device"}"?\n\nIts keys stop working: it's taken out of every ` +
      "encrypted channel, and history only it holds is lost. If you still use that browser, it starts " +
      "over as a new device the next time it opens.")) return;
    setRemoving(d.id);
    setError(null);
    try {
      await call(`/api/v1/devices/${d.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setRemoving(null);
    }
  }

  function erase() {
    const history = backup?.unlocked
      ? "Your history is backed up first. Signing in here again sets this browser up as a new device, " +
        "and your 12-word recovery key brings your history back."
      : backup
        ? "This browser isn't backing up (it doesn't have your recovery key), so encrypted history only " +
          "this browser holds is lost."
        : "You have no recovery key, so encrypted history only this browser holds is lost for good.";
    if (!confirm("Sign out and erase this browser?\n\nFor a shared or borrowed computer. Your keys and " +
      "message history are deleted from this browser, and it's removed from your devices.\n\n" + history)) return;
    onErase();
  }

  // This browser first, then the most recently used.
  const sorted = devices && [...devices].sort((a, b) =>
    Number(b.id === deviceId) - Number(a.id === deviceId) || b.last_seen_at.localeCompare(a.last_seen_at));

  return (
    <section className="settings-section">
      <h3 className="settings-head">Devices</h3>
      <p className="muted small">
        Each browser you sign in from gets its own encryption keys. Devices unused for 30 days expire on their own.
      </p>
      {!sorted && !error && <p className="muted small">Loading…</p>}
      {sorted && (
        <ul className="device-list">
          {sorted.map((d) => (
            <li key={d.id}>
              <span className="device-name">
                {d.label || "Unnamed device"}
                {d.id === deviceId && <span className="tag small">This browser</span>}
                <span className="muted small block">
                  Added {new Date(d.created_at).toLocaleDateString()} · last used {new Date(d.last_seen_at).toLocaleString()}
                </span>
              </span>
              {d.id !== deviceId ? (
                <button className="danger" onClick={() => void remove(d)} disabled={removing !== null}>
                  {removing === d.id ? "Removing…" : "Remove"}
                </button>
              ) : (
                <button className="danger" onClick={erase} disabled={!!busy || removing !== null}>
                  Sign out and erase
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {sorted?.some((d) => d.id === deviceId) && (
        <p className="muted small">
          On a shared computer, use <strong>Sign out and erase</strong>: it backs up your history, then removes
          this browser and deletes everything it holds. A plain Log out keeps this browser set up for next time.
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function DeleteAccount({ username, onDelete }: { username: string; onDelete: (password: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (typed !== username) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(password);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <section className="danger-zone">
      {!open ? (
        <button className="danger" onClick={() => setOpen(true)}>Delete account…</button>
      ) : (
        <form className="settings-form" onSubmit={submit}>
          <h3 className="settings-head">Delete account</h3>
          <p className="small">
            This permanently deletes your account. Your messages and files are erased everywhere this server
            controls, including its backups. People who already read them may still have their own copies.
            You're signed out everywhere, and your username becomes free for someone else.
          </p>
          <label>
            Type your username, <strong>{username}</strong>, to confirm
            <input value={typed} onChange={(e) => { setTyped(e.target.value); setError(null); }}
              autoComplete="off" spellCheck={false} autoFocus required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }}
              autoComplete="current-password" required />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row-actions">
            <button type="submit" className="danger solid" disabled={busy || typed !== username || !password}>
              {busy ? "Deleting…" : "Delete my account"}
            </button>
            <button type="button" className="secondary" onClick={() => { setOpen(false); setTyped(""); setPassword(""); setError(null); }}
              disabled={busy}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
