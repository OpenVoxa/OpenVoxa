// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Link preview cards, fetched through the server's POST /api/v1/unfurl
 * so readers' addresses never reach the linked site for the page itself.
 * The server does learn the link, which is why encrypted channels only
 * preview when the user has opted in (settings.ts, PREVIEWS_ENCRYPTED).
 */

import { useEffect, useState } from "react";
import type { ApiCall } from "@core/identity";

interface Preview {
  url: string;
  site?: string;
  title?: string;
  description?: string;
  image?: string;
}

// One request per link per page load; null when it can't be previewed.
const cache = new Map<string, Promise<Preview | null>>();

function fetchPreview(call: ApiCall, url: string): Promise<Preview | null> {
  let p = cache.get(url);
  if (!p) {
    p = (call("/api/v1/unfurl", { method: "POST", body: JSON.stringify({ url }) }) as Promise<Preview>)
      .then((r) => (r && (r.title || r.description || r.image) ? r : null))
      .catch(() => null); // unreachable, blocked, rate limited or not a page
    cache.set(url, p);
  }
  return p;
}

export function youtubeID(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/** Only http(s), so a preview can't smuggle in a javascript: link. */
function safeUrl(u: string | undefined, fallback: string): string {
  return u && /^https?:\/\//i.test(u) ? u : fallback;
}

/**
 * fetch: ask the server for the card. Without it (an encrypted channel
 * the user hasn't opted in for) only a YouTube link shows anything: a
 * bare click-to-play box, which contacts nobody until clicked.
 */
export function LinkPreview({ call, url, fetch }: { call: ApiCall; url: string; fetch: boolean }) {
  const [fetched, setP] = useState<Preview | null>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!fetch) return;
    let live = true;
    void fetchPreview(call, url).then((r) => live && setP(r));
    return () => {
      live = false;
    };
  }, [call, url, fetch]);
  const vid = youtubeID(url);
  // A YouTube link still gets its player if the card couldn't be fetched.
  const p = (fetch ? fetched : null) ?? (vid ? ({ url, site: "YouTube" } as Preview) : null);
  if (!p) return null;

  const href = safeUrl(p.url, url);
  const image = p.image && /^https?:\/\//i.test(p.image) ? p.image : null;
  return (
    <div className="preview">
      {p.site && <div className="site small muted">{p.site}</div>}
      {p.title && (
        <div className="title"><a href={href} target="_blank" rel="noopener noreferrer nofollow">{p.title}</a></div>
      )}
      {p.description && <div className="desc small muted">{p.description}</div>}
      {vid ? (
        playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${vid}?autoplay=1`}
            allow="accelerometer; encrypted-media; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
            title={p.title ?? "YouTube video"}
          />
        ) : (
          // Click to load: embedding at once would contact YouTube for
          // every message with a link, watched or not.
          <button className="embed" onClick={() => setPlaying(true)} title="Play (loads from YouTube)">
            {image ? <img src={image} alt="" referrerPolicy="no-referrer" /> : <span className="no-thumb" />}
            <span className="play" aria-hidden>▶</span>
          </button>
        )
      ) : image ? (
        <img src={image} alt="" referrerPolicy="no-referrer" loading="lazy" />
      ) : null}
    </div>
  );
}
