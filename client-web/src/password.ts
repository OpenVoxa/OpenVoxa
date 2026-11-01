// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Password rules, mirrored from server/internal/password for live
 * feedback. Everything except the common-password list (100,000 entries,
 * kept on the server only) is checked here as you type; the server is the
 * one that decides.
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
  /** Not the username and not mostly a pattern like qwerty or 12345. */
  readonly predictableOk: boolean;
  readonly ok: boolean;
}

// Look-alike swaps undone before comparing, as on the server.
const DELEET: Record<string, string> = {
  "@": "a", "4": "a", "0": "o", "3": "e", $: "s", "5": "s", "7": "t", "!": "i", "|": "l", "+": "t",
};

function deleet(s: string, one: string): string {
  return [...s].map((c) => (c === "1" ? one : DELEET[c] ?? c)).join("");
}

export function containsUsername(p: string, username: string): boolean {
  const u = username.trim().toLowerCase();
  if ([...u].length < 3) return false;
  const lower = p.toLowerCase();
  return lower.includes(u) || deleet(lower, "i").includes(u) || deleet(lower, "l").includes(u);
}

const KEYBOARD_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
const SAME = 1, UP = 2, DOWN = 4, KEY_RIGHT = 8, KEY_LEFT = 16;

function steps(a: string, b: string): number {
  let k = 0;
  if (a === b) k |= SAME;
  const letters = /\p{L}/u.test(a) && /\p{L}/u.test(b);
  const digits = /\p{Nd}/u.test(a) && /\p{Nd}/u.test(b);
  if (letters || digits) {
    const d = b.codePointAt(0)! - a.codePointAt(0)!;
    if (d === 1) k |= UP;
    if (d === -1) k |= DOWN;
  }
  for (const row of KEYBOARD_ROWS) {
    const i = row.indexOf(a), j = row.indexOf(b);
    if (i >= 0 && j >= 0) {
      if (j - i === 1) k |= KEY_RIGHT;
      if (j - i === -1) k |= KEY_LEFT;
    }
  }
  return k;
}

/** Runs of 3+ characters with the same predictable step cover more than half. */
export function mostlyPattern(p: string): boolean {
  const rs = [...p.toLowerCase()];
  let covered = 0, run = 1, kind = 0;
  for (let i = 1; i <= rs.length; i++) {
    if (i < rs.length) {
      const k = steps(rs[i - 1]!, rs[i]!);
      if (run === 1 && k !== 0) { kind = k; run = 2; continue; }
      if (run > 1 && (kind & k) !== 0) { kind &= k; run++; continue; }
    }
    if (run >= 3) covered += run;
    run = 1; kind = 0;
    if (i < rs.length) {
      const k = steps(rs[i - 1]!, rs[i]!);
      if (k !== 0) { kind = k; run = 2; }
    }
  }
  return covered * 2 > rs.length;
}

export function checkPassword(p: string, username = ""): PasswordCheck {
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
  const predictableOk = p !== "" && !containsUsername(p, username) && !mostlyPattern(p);
  return { lengthOk, kinds, kindsOk, predictableOk, ok: lengthOk && kindsOk && predictableOk };
}
