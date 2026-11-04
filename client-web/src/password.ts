// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Password rules (server/internal/password, decisions.md "Password
 * rules"). Length and "not your username" are checked here as you type;
 * how hard it is to guess (the common-password list and zxcvbn) is asked
 * of the server, POST /api/v1/auth/password-check, once typing pauses.
 * The server is the one that decides, on submit.
 */
import { useEffect, useState } from "react";
import { call } from "./api";

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 256;

/** Wait this long after the last keystroke before asking the server. */
const CHECK_DELAY_MS = 300;

/** What the server says about a password (passwordCheckResponse). */
export interface Strength {
  /** The refusal registering with it would get, or "". */
  readonly problem: string;
  /** zxcvbn's 0 (too guessable) to 4 (very unguessable). */
  readonly score: number;
  readonly min_score: number;
  readonly common: boolean;
  readonly warning: string;
  readonly suggestions: readonly string[];
}

export interface PasswordCheck {
  readonly lengthOk: boolean;
  readonly usernameOk: boolean;
  /**
   * The server's latest answer. While a newer check is waiting it is for
   * a slightly older version of the password, so the meter doesn't
   * flicker on every keystroke.
   */
  readonly strength: Strength | null;
  /** Asking the server failed (offline, rate limited): submit decides. */
  readonly strengthUnknown: boolean;
  /** Hard to guess, as far as the server has said (false while waiting). */
  readonly guessOk: boolean;
  /** Nothing known is wrong with it. Submit is still checked by the server. */
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

/**
 * Checks a new password as it is typed: locally at once, the server after
 * a pause. Off (`enabled` false) on the sign-in form, which shares the
 * field: a password being signed in with is never sent to be checked.
 */
export function usePasswordCheck(p: string, username: string, enabled = true): PasswordCheck {
  const [answer, setAnswer] = useState<{ pw: string; user: string; s: Strength | null } | null>(null);

  useEffect(() => {
    if (!enabled || p === "") return;
    let stale = false;
    const t = window.setTimeout(() => {
      call<Strength>("/api/v1/auth/password-check", {
        method: "POST",
        body: { password: p, username },
      })
        .then((s) => { if (!stale) setAnswer({ pw: p, user: username, s }); })
        .catch(() => { if (!stale) setAnswer({ pw: p, user: username, s: null }); });
    }, CHECK_DELAY_MS);
    return () => { stale = true; window.clearTimeout(t); };
  }, [p, username, enabled]);

  const length = [...p].length; // runes, like the server
  const lengthOk = length >= MIN_PASSWORD && length <= MAX_PASSWORD;
  const usernameOk = p !== "" && !containsUsername(p, username);
  const shown = enabled && p !== "" && answer !== null;
  const strength = shown ? answer.s : null;
  const strengthUnknown = shown && answer.s === null;
  const guessOk = strength !== null && !strength.common && strength.score >= strength.min_score;
  // Only a known refusal of exactly this password blocks; while waiting
  // (or if the check failed) the server has the final say on submit.
  const current = answer !== null && answer.pw === p && answer.user === username;
  const refused = current && answer.s !== null && answer.s.problem !== "";
  return {
    lengthOk, usernameOk, strength, strengthUnknown, guessOk,
    ok: lengthOk && usernameOk && !refused,
  };
}
