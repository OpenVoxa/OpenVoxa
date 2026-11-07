// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState, type FormEvent } from "react";
import { call, guessDeviceName, type Session } from "./api";
import { usePasswordCheck } from "./password";
import { PasswordRules } from "./PasswordRules";
import { unlockWithPassword, type PasswordUnlock } from "./unlock";
import { setStaySignedIn, staySignedInChoice } from "./session";
import { LinkSignIn, parseLink } from "./SignInLink";
import type { LinkParts } from "@core/signinlink";
import { AuthHeading } from "./serverInfo";

/** A note for the first screen after sign-in, when unlocking changed something. */
function unlockNote(how: PasswordUnlock): string | undefined {
  switch (how) {
    case "upgraded":
      return "This browser's saved keys and messages are now encrypted with your password.";
    case "replaced":
      return "Your password was changed in another browser, so this browser's saved keys " +
        "could no longer be opened. It has been set up as a new device.";
    default:
      return undefined;
  }
}

export function Login({ onSession, notice, link: openedLink = null }: {
  onSession: (s: Session, registered: boolean, note?: string) => void;
  notice?: string | null;
  /** A QR login link this page was opened with (App.tsx). */
  link?: LinkParts | null;
}) {
  // QR login: the link being used, and the paste box for one.
  const [link, setLink] = useState<LinkParts | null>(openedLink);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An empty server is claimed with a code from the server log.
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupCode, setSetupCode] = useState("");
  // Who may sign up (server signup.go): anyone, with the server password, or nobody.
  const [signupMode, setSignupMode] = useState<"open" | "password" | "closed">("open");
  const [serverPassword, setServerPassword] = useState("");
  const [stay, setStay] = useState(staySignedInChoice);
  // Two-factor: the password was right; the code finishes signing in.
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const registering = mode === "register";
  const pw = usePasswordCheck(password, username, registering);
  // Only once the password itself is acceptable is the confirmation worth
  // comparing; before that the checklist is what needs attention.
  const mismatch = registering && pw.ok && confirm !== "" && confirm !== password;

  // On the login page too, so "Register" can be greyed out when closed.
  useEffect(() => {
    call<{ needs_setup_code: boolean; signup_mode?: "open" | "password" | "closed" }>("/api/v1/setup")
      .then((r) => {
        setNeedsSetup(r.needs_setup_code);
        setSignupMode(r.signup_mode ?? "open");
      })
      .catch(() => {});
  }, [registering]);
  // The first account (setup code) is never blocked by the sign-up mode.
  const askServerPassword = registering && !needsSetup && signupMode === "password";
  const closed = !needsSetup && signupMode === "closed";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (registering) {
      if (!pw.ok) {
        setError("Password doesn't meet the requirements yet.");
        return;
      }
      // The confirm field already says so; retype until it matches.
      if (password !== confirm) return;
    }
    setBusy(true);
    // Before signing in: the unlock copy saved during sign-in goes where
    // the session will (session.ts).
    setStaySignedIn(stay);
    try {
      const r = await call<Session | { two_factor_ticket: string }>(`/api/v1/auth/${mode}`, {
        method: "POST",
        body: {
          username, password, device_name: guessDeviceName(),
          ...(registering && needsSetup ? { setup_code: setupCode } : {}),
          ...(askServerPassword ? { server_password: serverPassword } : {}),
        },
      });
      if ("two_factor_ticket" in r) {
        setTicket(r.two_factor_ticket);
        setCode("");
        return;
      }
      await finish(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Signed in: open this browser's storage and go in. */
  async function finish(s: Session) {
    {
      // The password unlocks this browser's encrypted storage too; this
      // is the only moment it is at hand (unlock.ts).
      let how: PasswordUnlock;
      try {
        how = await unlockWithPassword(s, password);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`Signed in, but this browser's encrypted storage could not be opened: ${why}`);
      }
      onSession(s, registering, unlockNote(how));
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const s = await call<Session>("/api/v1/auth/login/two-factor", {
        method: "POST", body: { ticket, code },
      });
      await finish(s);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Timed out, or too many wrong codes: back to the password.
      if (msg.includes("password again")) {
        setTicket(null);
        setPassword("");
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(registering ? "login" : "register");
    setError(null);
    setConfirm("");
  }

  if (link) {
    return <LinkSignIn parts={link} onCancel={() => { setLink(null); setPasted(""); }}
      onSession={(s, note) => onSession(s, false, note)} />;
  }

  function submitPasted(e: FormEvent) {
    e.preventDefault();
    const parts = parseLink(pasted);
    if (!parts) {
      setError("That isn't a sign-in link. Copy it again from Settings > Account on your other device.");
      return;
    }
    setError(null);
    setLink(parts);
  }

  if (pasting) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={submitPasted}>
          <AuthHeading />
          <p className="muted">Sign in with a link</p>
          <label>
            Link from your other device
            <input value={pasted} onChange={(e) => { setPasted(e.target.value); setError(null); }}
              placeholder="https://…/#signin=…" autoComplete="off" spellCheck={false} autoFocus required />
            <span className="muted">
              On a device where you're signed in, open Settings, Account, Sign In on Another Device, and use
              Copy Link.
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={stay} onChange={(e) => { setStay(e.target.checked); setStaySignedIn(e.target.checked); }} />
            <span>Stay signed in</span>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="primary" disabled={!pasted.trim()}>Continue</button>
          <button type="button" className="link" onClick={() => { setPasting(false); setError(null); }}>Back</button>
        </form>
      </div>
    );
  }

  if (ticket) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={submitCode}>
          <AuthHeading />
          <p className="muted">Two-factor sign-in</p>
          <label>
            Code from your authenticator app
            <input value={code} onChange={(e) => { setCode(e.target.value); setError(null); }}
              autoComplete="one-time-code" inputMode="text" spellCheck={false} autoCapitalize="none"
              placeholder="123456" maxLength={12} autoFocus required />
            <span className="muted">Lost your phone? Enter one of your backup codes instead.</span>
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="primary" disabled={busy || !code.trim()}>{busy ? "…" : "Log in"}</button>
          <button type="button" className="link" disabled={busy}
            onClick={() => { setTicket(null); setPassword(""); setError(null); }}>
            Back
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <AuthHeading />
        <p className="muted">{registering ? "Create an account" : "Welcome back"}</p>
        {notice && <p className="muted" role="status">{notice}</p>}

        {askServerPassword && (
          <label>
            Server password
            <input value={serverPassword} onChange={(e) => { setServerPassword(e.target.value); setError(null); }}
              autoComplete="off" spellCheck={false} autoFocus required />
            <span className="muted">This server only lets people in who have its password. Ask whoever invited you.</span>
          </label>
        )}

        <label>
          Username
          <input value={username} onChange={(e) => { setUsername(e.target.value); setError(null); }}
            autoComplete="username" autoFocus={!askServerPassword} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }}
            autoComplete={registering ? "new-password" : "current-password"} required />
        </label>
        {registering && <PasswordRules pw={pw} empty={password === ""} />}
        {registering && (
          <label>
            Confirm password
            <input type="password" value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(null); }}
              autoComplete="new-password" required aria-invalid={mismatch} />
            {mismatch && <span className="error">Passwords don't match.</span>}
          </label>
        )}

        {registering && needsSetup && (
          <label>
            Setup code
            <input value={setupCode} onChange={(e) => { setSetupCode(e.target.value); setError(null); }}
              placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} required />
            <span className="muted">
              This server has no accounts yet. The first one becomes the administrator,
              so it needs the code printed in the server log.
            </span>
          </label>
        )}

        <label className="check">
          <input type="checkbox" checked={stay} onChange={(e) => setStay(e.target.checked)} />
          <span>Stay signed in</span>
        </label>

        {error && <p className="error" role="alert">{error}</p>}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? "…" : registering ? "Create account" : "Log in"}
        </button>
        <button type="button" className="link" onClick={switchMode} disabled={!registering && closed}
          title={!registering && closed ? "This server isn't accepting new accounts" : undefined}>
          {registering ? "Already have an account? Log in" : "Need an account? Register"}
        </button>
        {!registering && closed && <p className="muted small">This server isn't accepting new accounts.</p>}
        {!registering && (
          <button type="button" className="link" onClick={() => { setPasting(true); setError(null); }}>
            Sign in with a link from another device
          </button>
        )}
      </form>
    </div>
  );
}
