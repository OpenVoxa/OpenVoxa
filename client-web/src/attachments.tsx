// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Files in messages: showing them (plain and encrypted) and uploading
 * them from the composer (picker, paste, drag and drop).
 *
 * Encrypted files are fetched as ciphertext from their signed URL and
 * decrypted here with the key from the message (client-core
 * attachments.ts). The plaintext becomes a blob: URL. A blob: URL belongs
 * to this page's origin, so an HTML file typed text/html and opened would
 * run script as us: the stored-XSS the server's inline allowlist exists to
 * stop. So the blob's type comes from that same allowlist (INLINE), never
 * from the sender, and everything else is an octet-stream that can only
 * be saved, never opened.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IMAGES_IN_TAB, useToggle } from "./settings";
import { decryptFile, type FileKey } from "@core/attachments";
import type { AttachmentInfo, ChannelView, Upload } from "@core/chat";

/**
 * Types shown inline, matching the server's inlineTypes. SVG is left
 * out: it can carry script.
 */
export const INLINE = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav))$/;

/** The server's cap on files per message (ws.go). */
export const MAX_FILES = 10;

/** Encrypted video/audio up to this size decrypts on sight; bigger waits for a click. */
const AUTO_MEDIA_BYTES = 10 * 1024 * 1024;

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ------------------------------------------------------------ showing

export function PlainAttachment({ a }: { a: AttachmentInfo }) {
  if (!a.url) return <span className="muted small">{a.filename} (still sending…)</span>;
  const kind = INLINE.test(a.content_type) ? a.content_type.split("/")[0] : null;
  if (kind === "image") return <ImageLink url={a.url} name={a.filename} lazy />;
  if (kind === "video") return <video className="att-media" src={a.url} controls preload="metadata" />;
  if (kind === "audio") return <audio src={a.url} controls preload="metadata" />;
  return (
    <a href={a.url} target="_blank" rel="noopener noreferrer" className="att-file">
      {a.filename} <span className="muted small">({formatSize(a.size)})</span>
    </a>
  );
}

/*
 * Decrypted copies, shared by every place showing the same file and kept
 * while anything shows it. Scrolling a message out of view and back (or
 * a re-render) reuses the copy instead of downloading and decrypting
 * again; a copy nobody has shown for a minute is freed.
 */
interface Decrypted {
  url: Promise<string>;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
}
const decrypted = new Map<string, Decrypted>();
const KEEP_MS = 60_000;

function acquire(a: AttachmentInfo, k: FileKey): Promise<string> {
  let d = decrypted.get(a.id);
  if (!d) {
    const url = (async () => {
      const res = await fetch(a.url!);
      if (!res.ok) throw new Error(res.status === 403 ? "link expired; reload the page" : `download failed (${res.status})`);
      const plain = await decryptFile(await res.arrayBuffer(), k);
      const type = INLINE.test(k.type) ? k.type : "application/octet-stream";
      return URL.createObjectURL(new Blob([plain as Uint8Array<ArrayBuffer>], { type }));
    })();
    d = { url, users: 0 };
    decrypted.set(a.id, d);
    // A failure is not cached: the next attempt starts over.
    url.catch(() => decrypted.get(a.id) === d && decrypted.delete(a.id));
  }
  if (d.timer) clearTimeout(d.timer);
  d.timer = undefined;
  d.users++;
  return d.url;
}

function release(id: string): void {
  const d = decrypted.get(id);
  if (!d || --d.users > 0) return;
  d.timer = setTimeout(() => {
    if (decrypted.get(id) !== d || d.users > 0) return;
    decrypted.delete(id);
    void d.url.then((u) => URL.revokeObjectURL(u), () => {});
  }, KEEP_MS);
}

/** Decrypt while mounted (once `on`); the blob: URL, or the error. */
function useDecrypted(a: AttachmentInfo, k: FileKey, on: boolean): { url?: string; error?: string } {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (!on || !a.url) return;
    let live = true;
    acquire(a, k).then(
      (url) => live && setState({ url }),
      (err) => live && setState({ error: errText(err) }),
    );
    return () => {
      live = false;
      release(a.id);
    };
  }, [a.id, a.url, k.key, on]);
  return state;
}

/**
 * A file its sender encrypted. k is the key from the message; without it
 * (the message can't be read on this device) there is nothing to show.
 */
export function SealedAttachment({ a, k }: { a: AttachmentInfo; k?: FileKey }) {
  if (!k) return <span className="muted small">Encrypted file (this device can't read the message it came with)</span>;
  if (!a.url) return <span className="muted small">{k.name} (still sending…)</span>;
  const kind = INLINE.test(k.type) ? k.type.split("/")[0] : null;
  if (kind === "image") return <SealedImage a={a} k={k} />;
  if (kind === "video" || kind === "audio") return <SealedMedia a={a} k={k} kind={kind} />;
  return <SealedFile a={a} k={k} />;
}

function SealedImage({ a, k }: { a: AttachmentInfo; k: FileKey }) {
  const { url, error } = useDecrypted(a, k, true);
  if (error) return <span className="error small">{k.name}: couldn't decrypt ({error})</span>;
  if (!url) return <span className="att-wait muted small">Decrypting {k.name}…</span>;
  // Opening it in a tab is safe: the blob is typed as a raster image.
  return <ImageLink url={url} name={k.name} />;
}

/**
 * An image in a message. Clicking opens the in-page viewer, or a new tab
 * if the user chose that in Settings. Ctrl/middle-click still opens a tab.
 */
function ImageLink({ url, name, lazy }: { url: string; name: string; lazy?: boolean }) {
  const inTab = useToggle(IMAGES_IN_TAB);
  const [open, setOpen] = useState(false);
  return (
    <>
      <a href={url} target="_blank" rel="noopener noreferrer" className="att-media"
        onClick={(e) => {
          if (inTab || e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          setOpen(true);
        }}>
        <img src={url} alt={name} title={name} loading={lazy ? "lazy" : undefined} />
      </a>
      {open && <ImageViewer url={url} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function ImageViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // A portal, so the message list's scrolling and stacking don't clip it.
  return createPortal(
    <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <img src={url} alt={name} onClick={(e) => e.stopPropagation()} />
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="viewer-name" title={name}>{name}</span>
        <a href={url} target="_blank" rel="noopener noreferrer">Open in new tab</a>
        <a href={url} download={name}>Download</a>
        <button className="secondary" onClick={onClose} autoFocus>Close</button>
      </div>
    </div>,
    document.body,
  );
}

function SealedMedia({ a, k, kind }: { a: AttachmentInfo; k: FileKey; kind: "video" | "audio" }) {
  // GCM can't be streamed into a player, so the whole file downloads
  // first. Small ones load on sight; big ones wait to be asked.
  const [on, setOn] = useState(k.size <= AUTO_MEDIA_BYTES);
  const { url, error } = useDecrypted(a, k, on);
  if (error) return <span className="error small">{k.name}: couldn't decrypt ({error})</span>;
  if (!on) {
    return (
      <button className="secondary att-load" onClick={() => setOn(true)}>
        ▶ Load {kind} {k.name} ({formatSize(k.size)})
      </button>
    );
  }
  if (!url) return <span className="att-wait muted small">Decrypting {k.name}…</span>;
  if (kind === "audio") return <audio src={url} controls title={k.name} />;
  return <video className="att-media" src={url} controls title={k.name} />;
}

function SealedFile({ a, k }: { a: AttachmentInfo; k: FileKey }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const { url, error } = useDecrypted(a, k, on);
  const want = useRef(false);

  // download= saves without navigating, so the blob is never opened as a
  // page on our origin, whatever it contains.
  const save = useCallback((u: string) => {
    const link = document.createElement("a");
    link.href = u;
    link.download = k.name;
    link.click();
  }, [k.name]);

  useEffect(() => {
    if (url && want.current) {
      want.current = false;
      setBusy(false);
      save(url);
    }
    if (error) setBusy(false);
  }, [url, error, save]);

  return (
    <span className="att-file">
      <button className="link" disabled={busy} onClick={() => {
        if (url) return save(url);
        want.current = true;
        setBusy(true);
        setOn(true);
      }}>
        {k.name}
      </button>{" "}
      <span className="muted small">
        ({formatSize(k.size)}{busy ? ", decrypting…" : ""})
      </span>
      {error && <span className="error small"> couldn't decrypt ({error})</span>}
    </span>
  );
}

// ---------------------------------------------------------- uploading

export interface UploadItem {
  /** Local only, for React keys. */
  readonly local: number;
  readonly name: string;
  readonly size: number;
  /** A local blob: URL to show a thumbnail of an image while composing. */
  readonly thumb?: string;
  readonly status: "uploading" | "ready" | "failed";
  readonly result?: Upload;
  readonly error?: string;
}

let nextLocal = 1;

/** A paste or drop with no name (a screenshot) gets one from its type. */
function nameFor(file: File): string {
  if (file.name) return file.name;
  const ext = file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
}

/**
 * The composer's files: each starts uploading the moment it's added, so a
 * too-big or refused file fails before the message is written.
 */
export function useUploads(view: ChannelView, onError: (text: string) => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const update = useCallback((local: number, patch: Partial<UploadItem>) => {
    setItems((list) => list.map((i) => (i.local === local ? { ...i, ...patch } : i)));
  }, []);

  const add = useCallback((files: Iterable<File>) => {
    const list = [...files];
    if (!list.length) return;
    const room = MAX_FILES - itemsRef.current.length;
    if (list.length > room) {
      onError(`At most ${MAX_FILES} files per message.`);
      list.splice(Math.max(room, 0));
    }
    for (const file of list) {
      const name = nameFor(file);
      const item: UploadItem = {
        local: nextLocal++,
        name,
        size: file.size,
        thumb: INLINE.test(file.type) && file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        status: "uploading",
      };
      itemsRef.current = [...itemsRef.current, item];
      setItems(itemsRef.current);
      view.upload(file, name).then(
        (result) => update(item.local, { status: "ready", result }),
        (err) => update(item.local, { status: "failed", error: errText(err) }),
      );
    }
  }, [view, update, onError]);

  const remove = useCallback((local: number) => {
    setItems((list) => {
      const gone = list.find((i) => i.local === local);
      if (gone?.thumb) URL.revokeObjectURL(gone.thumb);
      return list.filter((i) => i.local !== local);
    });
  }, []);

  /** After a send: forget the files (the server now owns them). */
  const clear = useCallback(() => {
    setItems((list) => {
      for (const i of list) if (i.thumb) URL.revokeObjectURL(i.thumb);
      return [];
    });
  }, []);

  // Thumbnails die with the pane (switching channel drops the tray; the
  // server sweeps unclaimed uploads after an hour).
  useEffect(() => () => {
    for (const i of itemsRef.current) if (i.thumb) URL.revokeObjectURL(i.thumb);
  }, []);

  return { items, add, remove, clear };
}

export function UploadTray({ items, onRemove }: { items: readonly UploadItem[]; onRemove: (local: number) => void }) {
  if (!items.length) return null;
  return (
    <ul className="upload-tray" aria-label="Files to send">
      {items.map((i) => (
        <li key={i.local} className={`upload ${i.status}`}>
          {i.thumb ? <img src={i.thumb} alt="" /> : <span className="upload-icon" aria-hidden>📄</span>}
          <span className="upload-name" title={i.name}>{i.name}</span>
          <span className="small muted">
            {i.status === "uploading" ? "Uploading…" : i.status === "failed" ? "" : formatSize(i.size)}
          </span>
          {i.error && <span className="small error" title={i.error}>{i.error}</span>}
          <button className="upload-x" onClick={() => onRemove(i.local)} title="Remove" aria-label={`Remove ${i.name}`}>×</button>
        </li>
      ))}
    </ul>
  );
}
