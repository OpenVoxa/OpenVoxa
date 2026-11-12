// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings, Profile (decisions.md Feature decisions, "User avatars and
 * profiles"; server avatars.go, profiles.go). What the profile card
 * shows about you on this server.
 *
 * Avatar: cropped in the browser with the server icon's crop tool (a
 * 256 x 256 square under a circle, uploaded as WebP, or PNG where the
 * browser can't write WebP) and saved as soon as it is cropped. The
 * last-seen switch saves when ticked, like the other Settings switches.
 * The status and bio are typed, so they share one Save button (bottom
 * left, as in Server settings), which saves whichever changed; this tab
 * draws its own footer for it.
 */

import { useEffect, useRef, useState } from "react";
import type { ApiCall } from "@core/identity";
import { Avatar, avatarChanged, useAvatarVersion } from "./avatars";
import { Cropper } from "./GeneralTab";
import { BIO_MAX_CHARS, BIO_MAX_LINES } from "./profiles";
import {
  draftDirty, draftFrom, statusBody, statusChanged, StatusFields, statusTooLong, type OwnStatus, type StatusDraft,
} from "./statuses";

type OwnProfile = { bio: string; show_last_seen: boolean; status: OwnStatus | null };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ProfileSettings({ call, userId, username, onClose }: {
  call: ApiCall;
  userId: string;
  username: string;
  onClose: () => void;
}) {
  const has = useAvatarVersion(userId) !== undefined;
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (cropSrc) URL.revokeObjectURL(cropSrc); }, [cropSrc]);

  // Status, bio and last seen (profiles.go, statuses.go). saved is what
  // the server has.
  const [saved, setSaved] = useState<OwnProfile | null>(null);
  const [bio, setBio] = useState("");
  const [status, setStatus] = useState<StatusDraft>(draftFrom(null));
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [bioNote, setBioNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (call("/api/v1/me/profile") as Promise<OwnProfile>).then(
      (p) => {
        if (!live) return;
        setSaved(p);
        setBio(p.bio);
        setStatus(draftFrom(p.status));
      },
      (err) => live && setProfileError(errText(err)));
    return () => {
      live = false;
    };
  }, [call]);

  async function patchProfile(body: { bio?: string; show_last_seen?: boolean; status?: OwnStatus | null }) {
    setProfileBusy(true);
    setProfileError(null);
    setBioNote(null);
    try {
      const p = await call("/api/v1/me/profile", { method: "PATCH", body: JSON.stringify(body) }) as OwnProfile;
      setSaved(p);
      if ("status" in body) statusChanged(userId, p.status);
      return p;
    } catch (err) {
      setProfileError(errText(err));
      return null;
    } finally {
      setProfileBusy(false);
    }
  }
  // One Save for the status and the bio: sends whichever changed.
  async function save() {
    const p = await patchProfile({
      ...(bioDirty ? { bio } : {}),
      ...(statusDirty ? { status: statusBody(status, saved?.status ?? null) } : {}),
    });
    if (p) {
      // The server tidies both (spaces, blank lines); show what it kept.
      setBio(p.bio);
      setStatus(draftFrom(p.status));
      setBioNote("Saved.");
    }
  }
  const bioChars = Array.from(bio.trim()).length;
  const bioLines = bio.trim() === "" ? 0 : bio.trim().split("\n").length;
  const bioTooLong = bioChars > BIO_MAX_CHARS || bioLines > BIO_MAX_LINES;
  const bioDirty = saved !== null && bio !== saved.bio;
  const statusDirty = saved !== null && draftDirty(status, saved.status);

  function pick(files: FileList | null) {
    const f = files?.[0];
    if (fileInput.current) fileInput.current.value = "";
    if (!f) return;
    setError(null);
    setNote(null);
    setCropSrc(URL.createObjectURL(f));
  }

  async function upload(blob: Blob) {
    setCropSrc(null);
    setBusy(true);
    try {
      const r = await call("/api/v1/me/avatar", {
        method: "PUT", body: blob, headers: { "Content-Type": blob.type },
      }) as { version: number };
      // Here too, not only through the server's event, so this page
      // updates even if the event is missed.
      avatarChanged(userId, r.version);
      setNote("Saved.");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await call("/api/v1/me/avatar", { method: "DELETE" });
      avatarChanged(userId, null);
      setNote("Removed.");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-body">
      <h3 className="settings-head">Avatar</h3>
      {cropSrc ? (
        <Cropper src={cropSrc} shape="avatar"
          onCancel={() => setCropSrc(null)}
          onError={(msg) => { setCropSrc(null); setError(msg); }}
          onDone={(blob) => void upload(blob)} />
      ) : (
        <div className="icon-row">
          <Avatar userId={userId} name={username} className="profile-avatar" />
          <div className="row-actions">
            <button className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
              {has ? "Change Avatar" : "Upload Avatar"}
            </button>
            <button className="secondary" disabled={busy || !has} onClick={() => void remove()}>
              Remove Avatar
            </button>
          </div>
        </div>
      )}
      <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => pick(e.target.files)} />
      <p className="muted small">
        Shown beside your messages, in voice channels and in direct messages, to everyone on this server (other
        servers don't see it). PNG, JPEG, WebP or GIF (the first frame, no animation); you choose a square part of
        it, shown as a circle. Without one, the first letter of your name shows. Moderators can remove an avatar.
      </p>
      {busy && <p className="muted small" role="status">Saving…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {note && !error && !busy && <p className="muted small" role="status">{note}</p>}

      <h3 className="settings-head">Status</h3>
      <StatusFields draft={status} saved={saved?.status ?? null} disabled={saved === null}
        onChange={(d) => { setStatus(d); setBioNote(null); }} />
      <p className="muted small">
        Shown on your profile card and under your name in voice channels, to everyone on this server. An emoji, a
        few words, or both; empty the box and remove the emoji (right-click it) to clear it. Moderators can clear a
        status.
      </p>

      <h3 className="settings-head">Bio</h3>
      <textarea className="bio-input" value={bio} disabled={saved === null} aria-label="Bio"
        placeholder="A few words about yourself" maxLength={BIO_MAX_CHARS * 2}
        onChange={(e) => { setBio(e.target.value); setBioNote(null); }} />
      <p className={`small bio-count ${bioTooLong ? "error" : "muted"}`}>
        {bioChars} / {BIO_MAX_CHARS} characters{bioLines > BIO_MAX_LINES ? `, ${bioLines} / ${BIO_MAX_LINES} lines` : ""}
      </p>
      <p className="muted small">
        Shown on your profile card, to everyone on this server. Plain text; links can be clicked. Moderators can
        clear a bio.
      </p>
      {bioNote && !bioDirty && !statusDirty && <p className="muted small" role="status">{bioNote}</p>}

      <h3 className="settings-head">Privacy</h3>
      <label className={`check${saved === null ? " disabled" : ""}`}>
        <input type="checkbox" checked={saved?.show_last_seen ?? true} disabled={saved === null || profileBusy}
          onChange={(e) => void patchProfile({ show_last_seen: e.target.checked })} />
        <span>
          Show when I was last online
          <span className="muted small block">
            On your profile card: "Online now" while you have OpenVoxa open, otherwise only the day ("Last seen
            yesterday"), never the time. Off: nobody sees yours, and you don't see anyone else's.
          </span>
        </span>
      </label>
      {profileError && <p className="error" role="alert">{profileError}</p>}
      </div>

      <div className="modal-actions modal-foot">
        <button className="save" onClick={() => void save()}
          disabled={profileBusy || !(bioDirty || statusDirty) || bioTooLong || statusTooLong(status)}>
          {profileBusy ? "Saving…" : "Save"}
        </button>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}
