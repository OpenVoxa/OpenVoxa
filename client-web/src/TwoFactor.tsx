// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two-factor sign-in (server twofactor.go; decisions.md, Feature
 * decisions, "Planned", two-factor): a code from an authenticator app
 * after the password, or one of ten single-use backup codes.
 *
 * - TwoFactorSection: Settings, Account. Turn it on, make new backup
 *   codes, turn it off (both need a current code).
 * - TwoFactorRequired: the full-screen setup shown when the server
 *   requires two-factor for this account and it has none. The server
 *   refuses everything else until it's done, so this is not optional.
 * - The sign-in code step lives in Login.tsx.
 */

import { useEffect, useState, type FormEvent } from "react";
import { call, type Session } from "./api";
import { QrCode } from "./Recovery";

interface TwoFactorStatus {
  enabled: boolean;
  backup_codes_left: number;
  /** The server requires it for this account: it can't be turned off. */
  required: boolean;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shared text for code inputs: digits from the app, or a backup code. */
function CodeInput({ value, onChange, backup = true, autoFocus = true }: {
  value: string;
  onChange: (v: string) => void;
  backup?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)}
      inputMode={backup ? "text" : "numeric"} autoComplete="one-time-code" spellCheck={false}
      autoCapitalize="none" placeholder={backup ? "123456 or a backup code" : "123456"}
      maxLength={backup ? 12 : 7} autoFocus={autoFocus} required />
  );
}

/**
 * Setting it up: scan or type the secret, confirm one code, then save the
 * backup codes. Starting again (Cancel, or leaving) just makes a new
 * secret next time; nothing is switched on until the code is right.
 */
function SetupFlow({ token, onDone, onCancel }: {
  token: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    // Each start replaces the pending secret on the server, so only the
    // latest answer may be shown (React's dev mode runs this twice).
    let live = true;
    call<{ secret: string; uri: string }>("/api/v1/me/two-factor/setup", { method: "POST", token })
      .then((s) => live && setSetup(s), (err) => live && setError(errText(err)));
    return () => { live = false; };
  }, [token]);

  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ backup_codes: string[] }>("/api/v1/me/two-factor/enable",
        { method: "POST", token, body: { code } });
      setCodes(r.backup_codes);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return <BackupCodes codes={codes} intro="Two-factor is on." onDone={onDone} />;
  }
  if (!setup) {
    return (
      <div className="settings-form">
        {error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}
        {onCancel && <div className="row-actions"><button className="secondary" onClick={onCancel}>Cancel</button></div>}
      </div>
    );
  }
  // Grouped in fours, as most apps show it.
  const spaced = setup.secret.replace(/(.{4})/g, "$1 ").trim();
  return (
    <form className="settings-form" onSubmit={enable}>
      <p className="small">
        <strong>1.</strong> Install an authenticator app on your phone if you don't have one: Google
        Authenticator, Microsoft Authenticator, 2FAS, Aegis, or your password manager's.
      </p>
      <p className="small"><strong>2.</strong> In the app, add an account and scan this QR code.</p>
      <QrCode payload={setup.uri} plain alt="Two-factor QR code for your authenticator app" />
      <p className="muted small">Can't scan it? Choose "enter a setup key" in the app and type this instead:</p>
      <div className="secret-row">
        <code className="secret">{spaced}</code>
        <button type="button" className="secondary" onClick={() => {
          void navigator.clipboard.writeText(setup.secret)
            .then(() => setNote("Copied."), () => setNote("Couldn't copy: the browser blocked the clipboard."));
        }}>Copy</button>
      </div>
      {note && <p className="muted small" role="status">{note}</p>}
      <label>
        <span><strong>3.</strong> Type the 6-digit code the app now shows</span>
        <CodeInput value={code} onChange={(v) => { setCode(v); setError(null); }} backup={false} autoFocus={false} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row-actions">
        <button type="submit" className="primary" disabled={busy || !code.trim()}>
          {busy ? "Checking…" : "Turn on two-factor"}
        </button>
        {onCancel && <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>}
      </div>
    </form>
  );
}

/** The backup codes, shown once, with Copy and Download. */
function BackupCodes({ codes, intro, onDone }: { codes: string[]; intro: string; onDone: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const text = `OpenVoxa backup codes for ${location.host}\n` +
    "Each works once, in place of the code from your authenticator app.\n\n" +
    codes.join("\n") + "\n";

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `openvoxa-backup-codes-${location.hostname}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="settings-form">
      <p className="small">
        {intro} Save these backup codes somewhere safe, away from your phone: each one signs you in once if
        you lose your phone. This is the only time they're shown.
      </p>
      <ol className="word-grid">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div className="row-actions">
        <button type="button" className="secondary" onClick={() => {
          void navigator.clipboard.writeText(text)
            .then(() => setNote("Copied."), () => setNote("Couldn't copy: the browser blocked the clipboard."));
        }}>Copy</button>
        <button type="button" className="secondary" onClick={download}>Download</button>
      </div>
      {note && <p className="muted small" role="status">{note}</p>}
      <div className="row-actions">
        <button type="button" className="primary" onClick={onDone}>I've saved them</button>
      </div>
    </div>
  );
}

/** Settings, Account. */
export function TwoFactorSection({ session }: { session: Session }) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What's open: setting up, or a code form for new codes or turning off.
  const [open, setOpen] = useState<"setup" | "codes" | "off" | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function load() {
    call<TwoFactorStatus>("/api/v1/me/two-factor", { token: session.token })
      .then((s) => { setStatus(s); setError(null); }, (err) => setError(errText(err)));
  }
  useEffect(load, [session.token]);

  function close() {
    setOpen(null);
    setCode("");
    setError(null);
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (open === "codes") {
        const r = await call<{ backup_codes: string[] }>("/api/v1/me/two-factor/backup-codes",
          { method: "POST", token: session.token, body: { code } });
        setCodes(r.backup_codes);
      } else {
        await call("/api/v1/me/two-factor", { method: "DELETE", token: session.token, body: { code } });
        setDone("Two-factor is off.");
      }
      close();
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (!status) {
    body = error ? <p className="error" role="alert">{error}</p> : <p className="muted small">Loading…</p>;
  } else if (codes) {
    body = <BackupCodes codes={codes} intro="Your old backup codes no longer work."
      onDone={() => { setCodes(null); setDone("New backup codes saved."); }} />;
  } else if (open === "setup") {
    body = <SetupFlow token={session.token}
      onDone={() => { close(); setDone("Two-factor is on."); load(); }} onCancel={close} />;
  } else if (!status.enabled) {
    body = (
      <>
        <p className="muted small">
          Off. With two-factor on, signing in with your password also asks for a code from an app on your
          phone, so someone who learns your password still can't get in.
          {status.required && " This server requires it for your account."}
        </p>
        <div className="row-actions">
          <button className="secondary" onClick={() => { setOpen("setup"); setDone(null); }}>Set up two-factor</button>
        </div>
      </>
    );
  } else {
    const few = status.backup_codes_left <= 3;
    body = (
      <>
        <p className="muted small">
          On. Signing in with your password also asks for a code from your authenticator app.{" "}
          <span className={few ? "error" : undefined}>
            {status.backup_codes_left} backup code{status.backup_codes_left === 1 ? "" : "s"} left.
          </span>
        </p>
        {open ? (
          <form className="settings-form" onSubmit={submitCode}>
            <label>
              {open === "codes" ? "Code from your app, to make new backup codes" : "Code from your app, to turn two-factor off"}
              <CodeInput value={code} onChange={(v) => { setCode(v); setError(null); }} />
            </label>
            {open === "codes" && <p className="muted small">Your current backup codes stop working.</p>}
            {error && <p className="error" role="alert">{error}</p>}
            <div className="row-actions">
              <button type="submit" className={open === "off" ? "danger solid" : "primary"} disabled={busy || !code.trim()}>
                {busy ? "Checking…" : open === "codes" ? "Make new codes" : "Turn off"}
              </button>
              <button type="button" className="secondary" onClick={close} disabled={busy}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="row-actions">
            <button className="secondary" onClick={() => { setOpen("codes"); setDone(null); }}>New backup codes</button>
            <button className="secondary" onClick={() => { setOpen("off"); setDone(null); }} disabled={status.required}
              title={status.required ? "This server requires two-factor for your account" : undefined}>Turn off</button>
          </div>
        )}
        {status.required && !open && (
          <p className="muted small">This server requires two-factor for your account, so it can't be turned off.</p>
        )}
      </>
    );
  }

  return (
    <section className="settings-section">
      <h3 className="settings-head">Two-factor sign-in</h3>
      {done && <p className="small" role="status">{done}</p>}
      {body}
    </section>
  );
}

/** Full screen: the server requires two-factor and this account has none. */
export function TwoFactorRequired({ session, onDone, onSignOut }: {
  session: Session;
  onDone: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="auth-page">
      <div className="auth-card wide">
        <h1>Set up two-factor sign-in</h1>
        <p className="muted">
          This server requires two-factor sign-in for your account. From now on, signing in with your password
          also asks for a code from an app on your phone. It takes a minute.
        </p>
        <SetupFlow token={session.token} onDone={onDone} />
        <button className="link" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}
