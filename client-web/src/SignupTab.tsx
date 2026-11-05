// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server settings, Sign-Up (administrators; server signup.go;
 * decisions.md Feature decisions, "Server password"). The mode and the
 * rotation period are saved with Save; the password buttons (Change,
 * Generate, Rotate Now) act at once, because a leaked password should not
 * wait for a second click.
 */

import { useEffect, useState } from "react";
import type { ApiCall } from "@core/identity";

type Mode = "open" | "password" | "closed";

interface Settings {
  mode: Mode;
  password: string;
  rotate_hours: number;
  next_rotation: string | null;
  previous_valid_until: string | null;
}

const MODES: { id: Mode; label: string; help: string }[] = [
  { id: "open", label: "Open", help: "Anyone who reaches this server can create an account." },
  { id: "password", label: "Server Password", help: "Creating an account needs the server password. Logging in never does." },
  { id: "closed", label: "Closed", help: "Nobody can create an account. Existing accounts are unaffected." },
];

const ROTATIONS: [number, string][] = [[0, "Never"], [24, "Every 24 hours"], [168, "Every 7 days"], [720, "Every 30 days"]];

const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function SignupTab({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [mode, setMode] = useState<Mode>("open");
  const [rotation, setRotation] = useState(0); // hours, 0: never
  const [custom, setCustom] = useState(false);
  const [shown, setShown] = useState(false);
  const [changing, setChanging] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const take = (s: Settings) => {
    setSaved(s);
    setMode(s.mode);
    setRotation(s.rotate_hours);
    setCustom(!ROTATIONS.some(([h]) => h === s.rotate_hours));
  };

  useEffect(() => {
    (call("/api/v1/signup-settings") as Promise<Settings>).then(take).catch((err) => setError(errText(err)));
  }, [call]);

  async function run(f: () => Promise<Settings>, done?: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const s = await f();
      take(s);
      if (done) setNote(done);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(() => call("/api/v1/signup-settings", {
    method: "PUT", body: JSON.stringify({ mode, rotate_hours: rotation }),
  }) as Promise<Settings>, "Saved.");

  const setPassword = (body: { password?: string; generate?: boolean }, done: string) =>
    run(async () => {
      const s = (await call("/api/v1/signup-settings/password", {
        method: "POST", body: JSON.stringify(body),
      })) as Settings;
      setChanging(false);
      setTyped("");
      setShown(true);
      return s;
    }, done);

  if (!saved) {
    return (
      <div className="modal-body">
        {error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const dirty = mode !== saved.mode || rotation !== saved.rotate_hours;
  // The password section works on the saved password, whatever mode is picked.
  const hasPassword = saved.password !== "";

  return (
    <>
      <div className="modal-body">
        <h3 className="settings-head">Who Can Create an Account</h3>
        <div className="radio-list" role="radiogroup" aria-label="Sign-up mode">
          {MODES.map((m) => (
            <label key={m.id} className="check">
              <input type="radio" name="signup-mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
              <span>
                {m.label}
                <span className="muted small block">{m.help}</span>
              </span>
            </label>
          ))}
        </div>
        {mode === "password" && saved.mode !== "password" && !hasPassword && (
          <p className="muted small">Saving creates a server password, shown below.</p>
        )}

        <h3 className="settings-head">Server Password</h3>
        {hasPassword ? (
          <div className="secret-row">
            <code className="secret">{shown ? saved.password : "••••-••••-••••"}</code>
            <button className="secondary" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>
            <button className="secondary" onClick={() => {
              void navigator.clipboard.writeText(saved.password)
                .then(() => setNote("Copied."), () => setNote("Couldn't copy: the browser blocked the clipboard."));
            }}>Copy</button>
          </div>
        ) : (
          <p className="muted small">None set yet. Pick Server Password above and save, or set one here.</p>
        )}
        {saved.previous_valid_until && (
          <p className="muted small">The previous password still works until {when(saved.previous_valid_until)}.</p>
        )}
        {saved.mode !== "password" && hasPassword && (
          <p className="muted small">Not in use: sign-up is {saved.mode === "open" ? "open" : "closed"}.</p>
        )}

        {changing ? (
          <div className="secret-change">
            <label>
              New server password
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
            </label>
            <div className="row-actions">
              <button className="secondary" disabled={busy || typed.trim() === ""}
                onClick={() => void setPassword({ password: typed }, "Server password changed. The old one no longer works.")}>
                Set This Password
              </button>
              <button className="secondary" onClick={() => { setChanging(false); setTyped(""); }}>Cancel</button>
            </div>
            <p className="muted small">Needs to be as strong as an account password. Or generate one instead.</p>
          </div>
        ) : (
          <div className="row-actions">
            <button className="secondary" disabled={busy} onClick={() => setChanging(true)}>Change</button>
            <button className="secondary" disabled={busy}
              onClick={() => void setPassword({ generate: true }, hasPassword
                ? "New password generated. The old one no longer works."
                : "Server password generated.")}>
              {hasPassword ? "Rotate Now" : "Generate"}
            </button>
          </div>
        )}
        {hasPassword && <p className="muted small">Rotate Now if it leaked: the old one stops working at once.</p>}

        <h3 className="settings-head">Change Automatically</h3>
        <label>
          New password
          <select value={custom ? "custom" : String(rotation)} onChange={(e) => {
            if (e.target.value === "custom") {
              setCustom(true);
              setRotation(rotation || 48);
            } else {
              setCustom(false);
              setRotation(Number(e.target.value));
            }
          }}>
            {ROTATIONS.map(([h, label]) => <option key={h} value={h}>{label}</option>)}
            <option value="custom">Custom…</option>
          </select>
        </label>
        {custom && (
          <label>
            Every how many hours
            <input type="number" min={1} max={8760} value={rotation || ""}
              onChange={(e) => setRotation(Math.max(0, Math.min(8760, Math.round(Number(e.target.value) || 0))))} />
          </label>
        )}
        <p className="muted small">
          {saved.next_rotation
            ? `Next change: ${when(saved.next_rotation)}. `
            : ""}
          A new password is generated on schedule while sign-up uses one; the previous one keeps working for an hour.
          Remember to send people the new one.
        </p>

        {error && <p className="error" role="alert">{error}</p>}
        {note && !error && <p className="muted small" role="status">{note}</p>}
      </div>
      <div className="modal-actions modal-foot">
        <button className="save" onClick={() => void save()} disabled={busy || !dirty || (custom && rotation < 1)}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}
