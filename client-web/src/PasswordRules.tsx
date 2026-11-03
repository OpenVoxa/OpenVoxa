// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MIN_PASSWORD, REQUIRED_KINDS, type PasswordCheck } from "./password";

/** The live checklist under a new-password field (signup, password change). */
export function PasswordRules({ pw }: { pw: PasswordCheck }) {
  return (
    <ul className="rules" aria-label="Password requirements">
      <li className={pw.lengthOk ? "ok" : undefined}>
        {pw.lengthOk ? "✓" : "•"} {MIN_PASSWORD}+ characters
      </li>
      <li className={pw.kindsOk ? "ok" : undefined}>
        {pw.kindsOk ? "✓" : "•"} {REQUIRED_KINDS} of 4:{" "}
        {pw.kinds.map((k, i) => (
          <span key={k.label} className={k.ok ? "ok" : undefined}>
            {i > 0 && ", "}{k.label}
          </span>
        ))}
      </li>
      <li className={pw.predictableOk ? "ok" : undefined}>
        {pw.predictableOk ? "✓" : "•"} not your username or a simple pattern
      </li>
    </ul>
  );
}
