// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Custom stickers (decisions.md Open items, "Custom stickers"): the
 * server's set, the Stickers tab of the composer's emoji picker, a
 * sticker inside a message, and the Stickers tab of Server settings.
 *
 * The images need the session token, so they are fetched with it and
 * shown from blob: URLs, kept for the page's lifetime (a sticker id
 * never changes what it points at). The list is fetched once and again
 * whenever the server says it changed (stickers_changed).
 *
 * Sending a sticker sends its token as the message text (client-core
 * stickers.ts), so it works the same in plain and encrypted channels.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { ApiCall } from "@core/identity";
import type { StickerInfo, StickerLimits, StickerList } from "@core/stickers";

// ------------------------------------------------------------ the list

let source: { call: ApiCall; token: string } | null = null;
/** Replaced, never changed in place, so useSyncExternalStore sees each change. */
let state: { list: StickerList | null; failed: boolean } = { list: null, failed: false };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const images = new Map<string, Promise<string | null>>();

function changed() {
  for (const l of listeners) l();
}

/** Called by ChatApp once signed in: how to reach the server. */
export function configureStickers(call: ApiCall, token: string): void {
  if (source?.token !== token) {
    for (const p of images.values()) void p.then((url) => url && URL.revokeObjectURL(url));
    images.clear();
    state = { list: null, failed: false };
  }
  source = { call, token };
  void refreshStickers();
}

/** Fetch the list again (after stickers_changed, or a change made here). */
export function refreshStickers(): Promise<void> {
  if (!source) return Promise.resolve();
  const { call } = source;
  loading = (call("/api/v1/stickers") as Promise<StickerList>)
    .then((l) => {
      state = { list: l, failed: false };
    })
    .catch(() => {
      // Keep showing the last good list if there was one.
      state = { list: state.list, failed: !state.list };
    })
    .finally(() => {
      loading = null;
      changed();
    });
  return loading;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

function useStickerState() {
  return useSyncExternalStore(subscribe, () => state);
}

/** The server's stickers, or null until the first answer. */
export function useStickers(): StickerList | null {
  return useStickerState().list;
}

/** The image as a blob: URL, or null if it can't be fetched (removed). */
function stickerUrl(id: string): Promise<string | null> {
  let p = images.get(id);
  if (!p && source) {
    const { token } = source;
    p = fetch(`/api/v1/stickers/${id}/image`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
      .catch(() => null);
    images.set(id, p);
    // A failure (offline, or removed) is retried on the next request.
    void p.then((url) => url === null && images.delete(id));
  }
  return p ?? Promise.resolve(null);
}

function useStickerUrl(id: string): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setUrl(undefined);
    void stickerUrl(id).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [id]);
  return url;
}

// ------------------------------------------------------------ display

/** Display size in chat; images are scaled down to fit, never up. */
const SHOWN_PX = 160;

/** The image alone, scaled into a square box. */
function StickerImg({ id, box, label }: { id: string; box: number; label: string }) {
  const url = useStickerUrl(id);
  if (!url) return <span className="sticker-blank" style={{ width: box, height: box }} aria-label={label} />;
  return <img className="sticker-img" src={url} alt={label} title={label}
    style={{ maxWidth: box, maxHeight: box }} draggable={false} />;
}

/** A sticker inside a message. */
export function StickerMessage({ id }: { id: string }) {
  const stickers = useStickers();
  const s = stickers?.stickers.find((x) => x.id === id);
  if (stickers && !s) return <em className="muted">Sticker removed.</em>;
  const label = s ? (s.alt || `:${s.name}:`) : "Sticker";
  return (
    <div className="sticker">
      <StickerImg id={id} box={SHOWN_PX} label={label} />
    </div>
  );
}

// ------------------------------------------------------------ picker

/**
 * The Stickers tab of the composer's emoji picker (emoji.tsx), which
 * owns the box, Escape and click-outside.
 */
export function StickerPanel({ canManage, onPick, onDone }: {
  /** Holds manage_stickers: an empty set says where to add some. */
  canManage: boolean;
  onPick: (s: StickerInfo) => Promise<void>;
  /** After a successful pick: close the picker. */
  onDone: () => void;
}) {
  const { list: stickers, failed } = useStickerState();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (!state.list && !loading) void refreshStickers();
  }, []);

  const q = query.trim().toLowerCase().replace(/^:|:$/g, "");
  const shown = useMemo(() => (stickers?.stickers ?? []).filter((s) =>
    !q || s.name.includes(q) || s.alt.toLowerCase().includes(q)), [stickers, q]);

  async function pick(s: StickerInfo) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onPick(s);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const empty = stickers && stickers.stickers.length === 0;
  return (
    <div className="sticker-panel">
      <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search stickers" aria-label="Search stickers" disabled={!!empty}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown[0]) {
            e.preventDefault();
            void pick(shown[0]);
          }
        }} />
      <div className={`sticker-grid${busy ? " busy" : ""}`}>
        {!stickers && !failed && <span className="muted small">Loading…</span>}
        {!stickers && failed && <span className="error small">Couldn't load the stickers.</span>}
        {empty && (
          <span className="muted small">
            This server has no stickers yet.
            {canManage && " Add some in Server settings, Stickers."}
          </span>
        )}
        {stickers && !empty && shown.length === 0 && <span className="muted small">No stickers match.</span>}
        {shown.map((s) => (
          <button key={s.id} className="sticker-choice" onClick={() => void pick(s)} disabled={busy}
            title={`:${s.name}:`} aria-label={s.alt || s.name}>
            <StickerImg id={s.id} box={72} label={s.alt || s.name} />
          </button>
        ))}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
      {busy && <div className="muted small">Sending…</div>}
    </div>
  );
}

// ------------------------------------------------------------ settings tab

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sizeText(n: number): string {
  if (n >= 1024 * 1024) return `${+(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** A name from a filename: "Happy Cat (2).png" -> "happy_cat_2". */
function nameFromFile(filename: string): string {
  return filename.replace(/\.[^.]*$/, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
}

const NAME_RE = /^[a-z0-9_]{2,32}$/;
const ACCEPT = "image/png,image/apng,image/gif,image/webp";

/**
 * Server settings > Stickers. Everyone with manage_stickers adds,
 * renames and removes; administrators also set the limits.
 */
export function StickersTab({ call, canManage, isAdmin }: {
  call: ApiCall;
  canManage: boolean;
  isAdmin: boolean;
}) {
  const { list: stickers, failed } = useStickerState();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => void refreshStickers(), []);

  async function remove(s: StickerInfo) {
    if (!confirm(`Remove the sticker :${s.name}:? Messages that sent it will show "Sticker removed".`)) return;
    setError(null);
    try {
      await call(`/api/v1/stickers/${s.id}`, { method: "DELETE" });
      await refreshStickers();
    } catch (err) {
      setError(errText(err));
    }
  }

  if (!stickers) return <p className="muted">{failed ? "Couldn't load the stickers." : "Loading…"}</p>;
  const { limits } = stickers;
  const full = stickers.stickers.length >= limits.max_count;

  return (
    <div className="stickers-tab">
      <p className="muted small">
        Stickers are shared by the whole server: anyone who can post can send them, in any channel.
        {" "}{stickers.stickers.length} of {limits.max_count} used.
        {" "}Each one can be up to {sizeText(limits.max_bytes)} and {limits.max_px} x {limits.max_px} pixels
        (PNG, APNG, GIF or WebP; animated is fine).
      </p>
      {canManage && (full
        ? <p className="muted small">The server has as many stickers as it allows. Remove one to add another.</p>
        : <AddSticker call={call} limits={limits} />)}
      {error && <p className="error small" role="alert">{error}</p>}
      {stickers.stickers.length === 0
        ? <p className="muted">No stickers yet.</p>
        : (
          <ul className="sticker-list">
            {stickers.stickers.map((s) => (
              <li key={s.id}>
                <StickerImg id={s.id} box={56} label={s.alt || s.name} />
                {editing === s.id
                  ? <EditSticker call={call} s={s} onDone={() => setEditing(null)} />
                  : (
                    <>
                      <div className="sticker-meta">
                        <strong>:{s.name}:</strong>
                        {s.alt && <span className="small">{s.alt}</span>}
                        <span className="muted small">
                          {s.width} x {s.height}, {sizeText(s.size)}
                          {s.uploader ? `, added by ${s.uploader}` : ""}
                        </span>
                      </div>
                      {canManage && (
                        <div className="row-actions">
                          <button className="secondary" onClick={() => setEditing(s.id)}>Edit</button>
                          <button className="danger" onClick={() => void remove(s)}>Remove</button>
                        </div>
                      )}
                    </>
                  )}
              </li>
            ))}
          </ul>
        )}
      {isAdmin && <Limits call={call} limits={limits} />}
    </div>
  );
}

/** Reads the picked file's pixel size, to refuse an oversized one early. */
function imageSize(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function AddSticker({ call, limits }: { call: ApiCall; limits: StickerLimits }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  async function choose(f: File | undefined) {
    setError(null);
    setFile(null);
    setPreview(null);
    if (!f) return;
    if (f.size > limits.max_bytes) {
      setError(`That file is ${sizeText(f.size)}; stickers can be at most ${sizeText(limits.max_bytes)}.`);
      return;
    }
    const size = await imageSize(f);
    if (!size) {
      setError("That file isn't an image this browser can show.");
      return;
    }
    if (size.w > limits.max_px || size.h > limits.max_px) {
      setError(`That image is ${size.w} x ${size.h} pixels; stickers can be at most ${limits.max_px} x ${limits.max_px}.`);
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
    if (!name) setName(nameFromFile(f.name));
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setName("");
    setAlt("");
    if (fileInput.current) fileInput.current.value = "";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !NAME_RE.test(name)) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("name", name);
      form.append("alt", alt.trim());
      await call("/api/v1/stickers", { method: "POST", body: form });
      reset();
      await refreshStickers();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const nameOk = NAME_RE.test(name);
  return (
    <form className="add-sticker" onSubmit={submit}>
      <h3>Add a sticker</h3>
      <p className="muted small">
        A sticker belongs to the server, not to you: it stays if you delete your account
        (it just stops saying who added it).
      </p>
      <div className="add-sticker-row">
        {preview
          ? <img className="sticker-img" src={preview} alt="" style={{ maxWidth: 72, maxHeight: 72 }} />
          : <span className="sticker-blank" style={{ width: 72, height: 72 }} />}
        <div className="add-sticker-fields">
          <input ref={fileInput} type="file" accept={ACCEPT} aria-label="Sticker image"
            onChange={(e) => void choose(e.target.files?.[0])} />
          <label>
            Name
            <input value={name} maxLength={32} aria-invalid={!!name && !nameOk}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder="happy_cat" />
          </label>
          {name && !nameOk && <span className="error small">2 to 32 letters, digits or underscores.</span>}
          <label>
            Description (for screen readers)
            <input value={alt} maxLength={200} onChange={(e) => setAlt(e.target.value)}
              placeholder="A cat smiling" />
          </label>
        </div>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="row-actions">
        <button type="submit" className="primary" disabled={busy || !file || !nameOk}>
          {busy ? "Adding…" : "Add sticker"}
        </button>
        {(file || name || alt) && <button type="button" className="secondary" onClick={reset} disabled={busy}>Clear</button>}
      </div>
    </form>
  );
}

function EditSticker({ call, s, onDone }: { call: ApiCall; s: StickerInfo; onDone: () => void }) {
  const [name, setName] = useState(s.name);
  const [alt, setAlt] = useState(s.alt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOk = NAME_RE.test(name);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!nameOk) return;
    setBusy(true);
    setError(null);
    try {
      await call(`/api/v1/stickers/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, alt: alt.trim() }),
      });
      await refreshStickers();
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form className="sticker-meta edit-sticker" onSubmit={save}>
      <input value={name} maxLength={32} aria-label="Name" aria-invalid={!nameOk}
        onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} />
      <input value={alt} maxLength={200} aria-label="Description" placeholder="Description"
        onChange={(e) => setAlt(e.target.value)} />
      {!nameOk && <span className="error small">2 to 32 letters, digits or underscores.</span>}
      {error && <span className="error small" role="alert">{error}</span>}
      <div className="row-actions">
        <button type="submit" className="primary" disabled={busy || !nameOk}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="secondary" onClick={onDone} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

/** Administrator only: the limits for new stickers. */
function Limits({ call, limits }: { call: ApiCall; limits: StickerLimits }) {
  const initial = useCallback(() => ({
    kb: String(Math.round(limits.max_bytes / 1024)),
    px: String(limits.max_px),
    count: String(limits.max_count),
  }), [limits]);
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setV(initial()), [initial]);

  const kb = Number(v.kb), px = Number(v.px), count = Number(v.count);
  const valid = kb >= 16 && kb <= 10240 && px >= 64 && px <= 2048 && count >= 1 && count <= 1000;
  const same = kb * 1024 === limits.max_bytes && px === limits.max_px && count === limits.max_count;
  const digits = (s: string) => s.replace(/\D/g, "");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid || same) return;
    setBusy(true);
    setError(null);
    try {
      await call("/api/v1/stickers/limits", {
        method: "PUT",
        body: JSON.stringify({ max_bytes: kb * 1024, max_px: px, max_count: count }),
      });
      await refreshStickers();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="sticker-limits" onSubmit={save}>
      <h3>Limits</h3>
      <p className="muted small">For new stickers only: lowering a limit doesn't remove any already added.</p>
      <div className="inline-form small">
        <label className="inline">
          At most
          <input className="narrow" inputMode="numeric" value={v.kb} aria-label="Largest file in KB"
            onChange={(e) => setV({ ...v, kb: digits(e.target.value) })} />
          KB
        </label>
        <label className="inline">
          and
          <input className="narrow" inputMode="numeric" value={v.px} aria-label="Largest width and height in pixels"
            onChange={(e) => setV({ ...v, px: digits(e.target.value) })} />
          pixels a side
        </label>
        <label className="inline">
          ,
          <input className="narrow" inputMode="numeric" value={v.count} aria-label="Most stickers on the server"
            onChange={(e) => setV({ ...v, count: digits(e.target.value) })} />
          stickers
        </label>
        <button type="submit" className="secondary" disabled={busy || !valid || same}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {!valid && <p className="error small">16 to 10240 KB, 64 to 2048 pixels, 1 to 1000 stickers.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </form>
  );
}
