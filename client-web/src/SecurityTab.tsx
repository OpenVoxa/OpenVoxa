// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server settings, Security (administrators; server twofactor.go;
 * decisions.md Feature decisions, "Planned", two-factor): who must use
 * two-factor sign-in. Saved with Save. Accounts it newly covers that have
 * no two-factor are sent to the setup screen straight away.
 */

import { useEffect, useState } from "react";
import type { ApiCall } from "@core/identity";

type Required = "off" | "staff" | "everyone";

const MODES: { id: Required; label: string; help: string }[] = [
  { id: "off", label: "Off", help: "Nobody has to. Anyone can still turn it on in Settings, Account." },
  { id: "staff", label: "Staff", help: "Everyone in a group with any permission switch (moderators, administrators)." },
  { id: "everyone", label: "Everyone", help: "Every account on this server." },
];

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function SecurityTab({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const [saved, setSaved] = useState<Required | null>(null);
  const [mode, setMode] = useState<Required>("off");
  // Your own two-factor: needed before requiring it of anyone.
  const [mine, setMine] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    (call("/api/v1/security-settings") as Promise<{ two_factor_required: Required }>)
      .then((s) => { setSaved(s.two_factor_required); setMode(s.two_factor_required); })
      .catch((err) => setError(errText(err)));
    (call("/api/v1/me/two-factor") as Promise<{ enabled: boolean }>)
      .then((s) => setMine(s.enabled))
      .catch(() => setMine(false));
  }, [call]);

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const s = (await call("/api/v1/security-settings", {
        method: "PUT", body: JSON.stringify({ two_factor_required: mode }),
      })) as { two_factor_required: Required };
      setSaved(s.two_factor_required);
      setMode(s.two_factor_required);
      setNote("Saved.");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (saved === null || mine === null) {
    return (
      <div className="modal-body">
        {error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  return (
    <>
      <div className="modal-body">
        <h3 className="settings-head">Require Two-Factor Sign-In</h3>
        <div className="radio-list" role="radiogroup" aria-label="Who must use two-factor">
          {MODES.map((m) => {
            const blocked = m.id !== "off" && !mine;
            return (
              <label key={m.id} className={blocked ? "check disabled" : "check"}>
                <input type="radio" name="two-factor-required" checked={mode === m.id}
                  disabled={blocked} onChange={() => setMode(m.id)} />
                <span>
                  {m.label}
                  <span className="muted small block">{m.help}</span>
                </span>
              </label>
            );
          })}
        </div>
        {!mine && (
          <p className="muted small">Turn on two-factor for yourself first, in Settings, Account.</p>
        )}
        <p className="muted small">
          People this covers who don't have two-factor yet are taken to the setup screen straight away, even if
          they're already signed in, and can't do anything else until it's done. If someone loses their phone and
          their backup codes, remove their two-factor in Members.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        {note && !error && <p className="muted small" role="status">{note}</p>}
      </div>
      <div className="modal-actions modal-foot">
        <button className="save" onClick={() => void save()} disabled={busy || mode === saved}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}
