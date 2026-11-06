// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Recovery key screens: set one up (signup, or an older account asked
 * once) and enter one to restore history on a device that cannot read
 * the account's backup.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toString as qrSvg } from "qrcode";
import {
  BackupDamaged,
  InvalidRecoveryKey,
  NoBackup,
  RecoveryKey,
  WrongRecoveryKey,
} from "@core/recovery";
import type { BackupManager } from "./backup";

/** How many words the user retypes to prove they wrote the key down. */
const CONFIRM_WORDS = 3;

function message(err: unknown): string {
  if (err instanceof WrongRecoveryKey) return "That recovery key doesn't match this account's backup.";
  if (err instanceof InvalidRecoveryKey) return `That doesn't look right: ${err.message}.`;
  if (err instanceof NoBackup) return "This account has no backup.";
  if (err instanceof BackupDamaged) return `The backup couldn't be read: ${err.message}.`;
  return err instanceof Error ? err.message : String(err);
}

/** Three different word positions, in order, chosen at random. */
function pickPositions(): number[] {
  const all = Array.from({ length: 12 }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(0, CONFIRM_WORDS).sort((a, b) => a - b);
}

/** Same leniency as RecoveryKey.parse: any case, first four letters suffice. */
function sameWord(typed: string, word: string): boolean {
  const t = typed.trim().toLowerCase();
  return t === word || (t.length >= 4 && word.startsWith(t.slice(0, 4)) && word.startsWith(t));
}

/**
 * A QR code, drawn in the theme's colours (styles.css). `plain` draws it
 * black on white instead: for codes other apps scan (two-factor), since
 * many authenticator apps can't read a light-on-dark code.
 */
export function QrCode({ payload, alt = "Recovery key as a QR code", plain = false }: {
  payload: string;
  alt?: string;
  plain?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    qrSvg(payload, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: plain ? 4 : 2,
      color: plain ? { dark: "#000000", light: "#ffffff" }
        : { dark: css.getPropertyValue("--bg").trim(), light: css.getPropertyValue("--text").trim() },
    })
      .then((svg) => setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch(() => setSrc(null));
  }, [payload, plain]);
  return src ? <img className="qr" src={src} alt={alt} /> : null;
}

export function RecoverySetup({
  manager,
  onDone,
  onSkip,
  replacing = false,
  rotating = false,
}: {
  manager: BackupManager;
  onDone: () => void;
  /** Offer "Not now"; absent at signup. */
  onSkip?: () => void;
  /** Starting over after a lost key: the old backup becomes unreadable. */
  replacing?: boolean;
  /** Replacing a key that still works (Settings): history is re-uploaded, nothing is lost. */
  rotating?: boolean;
}) {
  // One key per visit to this screen; it is never stored anywhere.
  const key = useMemo(() => RecoveryKey.generate(), []);
  const words = key.words;
  const [step, setStep] = useState<"show" | "confirm">("show");
  const [positions, setPositions] = useState<number[]>(pickPositions);
  const [typed, setTyped] = useState<string[]>(() => Array(CONFIRM_WORDS).fill(""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toConfirm() {
    setPositions(pickPositions());
    setTyped(Array(CONFIRM_WORDS).fill(""));
    setError(null);
    setStep("confirm");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const wrong = positions.filter((p, i) => !sameWord(typed[i] ?? "", words[p]!));
    if (wrong.length) {
      const n = wrong.map((p) => p + 1);
      const list = n.length === 1 ? `Word ${n[0]} doesn't`
        : `Words ${n.slice(0, -1).join(", ")} and ${n[n.length - 1]} don't`;
      setError(`${list} match. Check what you wrote down.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await manager.backup.create(key);
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (step === "show") {
    return (
      <div className="auth-page">
        <div className="auth-card wide">
          <h1>Your recovery key</h1>
          <p className="muted">
            Encrypted messages can only be read on the devices that received them. This key
            unlocks an encrypted backup of them, so you can read your history after signing out
            or on a new device. Nobody else can recover it for you, not even the server's admins.
          </p>
          {replacing && !rotating && (
            <p className="error">
              Starting a new key makes the current backup unreadable for good.
            </p>
          )}
          {rotating && (
            <p className="error">
              Once you confirm it, your old key stops working. This browser uploads your history again under
              the new key, so nothing is lost here.
            </p>
          )}
          <ol className="word-grid">
            {words.map((w, i) => <li key={i}>{w}</li>)}
          </ol>
          <QrCode payload={key.qrPayload} />
          <p className="muted">
            Write the words down, or keep a photo of the QR code somewhere safe and offline.
            This is the only time they are shown.
          </p>
          <button className="primary" onClick={toConfirm}>I've saved it</button>
          {onSkip && <button className="link" onClick={onSkip}>{rotating ? "Cancel, keep my old key" : "Not now"}</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Check your key</h1>
        <p className="muted">Type these words from your recovery key.</p>
        {positions.map((p, i) => (
          <label key={p}>
            Word {p + 1}
            <input
              value={typed[i]}
              onChange={(e) => {
                const next = [...typed];
                next[i] = e.target.value;
                setTyped(next);
                setError(null);
              }}
              autoFocus={i === 0}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
        ))}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Saving backup…" : "Confirm"}
        </button>
        <button type="button" className="link" onClick={() => setStep("show")} disabled={busy}>
          Show the words again
        </button>
      </form>
    </div>
  );
}

export function RecoveryRestore({
  manager,
  onDone,
  onSkip,
  onLostKey,
  reason,
}: {
  manager: BackupManager;
  onDone: (summary: string) => void;
  onSkip: () => void;
  onLostKey: () => void;
  /** Why the key is needed, when there is a specific reason to give. */
  reason?: string | null;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let key: RecoveryKey;
    try {
      key = RecoveryKey.parse(text);
    } catch (err) {
      setError(message(err));
      return;
    }
    setBusy(true);
    try {
      const r = await manager.backup.restore(key);
      onDone(
        r.added
          ? `Restored ${r.added} message${r.added === 1 ? "" : "s"} from your backup.`
          : "Recovery key accepted. This device had everything already.",
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function lostKey() {
    if (confirm(
      "Start a new recovery key?\n\nThe current backup becomes unreadable for good, " +
      "and your other devices will ask for the new key.",
    )) onLostKey();
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>Enter your recovery key</h1>
        <p className="muted">
          {reason ?? "This device can't read your backup yet. Enter your 12 words to restore your " +
            "message history here and keep it backed up."}
        </p>
        <label>
          Recovery key
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            rows={3}
            placeholder="word word word …"
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Restoring…" : "Restore"}
        </button>
        <button type="button" className="link" onClick={onSkip} disabled={busy}>Skip for now</button>
        <button type="button" className="link" onClick={lostKey} disabled={busy}>I lost my key</button>
      </form>
    </div>
  );
}
