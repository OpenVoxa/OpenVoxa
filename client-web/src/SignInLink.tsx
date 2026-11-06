// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * QR login (decisions.md, Feature decisions, "Planned", "QR login
 * settled"; server signinlinks.go; client-core signinlink.ts).
 *
 * - SignInOtherDevice: Settings > Account on a signed-in device. Shows a
 *   one-time link as a QR code (and Copy Link), then asks "Sign in as
 *   <name> on <device>?" when someone opens it.
 * - LinkSignIn: the login page on the new device, after the link opened
 *   it (or was pasted). Waits for the approval, then signs in without a
 *   password and keeps the handover for Home (takeHandover).
 */

import { useEffect, useRef, useState } from "react";
import {
  handoverBytes, linkUrl, newLinkSecret, openHandover, parseLink, sealHandover,
  type Handover, type LinkParts,
} from "@core/signinlink";
import { storage } from "@core/storage";
import { ApiError, call, guessDeviceName, type Session } from "./api";
import { QrCode } from "./Recovery";
import { unlockForLink } from "./unlock";
import { staySignedInChoice, setStaySignedIn } from "./session";

const POLL_MS = 1500;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * A sign-in link in this page's address, taken out of it so it is not
 * left in the history or bookmarked. Called once, at startup.
 */
export function takeLinkFromLocation(): LinkParts | null {
  const parts = parseLink(location.href);
  if (parts) history.replaceState(null, "", location.pathname + location.search);
  return parts;
}

export { parseLink };

// The handover waits here between LinkSignIn and Home (App.tsx), which
// needs the device started before it can restore history.
let pending: { userId: string; handover: Handover } | null = null;

/** The handover for this account from a QR login just now, once. */
export function takeHandover(userId: string): Handover | null {
  const h = pending?.userId === userId ? pending.handover : null;
  pending = null;
  return h;
}

// ------------------------------------------------------------ new device

type Waiting =
  | { k: "claiming" }
  | { k: "waiting"; username: string }
  | { k: "finishing" }
  | { k: "failed"; error: string };

export function LinkSignIn({ parts, onSession, onCancel }: {
  parts: LinkParts;
  onSession: (s: Session, note?: string) => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<Waiting>({ k: "claiming" });

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      const { claim, username } = await call<{ claim: string; username: string }>(
        `/api/v1/sign-in-links/${parts.id}/claim`,
        { method: "POST", body: { device_name: guessDeviceName() } },
      );
      if (!live) return;
      setState({ k: "waiting", username });

      const poll = async () => {
        if (!live) return;
        let r: { status: string; session?: Session; payload?: string };
        try {
          r = await call(`/api/v1/sign-in-links/${parts.id}/status`, { method: "POST", body: { claim } });
        } catch (err) {
          if (!live) return;
          if (err instanceof ApiError && err.status === 404) {
            setState({ k: "failed", error: "The sign-in link expired before it was approved. Make a new one on your other device." });
          } else {
            // A network blip: keep trying until the link expires.
            timer = setTimeout(() => void poll(), POLL_MS);
          }
          return;
        }
        if (!live) return;
        if (r.status === "denied") {
          setState({ k: "failed", error: "Your other device said no." });
          return;
        }
        if (r.status !== "approved" || !r.session) {
          timer = setTimeout(() => void poll(), POLL_MS);
          return;
        }
        setState({ k: "finishing" });
        await finish(r.session, r.payload);
      };
      await poll();
    })().catch((err) => live && setState({ k: "failed", error: errText(err) }));
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts.id]);

  async function finish(s: Session, payload?: string) {
    // The login page's "Stay signed in" box, as it was last left.
    setStaySignedIn(staySignedInChoice());
    const handover = payload ? await openHandover(parts, fromBase64(payload)) : null;
    let how;
    try {
      how = await unlockForLink(s);
    } catch (err) {
      throw new Error(`Signed in, but this browser's encrypted storage could not be set up: ${errText(err)}`);
    }
    if (handover) pending = { userId: s.user_id, handover };
    onSession(s, how === "replaced"
      ? "This browser held your account under your password, which a link can't open, so it has been " +
        "set up again as a new device."
      : undefined);
  }

  let body;
  switch (state.k) {
    case "claiming":
      body = <p className="muted">Opening the sign-in link…</p>;
      break;
    case "waiting":
      body = (
        <>
          <p>Signing in as <strong>{state.username}</strong>.</p>
          <p className="muted">Approve it on your other device, where the QR code is showing.</p>
        </>
      );
      break;
    case "finishing":
      body = <p className="muted">Approved. Signing in…</p>;
      break;
    case "failed":
      body = <p className="error" role="alert">{state.error}</p>;
      break;
  }
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>OpenVoxa</h1>
        <p className="muted">Sign in with a link</p>
        {body}
        <button type="button" className="link" onClick={onCancel} disabled={state.k === "finishing"}>
          {state.k === "failed" ? "Back to sign in" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------- signed-in side

type Showing =
  | { k: "idle" }
  | { k: "starting" }
  | { k: "link"; parts: LinkParts; url: string; expires: number }
  | { k: "ask"; parts: LinkParts; device: string }
  | { k: "approving"; device: string };

export function SignInOtherDevice({ session }: { session: Session }) {
  const [show, setShow] = useState<Showing>({ k: "idle" });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // The link in flight: polled while set, cancelled on close. The ref is
  // for the unmount cleanup and for dropping answers about an old link.
  const [active, setActive] = useState<LinkParts | null>(null);
  const current = useRef<LinkParts | null>(null);

  const token = session.token;

  function cancelOnServer(parts: LinkParts | null) {
    if (parts) void call(`/api/v1/me/sign-in-links/${parts.id}`, { method: "DELETE", token }).catch(() => {});
  }

  function track(parts: LinkParts | null) {
    current.current = parts;
    setActive(parts);
  }

  // Leaving Settings with a link open cancels it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelOnServer(current.current), []);

  useEffect(() => {
    if (!active) return;
    const parts = active;
    const t = setInterval(() => {
      setNow(Date.now());
      call<{ status: string; device_name?: string }>(`/api/v1/me/sign-in-links/${parts.id}`, { token })
        .then((r) => {
          if (current.current !== parts) return;
          if (r.status === "claimed") {
            setShow((s) => s.k === "link" ? { k: "ask", parts, device: r.device_name ?? "a new device" } : s);
          } else if (r.status === "done") {
            track(null);
            setShow({ k: "idle" });
            setNote(`Signed in on ${r.device_name ?? "the new device"}.`);
          }
        }, (err) => {
          if (current.current !== parts) return;
          if (err instanceof ApiError && err.status === 404) {
            track(null);
            setShow({ k: "idle" });
            setNote("The link expired. Make a new one when you're ready.");
          }
        });
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function start() {
    setError(null);
    setNote(null);
    setShow({ k: "starting" });
    try {
      const r = await call<{ id: string; expires_at: string }>("/api/v1/me/sign-in-links", { method: "POST", token });
      const parts = { id: r.id, secret: newLinkSecret() };
      track(parts);
      setNow(Date.now());
      setShow({ k: "link", parts, url: linkUrl(location.origin, parts), expires: Date.parse(r.expires_at) });
    } catch (err) {
      setError(errText(err));
      setShow({ k: "idle" });
    }
  }

  function close() {
    cancelOnServer(current.current);
    track(null);
    setShow({ k: "idle" });
  }

  async function approve(parts: LinkParts, device: string) {
    setShow({ k: "approving", device });
    setError(null);
    try {
      // This browser's backup key goes along, so history comes too. None
      // here (recovery key never entered) means the new device asks for
      // the 12 words instead.
      const key = await storage.exportBackupKey();
      const handover: Handover = key
        ? { v: 1, backup: { id: key.backupId, key: handoverBytes.encode(key.raw) } }
        : { v: 1 };
      const payload = toBase64(await sealHandover(parts, handover));
      await call(`/api/v1/me/sign-in-links/${parts.id}/approve`, { method: "POST", token, body: { payload } });
    } catch (err) {
      setError(errText(err));
      close();
    }
  }

  function deny() {
    cancelOnServer(current.current);
    track(null);
    setShow({ k: "idle" });
    setNote("Sign-in refused.");
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNote("Link copied. It works once, for 2 minutes.");
    } catch {
      setNote("Couldn't copy: the browser blocked the clipboard.");
    }
  }

  let body;
  if (show.k === "link") {
    const left = Math.max(0, Math.round((show.expires - now) / 1000));
    body = (
      <div className="signin-link">
        <QrCode payload={show.url} plain alt="Sign-in link as a QR code" />
        <p className="muted small">
          Point your phone's camera at the code and open the link, or copy the link to the other device's
          browser or desktop app. It works once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.
          Only use it on your own devices: whoever opens it can sign in as you once you approve.
        </p>
        <div className="row-actions">
          <button className="secondary" onClick={() => void copy(show.url)}>Copy Link</button>
          <button className="secondary" onClick={close}>Cancel</button>
        </div>
      </div>
    );
  } else if (show.k === "ask" || show.k === "approving") {
    body = (
      <>
        <p>Sign in as <strong>{session.username}</strong> on <strong>{show.device}</strong>?</p>
        <p className="muted small">
          Approve only if you just opened the link on that device yourself. It signs in without your
          password or two-factor code.
        </p>
        <div className="row-actions">
          <button className="primary" disabled={show.k === "approving"}
            onClick={() => show.k === "ask" && void approve(show.parts, show.device)}>
            {show.k === "approving" ? "Approving…" : "Approve"}
          </button>
          <button className="danger" onClick={deny} disabled={show.k === "approving"}>Deny</button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="muted small">
          Sign in on your phone or another computer without typing your password: show a QR code here and
          open it there, then approve. Your message history comes along.
        </p>
        <div className="row-actions">
          <button className="secondary" onClick={() => void start()} disabled={show.k === "starting"}>
            {show.k === "starting" ? "…" : "Show QR Code"}
          </button>
        </div>
      </>
    );
  }

  return (
    <section className="settings-section">
      <h3 className="settings-head">Sign In on Another Device</h3>
      {body}
      {note && <p className="muted small" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
