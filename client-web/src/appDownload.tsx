// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "get the app" link under the login card (decisions.md, "Login page
// download link"). It is shown only where an app exists for the browser's
// own platform, and never inside the desktop app itself.
//
// Each platform has an entry in APPS saying how to find its download. Only
// Windows has one today: the newest installer is named in the same
// latest.yml the installed apps check for updates, so the link always
// follows the newest release and a server without an update folder simply
// shows nothing. Android and iOS will be store links, so their entries will
// return a fixed address and their own hint.

import { useEffect, useState } from "react";

type Platform = "windows" | "mac" | "linux" | "android" | "ios" | "other";

interface AppLink {
  /** Link text. */
  label: string;
  href: string;
  /** A file name makes the browser save it instead of opening it. */
  fileName?: string;
  /** Shown under the link once it has been clicked. */
  afterClick?: string;
}

interface AppSource {
  /** Finds the current download, or null when this server has none. */
  find: () => Promise<AppLink | null>;
}

const APPS: Partial<Record<Platform, AppSource>> = {
  windows: {
    async find() {
      const r = await fetch("/desktop-updates/latest.yml", { cache: "no-store" });
      if (!r.ok) return null;
      // electron-builder writes the installer's name on a top-level
      // "path:" line; no YAML parser needed for that.
      const m = /^path:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(await r.text());
      if (!m || !/\.exe$/i.test(m[1]) || m[1].includes("/")) return null;
      return {
        label: "Get the desktop app for Windows",
        href: `/desktop-updates/${encodeURIComponent(m[1])}`,
        fileName: m[1],
        // The installer is unsigned for now (decisions.md, "Unsigned for now").
        afterClick: `Downloading ${m[1]}. If Windows says "Windows protected your PC", ` +
          "choose More info, then Run anyway.",
      };
    },
  },
};

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPads ask for desktop sites and report a Mac; touch gives them away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh/.test(ua)) return "mac";
  if (/Linux|X11|CrOS/.test(ua)) return "linux";
  return "other";
}

/** True inside the desktop app's server view (its preload adds the bridge). */
function inDesktopApp(): boolean {
  return "openvoxaDesktop" in window;
}

export function AppDownload() {
  const [link, setLink] = useState<AppLink | null>(null);
  const [clicked, setClicked] = useState(false);

  useEffect(() => {
    if (inDesktopApp()) return;
    const source = APPS[detectPlatform()];
    if (!source) return;
    let live = true;
    source.find().then((l) => { if (live) setLink(l); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!link) return null;
  return (
    <div className="app-download">
      <a className="small" href={link.href} download={link.fileName}
        onClick={() => setClicked(true)}>
        {link.label}
      </a>
      {clicked && link.afterClick && <p className="muted small" role="status">{link.afterClick}</p>}
    </div>
  );
}
