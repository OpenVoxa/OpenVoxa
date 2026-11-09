// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings, Profile (decisions.md Feature decisions, "User avatars and
 * profiles"; server avatars.go). Stage 1: the account's avatar on this
 * server. The picture is cropped in the browser with the server icon's
 * crop tool (a 256 x 256 square under a circle, uploaded as WebP, or PNG
 * where the browser can't write WebP) and saved as soon as it is
 * cropped, like the other Settings tabs, which have no Save button.
 */

import { useEffect, useRef, useState } from "react";
import type { ApiCall } from "@core/identity";
import { Avatar, avatarChanged, useAvatarVersion } from "./avatars";
import { Cropper } from "./GeneralTab";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ProfileSettings({ call, userId, username }: { call: ApiCall; userId: string; username: string }) {
  const has = useAvatarVersion(userId) !== undefined;
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (cropSrc) URL.revokeObjectURL(cropSrc); }, [cropSrc]);

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
    </>
  );
}
