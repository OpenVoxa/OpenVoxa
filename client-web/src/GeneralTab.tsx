// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server settings, General (administrators; server serverinfo.go;
 * decisions.md Feature decisions, "Server name and icon"): the server's
 * name and icon. Both are saved with Save.
 *
 * The icon is cropped here, in the browser: the administrator drags and
 * zooms the picture under a circle (the pane's shape), and the square
 * around it is drawn into a 256 x 256 canvas and uploaded as WebP (PNG
 * where the browser can't write WebP). Whatever was picked, a GIF or a
 * huge photo, the server only ever receives a small still image.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import type { ApiCall } from "@core/identity";
import { serverInfoChanged, useServerInfo } from "./serverInfo";

const NAME_MAX = 40;
const OUT_PX = 256; // the uploaded icon
const VIEW_PX = 256; // the crop area on screen
const ZOOM_MAX = 4;

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
  const [name, setName] = useState(saved.name);
  const [pending, setPending] = useState<Pending>({ kind: "keep" });
  const [cropSrc, setCropSrc] = useState<string | null>(null);
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

  // Object URLs hold the image in memory until revoked.
  useEffect(() => () => { if (pending.kind === "set") URL.revokeObjectURL(pending.url); }, [pending]);
  useEffect(() => () => { if (cropSrc) URL.revokeObjectURL(cropSrc); }, [cropSrc]);

  const trimmed = name.trim();
  const nameDirty = trimmed !== saved.name;
  const iconDirty = pending.kind === "set" || (pending.kind === "remove" && saved.icon !== null);
  const shown = pending.kind === "set" ? pending.url : pending.kind === "remove" ? null : saved.icon;

  function pick(files: FileList | null) {
    const f = files?.[0];
    if (fileInput.current) fileInput.current.value = "";
    if (!f) return;
    setError(null);
    setNote(null);
    setCropSrc(URL.createObjectURL(f));
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
      // Here too, not only through the server's event: this page (and in
      // the desktop app, its pane) must update even if the event is missed.
      serverInfoChanged();
      setName(trimmed);
      setPending({ kind: "keep" });
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
          <Cropper src={cropSrc}
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
              <button className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
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
          onChange={(e) => pick(e.target.files)} />
        <p className="muted small">
          Shown in the desktop app's server list, on browser tabs and on the sign-in page. PNG, JPEG, WebP or GIF
          (the first frame); you choose a square part of it, shown as a circle. Without an icon, the first letter of
          the name shows.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        {note && !error && <p className="muted small" role="status">{note}</p>}
      </div>
      <div className="modal-actions modal-foot">
        <button className="save" onClick={() => void save()} disabled={busy || cropSrc !== null || !(nameDirty || iconDirty)}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}

/**
 * Drag to move, the slider or the mouse wheel to zoom, arrow keys too.
 * The picture always covers the whole square, so the icon never has
 * empty corners.
 */
function Cropper({ src, onCancel, onDone, onError }: {
  src: string;
  onCancel: () => void;
  onDone: (blob: Blob) => void;
  onError: (msg: string) => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1); // 1: the short side fills the square
  const [pos, setPos] = useState({ x: 0, y: 0 }); // the picture's top left, in screen px
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const i = new Image();
    i.onload = () => {
      const s = VIEW_PX / Math.min(i.naturalWidth, i.naturalHeight);
      setImg(i);
      setZoom(1);
      setPos({ x: (VIEW_PX - i.naturalWidth * s) / 2, y: (VIEW_PX - i.naturalHeight * s) / 2 });
    };
    i.onerror = () => onError("That file isn't a picture this browser can open.");
    i.src = src;
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!img) return <p className="muted">Loading…</p>;

  const base = VIEW_PX / Math.min(img.naturalWidth, img.naturalHeight);
  const scale = base * zoom;
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const clamp = (p: { x: number; y: number }, ww = w, hh = h) => ({
    x: Math.min(0, Math.max(VIEW_PX - ww, p.x)),
    y: Math.min(0, Math.max(VIEW_PX - hh, p.y)),
  });

  // Zoom about the centre of the square, so what is in the middle stays there.
  function zoomTo(z: number) {
    const nz = Math.min(ZOOM_MAX, Math.max(1, z));
    const ns = base * nz;
    const c = VIEW_PX / 2;
    const nx = c - ((c - pos.x) / scale) * ns;
    const ny = c - ((c - pos.y) / scale) * ns;
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

  function finish() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = OUT_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) return onError("This browser couldn't crop the picture.");
    ctx.imageSmoothingQuality = "high";
    // The square on screen, in the picture's own pixels.
    const side = VIEW_PX / scale;
    ctx.drawImage(img!, -pos.x / scale, -pos.y / scale, side, side, 0, 0, OUT_PX, OUT_PX);
    canvas.toBlob((webp) => {
      // Browsers that can't write WebP quietly hand back a PNG.
      if (webp && webp.type === "image/webp") return onDone(webp);
      canvas.toBlob((png) => (png ? onDone(png) : onError("This browser couldn't crop the picture.")), "image/png");
    }, "image/webp", 0.9);
  }

  return (
    <div className="icon-crop">
      <div className="icon-crop-area" tabIndex={0} role="application"
        aria-label="Crop the icon: drag or use the arrow keys to move it, the mouse wheel or plus and minus to zoom"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} onKeyDown={key}>
        <img src={src} alt="" draggable={false}
          style={{ width: w, height: h, transform: `translate(${pos.x}px, ${pos.y}px)` }} />
        <div className="icon-crop-mask" />
      </div>
      <label className="icon-crop-zoom">
        Zoom
        <input type="range" min={1} max={ZOOM_MAX} step={0.01} value={zoom}
          onChange={(e) => zoomTo(Number(e.target.value))} />
      </label>
      <div className="row-actions">
        <button className="primary" onClick={finish}>Use This</button>
        <button className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
