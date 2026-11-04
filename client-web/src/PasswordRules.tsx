// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MIN_PASSWORD, type PasswordCheck } from "./password";

const LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"];

/** The live checklist and strength meter under a new-password field (signup, password change). */
export function PasswordRules({ pw, empty }: { pw: PasswordCheck; empty: boolean }) {
  const s = pw.strength;
  // Weak and Fair hint at what to change; Good and Strong need nothing.
  const level = s === null ? "" : pw.guessOk ? "good" : s.score >= 2 ? "fair" : "weak";
  return (
    <div className="password-rules">
      <ul className="rules" aria-label="Password requirements">
        <li className={pw.lengthOk ? "ok" : undefined}>
          {pw.lengthOk ? "✓" : "•"} {MIN_PASSWORD}+ characters
        </li>
        <li className={pw.usernameOk ? "ok" : undefined}>
          {pw.usernameOk ? "✓" : "•"} not your username
        </li>
        <li className={pw.guessOk ? "ok" : undefined}>
          {pw.guessOk ? "✓" : "•"} hard to guess
        </li>
      </ul>
      {!empty && (
        <div className="strength" aria-live="polite">
          <div className={`strength-bar ${level}`} aria-hidden="true">
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={s !== null && i <= Math.max(1, s.score) ? "on" : undefined} />
            ))}
          </div>
          <span className="strength-label">
            {s !== null ? LABELS[s.score] : pw.strengthUnknown ? "Can't check right now" : "Checking…"}
          </span>
        </div>
      )}
      {s !== null && !pw.guessOk && (s.warning || s.suggestions.length > 0) && (
        <p className="strength-hint">
          {[s.warning, ...s.suggestions].filter(Boolean).map((t) => (t.endsWith(".") ? t : t + ".")).join(" ")}
        </p>
      )}
    </div>
  );
}
