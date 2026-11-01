// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Password rules, mirrored from server/internal/httpapi/password.go for
 * live feedback. The server is the one that decides.
 */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

/** How many of the four character kinds a password needs. */
export const REQUIRED_KINDS = 3;

export interface PasswordCheck {
  readonly lengthOk: boolean;
  /** The four kinds, each with whether the password has it. */
  readonly kinds: ReadonlyArray<{ readonly label: string; readonly ok: boolean }>;
  readonly kindsOk: boolean;
  readonly ok: boolean;
}

export function checkPassword(p: string): PasswordCheck {
  const length = [...p].length; // runes, like the server
  let symbol = false;
  for (const ch of p) {
    if (!/\p{L}|\p{Nd}|\s/u.test(ch)) symbol = true;
  }
  const kinds = [
    { label: "upper-case", ok: /\p{Lu}/u.test(p) },
    { label: "lower-case", ok: /\p{Ll}/u.test(p) },
    { label: "number", ok: /\p{Nd}/u.test(p) },
    { label: "symbol", ok: symbol },
  ];
  const lengthOk = length >= MIN_PASSWORD && length <= MAX_PASSWORD;
  const kindsOk = kinds.filter((k) => k.ok).length >= REQUIRED_KINDS;
  return { lengthOk, kinds, kindsOk, ok: lengthOk && kindsOk };
}
