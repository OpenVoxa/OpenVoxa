// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState, type FormEvent } from "react";
import { call, guessDeviceName, type Session } from "./api";
import { usePasswordCheck } from "./password";
import { PasswordRules } from "./PasswordRules";
import { unlockWithPassword, type PasswordUnlock } from "./unlock";

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

export function Login({ onSession, notice }: {
  onSession: (s: Session, registered: boolean, note?: string) => void;
  notice?: string | null;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An empty server is claimed with a code from the server log.
  const [needsSetup, setNeedsSetup] = useState(false);
  const [setupCode, setSetupCode] = useState("");

  const registering = mode === "register";
  const pw = usePasswordCheck(password, username, registering);
  // Only once the password itself is acceptable is the confirmation worth
  // comparing; before that the checklist is what needs attention.
  const mismatch = registering && pw.ok && confirm !== "" && confirm !== password;

  useEffect(() => {
    if (!registering) return;
    call<{ needs_setup_code: boolean }>("/api/v1/setup")
      .then((r) => setNeedsSetup(r.needs_setup_code))
      .catch(() => {});
  }, [registering]);

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
    try {
      const s = await call<Session>(`/api/v1/auth/${mode}`, {
        method: "POST",
        body: {
          username, password, device_name: guessDeviceName(),
          ...(registering && needsSetup ? { setup_code: setupCode } : {}),
        },
      });
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    setMode(registering ? "login" : "register");
    setError(null);
    setConfirm("");
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>OpenVoxa</h1>
        <p className="muted">{registering ? "Create an account" : "Welcome back"}</p>
        {notice && <p className="muted" role="status">{notice}</p>}

        <label>
          Username
          <input value={username} onChange={(e) => { setUsername(e.target.value); setError(null); }}
            autoComplete="username" autoFocus required />
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

        {error && <p className="error" role="alert">{error}</p>}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? "…" : registering ? "Create account" : "Log in"}
        </button>
        <button type="button" className="link" onClick={switchMode}>
          {registering ? "Already have an account? Log in" : "Need an account? Register"}
        </button>
      </form>
    </div>
  );
}
