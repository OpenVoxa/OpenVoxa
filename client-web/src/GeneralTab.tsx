// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server settings, General (administrators; server serverinfo.go and
 * home.go; decisions.md Feature decisions, "Server name and icon" and
 * "Home page and community rules"): the server's name and icon, and the
 * Home page (banner, welcome, rules, rule enforcement). All saved with
 * Save.
 *
 * Pictures are cropped here, in the browser: the administrator drags and
 * zooms the picture in a frame (the icon under a circle, the pane's
 * shape; the banner at a chosen shape from 16:9 to 4:1), and the frame
 * is drawn into a canvas and uploaded as WebP (PNG where the browser
 * can't write WebP). Whatever was picked, a GIF or a huge photo, the
 * server only ever receives a modest still image.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { ApiCall } from "@core/identity";
import { serverInfoChanged, useServerInfo } from "./serverInfo";
import { refreshHome, useHome } from "./home";

const NAME_MAX = 40;
const ICON_PX = 256; // the uploaded icon, and its crop area on screen
const ZOOM_MAX = 4;
const HOME_TEXT_MAX = 8000; // home.go homeTextMax
// The banner: 1600 px wide, at a shape the server accepts (16:9 to 4:1).
const BANNER_W = 1600;
const BANNER_VIEW_W = 480; // the crop area on screen
const BANNER_MIN = 16 / 9;
const BANNER_MAX = 4;
const BANNER_SHAPES: [string, number][] = [["16:9", 16 / 9], ["2:1", 2], ["3:1", 3], ["4:1", 4]];
// Under the server's 2 MB, with room to spare; a PNG (no WebP in this
// browser) of a photo can be bigger, so it is made narrower until it fits.
const BANNER_BYTES = 1_900_000;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The pane's fallback: the name's first letter, else the address's. */
export function iconLetter(name: string): string {
  const src = name.trim() || location.hostname.replace(/^openvoxa\./i, "");
  return (Array.from(src)[0] ?? "?").toUpperCase();
}

type Pending =
  | { kind: "keep" }
  | { kind: "set"; blob: Blob; url: string }
  | { kind: "remove" };

export function GeneralTab({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const saved = useServerInfo();
  const savedHome = useHome();
  const [name, setName] = useState(saved.name);
  const [pending, setPending] = useState<Pending>({ kind: "keep" });
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [banner, setBanner] = useState<Pending>({ kind: "keep" });
  const [bannerSrc, setBannerSrc] = useState<string | null>(null);
  // null until /home answers: the fields then fill from it.
  const [welcome, setWelcome] = useState<string | null>(savedHome?.welcome ?? null);
  const [rules, setRules] = useState<string | null>(savedHome?.rules ?? null);
  const [enforce, setEnforce] = useState<boolean | null>(savedHome?.rules_enforced ?? null);
  const [askAgain, setAskAgain] = useState(false);
  const bannerInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Another administrator's change arrives live: take it, unless a
  // different name is being typed here.
  const lastSaved = useRef(saved.name);
  useEffect(() => {
    if (name.trim() === lastSaved.current) setName(saved.name);
    lastSaved.current = saved.name;
  }, [saved.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Home's texts: filled once /home answers; afterwards another
  // administrator's change is taken unless this field was edited.
  const lastHome = useRef(savedHome);
  useEffect(() => {
    if (!savedHome) return;
    const prev = lastHome.current;
    if (welcome === null || welcome.trim() === prev?.welcome) setWelcome(savedHome.welcome);
    if (rules === null || rules.trim() === prev?.rules) setRules(savedHome.rules);
    if (enforce === null || enforce === prev?.rules_enforced) setEnforce(savedHome.rules_enforced);
    lastHome.current = savedHome;
  }, [savedHome]); // eslint-disable-line react-hooks/exhaustive-deps

  // Object URLs hold the image in memory until revoked.
  useEffect(() => () => { if (pending.kind === "set") URL.revokeObjectURL(pending.url); }, [pending]);
  useEffect(() => () => { if (cropSrc) URL.revokeObjectURL(cropSrc); }, [cropSrc]);
  useEffect(() => () => { if (banner.kind === "set") URL.revokeObjectURL(banner.url); }, [banner]);
  useEffect(() => () => { if (bannerSrc) URL.revokeObjectURL(bannerSrc); }, [bannerSrc]);

  const trimmed = name.trim();
  const nameDirty = trimmed !== saved.name;
  const iconDirty = pending.kind === "set" || (pending.kind === "remove" && saved.icon !== null);
  const shown = pending.kind === "set" ? pending.url : pending.kind === "remove" ? null : saved.icon;
  const bannerDirty = banner.kind === "set" || (banner.kind === "remove" && saved.banner !== null);
  const bannerShown = banner.kind === "set" ? banner.url : banner.kind === "remove" ? null : saved.banner;

  const homeLoaded = savedHome !== null && welcome !== null && rules !== null && enforce !== null;
  const rulesTrim = (rules ?? "").trim();
  const rulesChanged = homeLoaded && rulesTrim !== savedHome.rules;
  // Enforcement needs rules: with the rules emptied, the box shows
  // unticked and greyed out (and saving turns enforcement off), but the
  // tick itself is kept, so typing rules back brings it back.
  const enforceBlocked = !rulesTrim;
  const enforceOn = !!enforce && !enforceBlocked;
  const homeDirty = homeLoaded && ((welcome ?? "").trim() !== savedHome.welcome || rulesChanged
    || enforceOn !== savedHome.rules_enforced);
  // Asking again only means something for changed rules that are enforced.
  const canAskAgain = homeLoaded && rulesChanged && enforceOn;
  const tooLong = (welcome ?? "").length > HOME_TEXT_MAX || (rules ?? "").length > HOME_TEXT_MAX;

  function pick(files: FileList | null, input: HTMLInputElement | null, open: (url: string) => void) {
    const f = files?.[0];
    if (input) input.value = "";
    if (!f) return;
    setError(null);
    setNote(null);
    open(URL.createObjectURL(f));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (nameDirty) {
        await call("/api/v1/server-info/name", { method: "PUT", body: JSON.stringify({ name: trimmed }) });
      }
      if (pending.kind === "set") {
        await call("/api/v1/server-icon", {
          method: "PUT", body: pending.blob, headers: { "Content-Type": pending.blob.type },
        });
      } else if (pending.kind === "remove" && saved.icon !== null) {
        await call("/api/v1/server-icon", { method: "DELETE" });
      }
      if (banner.kind === "set") {
        await call("/api/v1/server-banner", {
          method: "PUT", body: banner.blob, headers: { "Content-Type": banner.blob.type },
        });
      } else if (banner.kind === "remove" && saved.banner !== null) {
        await call("/api/v1/server-banner", { method: "DELETE" });
      }
      if (homeDirty) {
        await call("/api/v1/home", {
          method: "PUT",
          body: JSON.stringify({
            welcome: (welcome ?? "").trim(), rules: rulesTrim, rules_enforced: enforceOn,
            ask_again: canAskAgain && askAgain,
          }),
        });
      }
      // Here too, not only through the server's event: this page (and in
      // the desktop app, its pane) must update even if the event is missed.
      serverInfoChanged();
      void refreshHome();
      setName(trimmed);
      setWelcome((welcome ?? "").trim());
      setRules(rulesTrim);
      setPending({ kind: "keep" });
      setBanner({ kind: "keep" });
      setAskAgain(false);
      setNote("Saved.");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-body">
        <h3 className="settings-head">Server Name</h3>
        <input className="server-name-input" value={name} maxLength={NAME_MAX} placeholder={location.host}
          onChange={(e) => { setName(e.target.value); setNote(null); }} aria-label="Server name" />
        <p className="muted small">
          Shown in the desktop app's server list, on browser tabs and on the sign-in page. Leave it empty to show
          the address instead.
        </p>

        <h3 className="settings-head">Server Icon</h3>
        {cropSrc ? (
          <Cropper src={cropSrc} shape="icon"
            onCancel={() => setCropSrc(null)}
            onError={(msg) => { setCropSrc(null); setError(msg); }}
            onDone={(blob) => {
              setCropSrc(null);
              setPending({ kind: "set", blob, url: URL.createObjectURL(blob) });
            }} />
        ) : (
          <div className="icon-row">
            <div className="icon-preview" aria-label="How the icon looks in the desktop app">
              {shown ? <img src={shown} alt="" /> : <span>{iconLetter(trimmed)}</span>}
            </div>
            <div className="row-actions">
              <button className="secondary" disabled={busy || bannerSrc !== null} onClick={() => fileInput.current?.click()}>
                {shown ? "Change Icon" : "Upload Icon"}
              </button>
              <button className="secondary" disabled={busy || !shown}
                onClick={() => { setPending({ kind: "remove" }); setNote(null); }}>
                Remove Icon
              </button>
            </div>
          </div>
        )}
        <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => pick(e.target.files, fileInput.current, setCropSrc)} />
        <p className="muted small">
          Shown in the desktop app's server list, on browser tabs and on the sign-in page. PNG, JPEG, WebP or GIF
          (the first frame); you choose a square part of it, shown as a circle. Without an icon, the first letter of
          the name shows.
        </p>

        <h3 className="settings-head">Home Banner</h3>
        {bannerSrc ? (
          <Cropper src={bannerSrc} shape="banner"
            onCancel={() => setBannerSrc(null)}
            onError={(msg) => { setBannerSrc(null); setError(msg); }}
            onDone={(blob) => {
              setBannerSrc(null);
              setBanner({ kind: "set", blob, url: URL.createObjectURL(blob) });
            }} />
        ) : (
          <div className="banner-edit">
            {bannerShown
              ? <img className="banner-preview" src={bannerShown} alt="The Home banner" />
              : <div className="banner-preview empty muted">No banner</div>}
            <div className="row-actions">
              <button className="secondary" disabled={busy || cropSrc !== null} onClick={() => bannerInput.current?.click()}>
                {bannerShown ? "Change Banner" : "Upload Banner"}
              </button>
              <button className="secondary" disabled={busy || !bannerShown}
                onClick={() => { setBanner({ kind: "remove" }); setNote(null); }}>
                Remove Banner
              </button>
            </div>
          </div>
        )}
        <input ref={bannerInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => pick(e.target.files, bannerInput.current, setBannerSrc)} />
        <p className="muted small">
          Shown at the top of Home and of the sign-in page, so anyone who can reach this server can see it. A wide
          picture: you choose its shape, from 16:9 to 4:1.
        </p>

        <h3 className="settings-head">Home Welcome</h3>
        <textarea className="home-textarea" rows={6} value={welcome ?? ""} disabled={!homeLoaded}
          placeholder={homeLoaded ? "Welcome to the server! Say hello in #general." : "Loading…"}
          aria-label="Welcome text" onChange={(e) => { setWelcome(e.target.value); setNote(null); }} />
        <p className="muted small">
          The top of Home, for everyone signed in. Formatting works as in messages: **bold**, *italic*, links,
          and #channel links (paste a channel's link). {charsLeft(welcome)}
        </p>

        <h3 className="settings-head">Rules</h3>
        <textarea className="home-textarea" rows={8} value={rules ?? ""} disabled={!homeLoaded}
          placeholder={homeLoaded ? "1. Be kind.\n2. No spam." : "Loading…"}
          aria-label="Rules" onChange={(e) => { setRules(e.target.value); setNote(null); }} />
        <p className="muted small">Shown on Home under their own heading. {charsLeft(rules)}</p>
        <label className={`check${enforceBlocked ? " disabled" : ""}`}>
          <input type="checkbox" checked={enforceOn} disabled={!homeLoaded || enforceBlocked}
            onChange={(e) => { setEnforce(e.target.checked); setNote(null); }} />
          <span>
            Require everyone to accept the rules
            <span className="muted small block">
              {enforceBlocked
                ? homeLoaded && savedHome.rules_enforced
                  ? "Write the rules first. Saving with no rules turns this off."
                  : "Write the rules first."
                : "Anyone who hasn't accepted them sees only the rules until they do, and new accounts accept them " +
                  "when they join."}
            </span>
            {homeLoaded && !savedHome.rules_enforced && !enforceBlocked && (
              <span className="error small block ask-again-warning">
                Warning: turning this on disconnects everyone currently signed in (except you) at once, including
                from voice calls, and they can't use the server until they accept the rules.
              </span>
            )}
          </span>
        </label>
        <label className={`check${canAskAgain ? "" : " disabled"}`}>
          <input type="checkbox" checked={canAskAgain && askAgain} disabled={!canAskAgain}
            onChange={(e) => { setAskAgain(e.target.checked); setNote(null); }} />
          <span>
            Ask everyone to accept the changed rules
            <span className="muted small block">
              {canAskAgain
                ? "Everyone else sees the new rules at once and must accept them again. Leave it off for small fixes."
                : "Available when you change rules that everyone must accept."}
            </span>
            {canAskAgain && (
              <span className="error small block ask-again-warning">
                Warning: everyone currently signed in (except you) is disconnected at once, including from voice
                calls, and can't use the server until they accept the new rules.
              </span>
            )}
          </span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        {note && !error && <p className="muted small" role="status">{note}</p>}
      </div>
      <div className="modal-actions modal-foot">
        <button className="save" onClick={() => void save()}
          disabled={busy || cropSrc !== null || bannerSrc !== null || tooLong
            || !(nameDirty || iconDirty || bannerDirty || homeDirty)}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}

/** "1,234 characters left", only once it is getting close. */
function charsLeft(text: string | null): string {
  const left = HOME_TEXT_MAX - (text ?? "").length;
  if (left > 500) return "";
  return left >= 0 ? `${left} characters left.` : `${-left} characters too many.`;
}

/**
 * Drag to move, the slider or the mouse wheel to zoom, arrow keys too.
 * The picture always covers the whole frame, so the result never has
 * empty corners. The icon's frame is square under a circle; the banner's
 * is wide, at a shape picked from BANNER_SHAPES or the picture's own
 * (when that is one the server accepts).
 */
export function Cropper({ src, shape, onCancel, onDone, onError }: {
  src: string;
  /** icon and avatar: a 256 x 256 square under a circle. */
  shape: "icon" | "avatar" | "banner";
  onCancel: () => void;
  onDone: (blob: Blob) => void;
  onError: (msg: string) => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [ratio, setRatio] = useState(shape === "banner" ? 3 : 1);
  const [zoom, setZoom] = useState(1); // 1: the picture just covers the frame
  const [pos, setPos] = useState({ x: 0, y: 0 }); // the picture's top left, in screen px
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  const viewW = shape === "banner" ? BANNER_VIEW_W : ICON_PX;
  const viewH = Math.round(viewW / ratio);

  // The picture centred and just covering the frame, for this shape.
  function reset(i: HTMLImageElement, r: number) {
    const vh = Math.round(viewW / r);
    const s = Math.max(viewW / i.naturalWidth, vh / i.naturalHeight);
    setZoom(1);
    setPos({ x: (viewW - i.naturalWidth * s) / 2, y: (vh - i.naturalHeight * s) / 2 });
  }

  useEffect(() => {
    const i = new Image();
    i.onload = () => {
      setImg(i);
      reset(i, ratio);
    };
    i.onerror = () => onError("That file isn't a picture this browser can open.");
    i.src = src;
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!img) return <p className="muted">Loading…</p>;

  const own = img.naturalWidth / img.naturalHeight;
  const ownOK = own >= BANNER_MIN && own <= BANNER_MAX;
  const base = Math.max(viewW / img.naturalWidth, viewH / img.naturalHeight);
  const scale = base * zoom;
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const clamp = (p: { x: number; y: number }, ww = w, hh = h) => ({
    x: Math.min(0, Math.max(viewW - ww, p.x)),
    y: Math.min(0, Math.max(viewH - hh, p.y)),
  });

  function pickShape(r: number) {
    setRatio(r);
    reset(img!, r);
  }

  // Zoom about the centre of the frame, so what is in the middle stays there.
  function zoomTo(z: number) {
    const nz = Math.min(ZOOM_MAX, Math.max(1, z));
    const ns = base * nz;
    const cx = viewW / 2;
    const cy = viewH / 2;
    const nx = cx - ((cx - pos.x) / scale) * ns;
    const ny = cy - ((cy - pos.y) / scale) * ns;
    setZoom(nz);
    setPos(clamp({ x: nx, y: ny }, img!.naturalWidth * ns, img!.naturalHeight * ns));
  }

  function down(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setPos((p) => clamp({ x: p.x + e.clientX - d.x, y: p.y + e.clientY - d.y }));
    drag.current = { id: d.id, x: e.clientX, y: e.clientY };
  }
  function up() {
    drag.current = null;
  }
  function wheel(e: WheelEvent<HTMLDivElement>) {
    zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 32 : 8;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      setPos((p) => clamp({ x: p.x + m[0], y: p.y + m[1] }));
    } else if (e.key === "+" || e.key === "=") zoomTo(zoom * 1.1);
    else if (e.key === "-") zoomTo(zoom / 1.1);
  }

  /** The frame, drawn outW wide, as WebP (or PNG where WebP can't be written). */
  function render(outW: number): Promise<Blob | null> {
    const outH = Math.round(outW / ratio);
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    ctx.imageSmoothingQuality = "high";
    // The frame on screen, in the picture's own pixels.
    ctx.drawImage(img!, -pos.x / scale, -pos.y / scale, viewW / scale, viewH / scale, 0, 0, outW, outH);
    return new Promise((done) => {
      canvas.toBlob((webp) => {
        // Browsers that can't write WebP quietly hand back a PNG.
        if (webp && webp.type === "image/webp") return done(webp);
        canvas.toBlob(done, "image/png");
      }, "image/webp", 0.9);
    });
  }

  async function finish() {
    const fail = "This browser couldn't crop the picture.";
    if (shape !== "banner") {
      const b = await render(ICON_PX);
      return b ? onDone(b) : onError(fail);
    }
    // Never wider than the picture itself, and narrower until it fits.
    const widest = Math.min(BANNER_W, Math.round(viewW / scale));
    for (const width of [widest, Math.round(widest * 0.75), Math.round(widest * 0.6)]) {
      const b = await render(Math.max(width, 320));
      if (!b) return onError(fail);
      if (b.size <= BANNER_BYTES) return onDone(b);
    }
    onError("That picture is too detailed to fit in 2 MB; try another, or zoom in.");
  }

  const label = `Crop the ${shape === "avatar" ? "picture" : shape}: drag or use the arrow keys to move it,`
    + " the mouse wheel or plus and minus to zoom";
  return (
    <div className="icon-crop">
      {shape === "banner" && (
        <div className="row-actions banner-shapes" role="group" aria-label="Banner shape">
          {BANNER_SHAPES.map(([name, r]) => (
            <button key={name} className={ratio === r ? "primary" : "secondary"} aria-pressed={ratio === r}
              onClick={() => pickShape(r)}>{name}</button>
          ))}
          <button className={ratio === own ? "primary" : "secondary"} aria-pressed={ratio === own}
            disabled={!ownOK} onClick={() => pickShape(own)}
            title={ownOK ? "The picture's own shape" : "This picture is taller than 16:9 or thinner than 4:1"}>
            Whole Picture
          </button>
        </div>
      )}
      <div className={`icon-crop-area${shape === "banner" ? " banner" : ""}`} tabIndex={0} role="application"
        style={{ width: viewW, height: viewH }} aria-label={label}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} onKeyDown={key}>
        <img src={src} alt="" draggable={false}
          style={{ width: w, height: h, transform: `translate(${pos.x}px, ${pos.y}px)` }} />
        {shape !== "banner" && <div className="icon-crop-mask" />}
      </div>
      <label className="icon-crop-zoom" style={{ width: Math.min(viewW, 320) }}>
        Zoom
        <input type="range" min={1} max={ZOOM_MAX} step={0.01} value={zoom}
          onChange={(e) => zoomTo(Number(e.target.value))} />
      </label>
      <div className="row-actions">
        <button className="primary" onClick={() => void finish()}>Use This</button>
        <button className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
