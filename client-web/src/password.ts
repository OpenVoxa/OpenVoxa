// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Password rules, mirrored from server/internal/httpapi/password.go for
 * live feedback. The server is the one that decides.
 */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

export interface PasswordRule {
  readonly label: string;
  readonly ok: boolean;
}

export function passwordRules(p: string): PasswordRule[] {
  const length = [...p].length; // runes, like the server
  let symbol = false;
  for (const ch of p) {
    if (!/\p{L}|\p{Nd}|\s/u.test(ch)) symbol = true;
  }
  return [
    { label: `${MIN_PASSWORD}+ characters`, ok: length >= MIN_PASSWORD && length <= MAX_PASSWORD },
    { label: "upper-case letter", ok: /\p{Lu}/u.test(p) },
    { label: "lower-case letter", ok: /\p{Ll}/u.test(p) },
    { label: "number", ok: /\p{Nd}/u.test(p) },
    { label: "symbol", ok: symbol },
  ];
}
