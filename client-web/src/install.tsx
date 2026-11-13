// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The installable web app (decisions.md Feature decisions, "Planned:
 * installable web app (PWA)"): registers the service worker (public/sw.js) and drives
 * the "Install App" buttons on the sign-in page and in Settings, About.
 *
 * Chrome, Edge and Android announce that a page can be installed with a
 * `beforeinstallprompt` event, which can come before React has drawn
 * anything; it is kept here, and the button calls its prompt() later.
 * There is no pop-up or banner of our own. Safari on iPhone and iPad has
 * no such event: there the button explains Share > Add to Home Screen.
 * Elsewhere (Firefox, Safari on a Mac, or when the app is already
 * installed, which also silences the event) the button is greyed out with
 * a tooltip.
 *
 * Inside the desktop app nothing is registered and the button isn't
 * offered: it is already an app, and its server views stay exactly as
 * they were.
 */

import { useState, useSyncExternalStore } from "react";

/** Chrome's install event; not in TypeScript's DOM types. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState =
  /** The desktop app. */
  | "desktop"
  /** Running as an installed app, or just installed. */
  | "installed"
  /** iPhone or iPad Safari: show how to add it by hand. */
  | "ios"
  /** The browser offered to install: the button prompts. */
  | "ready"
  /** Nothing to offer from the page. */
  | "unavailable";

let deferred: InstallPromptEvent | null = null;
let justInstalled = false;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

function inDesktopApp(): boolean {
  return "openvoxaDesktop" in window;
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  // iPads ask for desktop sites and report a Mac; touch gives them away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function currentState(): InstallState {
  if (inDesktopApp()) return "desktop";
  if (justInstalled || isStandalone()) return "installed";
  if (deferred) return "ready";
  if (isIOS()) return "ios";
  return "unavailable";
}

/** Called once from main.tsx, before the first render. */
export function startInstallSupport(): void {
  if (inDesktopApp()) return;
  window.addEventListener("beforeinstallprompt", (e) => {
    // Stops older Chrome versions from showing their own mini-bar.
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    justInstalled = true;
    notify();
  });
  // Development (Vite's server) has no built files to cache.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("service worker not registered", err);
      });
    });
  }
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    currentState,
  );
}

const TOOLTIPS: Partial<Record<InstallState, string>> = {
  installed: "This app is already installed.",
  unavailable: "This browser doesn't offer installing from the page. Look for Install or Add to Home Screen " +
    "in its menu, or use Chrome or Edge. If it's already installed, open it from your apps.",
};

const IOS_HINT = "Tap the Share button in Safari, then Add to Home Screen.";

/**
 * The "Install App" button. `look` is the button class: a link on the
 * sign-in page (beside the desktop download link), a normal button in
 * Settings. Not shown at all in the desktop app, nor on the sign-in page
 * of the installed app: like the desktop download link beside it, the
 * sign-in page only offers what applies, and a greyed link there still
 * reads as a link (phones have no tooltip to explain it). Settings, About
 * keeps it greyed with the reason.
 */
export function InstallButton({ look }: { look: "link" | "secondary" }) {
  const state = useInstallState();
  const [hint, setHint] = useState<string | null>(null);
  if (state === "desktop" || (state === "installed" && look === "link")) return null;

  async function install() {
    if (state === "ios") {
      setHint(IOS_HINT);
      return;
    }
    const e = deferred;
    if (!e) return;
    // A prompt can be shown once; the browser fires a new event if the
    // page can still be installed afterwards.
    deferred = null;
    notify();
    try {
      await e.prompt();
      const { outcome } = await e.userChoice;
      if (outcome === "accepted") {
        justInstalled = true;
        notify();
      }
    } catch {
      /* the browser refused to show it: nothing to do */
    }
  }

  const enabled = state === "ready" || state === "ios";
  const button = (
    <button type="button" className={look === "link" ? "link small" : "secondary"}
      onClick={() => void install()} disabled={!enabled} title={TOOLTIPS[state]}>
      Install App
    </button>
  );
  return (
    <>
      {look === "secondary" ? <div className="row-actions">{button}</div> : button}
      {hint && <p className="muted small" role="status">{hint}</p>}
    </>
  );
}
