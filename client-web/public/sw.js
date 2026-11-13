// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The service worker of the installable web app (decisions.md Feature
 * decisions, "Planned: installable web app (PWA)"). A service worker is a small
 * script the browser keeps beside the page; it sees the page's requests
 * and may answer them from a cache. This one caches the app shell only:
 * the page, its built scripts and styles, sounds and icons. API calls,
 * messages, attachments, avatars and the event socket are never touched
 * (no respondWith: the browser handles them as if there were no worker),
 * so nothing a user wrote or received is ever stored here, encrypted or
 * not.
 *
 * - The page (any navigation) is fetched from the network first, and from
 *   the cache only when that fails (offline, or the proxy's 502/503/504
 *   while the server restarts): an update is never hidden
 *   behind a cached copy. Offline, the app then shows its usual
 *   "reconnecting" state.
 * - Files under /assets/ carry a content hash in their name and never
 *   change, so they come from the cache first. When a new build's page
 *   arrives, the cached assets of the old one are dropped.
 * - Sounds and icons: cache first, refreshed in the background.
 *
 * Plain JavaScript in public/, not bundled: it must sit at /sw.js (a
 * worker only sees requests under its own folder) under a fixed name.
 */

const CACHE = "openvoxa-shell-v1";
const PAGE = "/";

/** The page's own app script, e.g. /assets/index-oy7t_le9.js. */
const SCRIPT = /\/assets\/index-[\w-]+\.js/;

self.addEventListener("install", (event) => {
  // Cache the page and every file it names, so the very first visit
  // already works offline next time (the worker didn't exist yet when
  // the page loaded them).
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch(PAGE, { cache: "no-store" });
    if (!res.ok) return;
    const html = await res.clone().text();
    await cache.put(PAGE, res);
    const files = new Set();
    for (const m of html.matchAll(/(?:src|href)="(\/(?:assets|icons)\/[^"]+)"/g)) files.add(m[1]);
    await Promise.all([...files].map((f) => cache.add(f).catch(() => {})));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(page(req));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(req));
  } else if (url.pathname.startsWith("/sounds/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(staleWhileRevalidate(event, req));
  }
  // Everything else (/api/, /desktop-updates/, the manifest, ...) is
  // left to the browser.
});

async function page(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // Only the app itself: a page under the same origin that isn't the
    // app (an error page from a proxy) is not worth keeping.
    if (res.ok && (res.headers.get("Content-Type") || "").startsWith("text/html")) {
      const html = await res.clone().text();
      const cached = await cache.match(PAGE);
      const before = cached ? SCRIPT.exec(await cached.text())?.[0] : undefined;
      const now = SCRIPT.exec(html)?.[0];
      if (now && before && now !== before) await dropAssets(cache);
      await cache.put(PAGE, res.clone());
    }
    // The proxy's own error page while the server is down or restarting:
    // the cached app is better, and it shows "Can't reach the server" and
    // tries again by itself (App.tsx).
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      const cached = await cache.match(PAGE);
      if (cached) return cached;
    }
    return res;
  } catch (err) {
    const cached = await cache.match(PAGE);
    if (cached) return cached;
    throw err;
  }
}

/** A new build: forget the old one's hashed files. */
async function dropAssets(cache) {
  for (const r of await cache.keys()) {
    if (new URL(r.url).pathname.startsWith("/assets/")) await cache.delete(r);
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // 200 only: a 206 (part of a file, e.g. a Range request) can't be cached.
  if (res.status === 200) await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const fresh = fetch(req).then(async (res) => {
    if (res.status === 200) await cache.put(req, res.clone());
    return res;
  });
  if (hit) {
    event.waitUntil(fresh.catch(() => {}));
    return hit;
  }
  return fresh;
}
