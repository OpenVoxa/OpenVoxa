// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The GIF picker. Search results and thumbnails all come from our own
 * server (GET /api/v1/gifs/search, /gifs/media), so browsing never tells
 * the provider who is looking. Picking one makes the server download it
 * once and store it as an ordinary attachment (POST /channels/{id}/gifs),
 * which then goes out with a message.
 *
 * GIFs stay unencrypted even in encrypted channels: they are public
 * images the server fetched itself (decisions.md; Ryan's decision).
 */

import { useEffect, useRef, useState } from "react";
import type { ApiCall } from "@core/identity";
import type { AttachmentInfo } from "@core/chat";

interface GifConfig {
  enabled: boolean;
  provider: string;
  attribution: string;
}

interface GifResult {
  id: string;
  description: string;
  preview_url: string;
  width?: number;
  height?: number;
  token: string;
}

let config: Promise<GifConfig> | null = null;

/** Whether this server has GIF search; asked once per page load. */
export function useGifsEnabled(call: ApiCall): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    config ??= (call("/api/v1/gifs/config") as Promise<GifConfig>).catch(() => {
      config = null; // try again next time
      return { enabled: false, provider: "", attribution: "" };
    });
    void config.then((c) => live && setOn(!!c.enabled));
    return () => {
      live = false;
    };
  }, [call]);
  return on;
}

export function GifPicker({ call, channelId, onPick, onClose }: {
  call: ApiCall;
  channelId: string;
  /** The stored attachment, ready to send. */
  onPick: (a: AttachmentInfo) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[] | null>(null);
  const [credit, setCredit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  // Search as you type, after a pause: the server rate-limits searches.
  // An empty query shows what's trending.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setError(null);
      (call(`/api/v1/gifs/search?q=${encodeURIComponent(query.trim())}`) as Promise<{
        attribution: string;
        results: GifResult[];
      }>)
        .then((r) => {
          if (!live) return;
          setResults(r.results ?? []);
          setCredit(r.attribution ?? "");
        })
        .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    }, query ? 400 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [call, query]);

  // Close on Escape or a click outside.
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const click = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, [onClose]);

  async function pick(r: GifResult) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const info = (await call(`/api/v1/channels/${channelId}/gifs`, {
        method: "POST",
        body: JSON.stringify({ token: r.token, description: r.description }),
      })) as AttachmentInfo;
      await onPick(info);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="gif-picker" ref={box} role="dialog" aria-label="GIFs">
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search GIFs"
        aria-label="Search GIFs"
      />
      <div className={`gif-grid${busy ? " busy" : ""}`}>
        {results === null && !error && <span className="muted small">Loading…</span>}
        {results?.length === 0 && <span className="muted small">No GIFs found.</span>}
        {results?.map((r) => (
          <button key={r.id} className="gif" onClick={() => void pick(r)} title={r.description} disabled={busy}>
            <img src={r.preview_url} alt={r.description || "GIF"} loading="lazy" />
          </button>
        ))}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
      <div className="muted small">{busy ? "Sending…" : credit}</div>
    </div>
  );
}
