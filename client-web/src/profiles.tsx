// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The profile card (decisions.md Feature decisions, "User avatars and
 * profiles", stage 2; server profiles.go). Clicking a name (a message
 * author, someone in a voice channel through View Profile) opens it in
 * place of the old name menu: avatar, name in its colour, groups, bio,
 * custom status (statuses.tsx, live), "Joined <date>", last seen, then the actions that used to be the menu
 * (Message, Block; moderators Remove Avatar, Clear Bio and Clear Status;
 * on your own card, Set Status and Edit Profile).
 *
 * Fetched each time it opens, so it is never stale and nothing has to
 * keep it live.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ApiCall } from "@core/identity";
import { Avatar } from "./avatars";
import type { MenuItem } from "./ChannelMenu";
import { URL_RE } from "./markdown";
import { ColouredName } from "./names";
import { StatusLine } from "./statuses";

export interface Profile {
  user_id: string;
  username: string;
  /** YYYY-MM-DD, UTC. */
  joined: string;
  /** Most senior first; Everyone left out. */
  groups: { id: string; name: string }[];
  bio: string;
  /** False when either side has "Show when I was last online" off. */
  last_seen_shown: boolean;
  online: boolean;
  /** YYYY-MM-DD, UTC; null if not recorded yet. */
  last_seen_on: string | null;
}

/** Most characters and lines in a bio (the server's limits). */
export const BIO_MAX_CHARS = 300;
export const BIO_MAX_LINES = 8;

const DAY = 86_400_000;

/** "3 Nov 2026" from a YYYY-MM-DD date (UTC, so the day never shifts). */
export function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined,
    { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * The last-seen line, coarse on purpose: the server keeps only a date.
 * Days are counted in UTC, as the date was recorded.
 */
export function lastSeenText(p: Profile, now = Date.now()): string | null {
  if (!p.last_seen_shown) return null;
  if (p.online) return "Online now";
  if (!p.last_seen_on) return null;
  const today = Math.floor(now / DAY);
  const days = Math.max(0, today - Math.floor(Date.parse(`${p.last_seen_on}T00:00:00Z`) / DAY));
  if (days === 0) return "Last seen today";
  if (days === 1) return "Last seen yesterday";
  if (days < 14) return `Last seen ${days} days ago`;
  if (days < 60) return `Last seen ${Math.floor(days / 7)} weeks ago`;
  return `Last seen ${Math.floor(days / 30)} months ago`;
}

/** Plain text with its web links made clickable, nothing else. */
export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    if (i > at) out.push(text.slice(at, i));
    out.push(<a key={i} href={m[0]} target="_blank" rel="noopener noreferrer nofollow">{m[0]}</a>);
    at = i + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const CARD_WIDTH = 300;

export function ProfileCard({ userId, username, at, call, items, onClose }: {
  userId: string;
  /** Shown until the profile loads (and if it can't). */
  username: string;
  at: { x: number; y: number };
  call: ApiCall;
  /** The actions under the card; given the profile once loaded (null before). */
  items: (p: Profile | null) => (MenuItem | "sep")[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setProfile(null);
    setError(null);
    (call(`/api/v1/users/${userId}/profile`) as Promise<Profile>).then(
      (p) => live && setProfile(p),
      (err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [call, userId]);

  useEffect(() => {
    const off = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", off);
    window.addEventListener("touchstart", off);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", onClose);
    ref.current?.focus();
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("touchstart", off);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // Kept inside the window, measured each time the content changes size
  // (loading fills it in).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - CARD_WIDTH - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - el.offsetHeight - 4))}px`;
  });

  const name = profile?.username ?? username;
  const seen = profile && lastSeenText(profile);
  return (
    <div ref={ref} tabIndex={-1} className="menu channel-menu profile-card" role="dialog" aria-label={`${name}'s profile`}
      onContextMenu={(e) => e.preventDefault()}>
      <div className="profile-head">
        <Avatar userId={userId} name={name} className="profile-card-avatar" />
        <div className="profile-who">
          <ColouredName userId={userId} className="profile-card-name">{name}</ColouredName>
          <StatusLine userId={userId} className="profile-status" />
          {profile && profile.groups.length > 0 && (
            <div className="profile-groups">
              {profile.groups.map((g) => <span key={g.id} className="profile-group">{g.name}</span>)}
            </div>
          )}
        </div>
      </div>
      {!profile && !error && <p className="muted small profile-line">Loading…</p>}
      {error && <p className="error small profile-line" role="alert">{error}</p>}
      {profile?.bio && <p className="profile-bio">{linkify(profile.bio)}</p>}
      {profile && <p className="muted small profile-line">Joined {formatDay(profile.joined)}</p>}
      {seen && (
        <p className="muted small profile-line">
          {profile.online && <span className="online-dot" aria-hidden />}{seen}
        </p>
      )}
      {items(profile).map((i, n) => i === "sep"
        ? <div key={n} className="menu-sep" role="separator" />
        : (
          <button key={i.label} className={`menu-item${i.danger ? " danger" : ""}`}
            disabled={i.disabled} title={i.disabled ? i.reason : undefined}
            onClick={() => {
              onClose();
              i.onClick();
            }}>
            {i.label}
          </button>
        ))}
    </div>
  );
}
