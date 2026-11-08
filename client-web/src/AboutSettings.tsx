// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The About tab of the Settings dialog (decisions.md Feature decisions,
 * "About tab in Settings"): what OpenVoxa is, this server, this app, and
 * the connection, with "Copy Debug Info" for bug reports.
 *
 * Only staff see the server's exact version: it tells an attacker which
 * known bugs apply. The web client is embedded in the server, so that is
 * its version too; everyone sees the bundle's build id, which anyone can
 * read from the page anyway and which shows whether a refresh picked up
 * a new build.
 *
 * Bandwidth is what this page sends and receives (client-core
 * traffic.ts plus the call's WebRTC totals): a page can't see the rest of
 * the computer's traffic.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiCall } from "@core/identity";
import type { Chat } from "@core/chat";
import { countDown, countUp, sizeOf, trafficTotals } from "@core/traffic";
import type { VoiceClient, VoiceSnapshot } from "@core/voice";
import { isStaffPerms } from "./perms";

const GITHUB = "https://github.com/OpenVoxa/OpenVoxa";

interface ServerVersion { commit: string; date: string; dirty: boolean }
interface AppInfo { app: string; electron: string; chromium: string; os: string }
interface Me { username: string; permissions: string[]; groups: { id: string; name: string }[] }

/** One section of the debug info rows, as shown, copied and sent with a bug report. */
export interface DebugSection { section: string; items: [string, string][] }

/** The debug info as plain text, one "  key: value" line per row. */
export function debugText(sections: readonly DebugSection[]): string {
  const lines: string[] = [];
  for (const r of sections) {
    if (lines.length) lines.push("");
    lines.push(r.section);
    for (const [k, v] of r.items) lines.push(`  ${k}: ${v.replace(/\s+/g, " ")}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ the meter

let metering = false;

/**
 * Starts counting this page's HTTP traffic: request bodies going up,
 * and what the browser reports it received for each same-origin request
 * coming down. Called once, before anything is fetched.
 */
export function startTrafficMeter(): void {
  if (metering) return;
  metering = true;
  const fetch0 = window.fetch.bind(window);
  window.fetch = (input, init) => {
    countUp(sizeOf(init?.body));
    return fetch0(input, init);
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        if (e.name.startsWith(location.origin)) countDown(e.transferSize);
      }
    }).observe({ type: "resource", buffered: true });
  } catch {
    /* no resource timing: downloads go uncounted */
  }
}

/** Kilobits per second up and down, measured every second. Null until the second sample. */
function useBandwidth(voice: VoiceClient | null): { up: number; down: number } | null {
  const [rate, setRate] = useState<{ up: number; down: number } | null>(null);
  const prev = useRef<{ up: number; down: number; callUp: number; callDown: number; at: number } | null>(null);
  useEffect(() => {
    let live = true;
    const sample = async () => {
      const call = voice ? await voice.trafficBytes() : null;
      if (!live) return;
      const t = trafficTotals();
      const now = { up: t.up, down: t.down, callUp: call?.sent ?? 0, callDown: call?.received ?? 0, at: performance.now() };
      const p = prev.current;
      if (p && now.at > p.at) {
        const secs = (now.at - p.at) / 1000;
        // A new call starts its totals from zero: count it from there.
        const callUp = now.callUp >= p.callUp ? now.callUp - p.callUp : now.callUp;
        const callDown = now.callDown >= p.callDown ? now.callDown - p.callDown : now.callDown;
        setRate({
          up: ((now.up - p.up + callUp) * 8) / secs / 1000,
          down: ((now.down - p.down + callDown) * 8) / secs / 1000,
        });
      }
      prev.current = now;
    };
    void sample();
    const id = setInterval(() => void sample(), 1000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [voice]);
  return rate;
}

/** Re-renders every second, for the uptime. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// -------------------------------------------------------------- the tab

export function AboutSettings({ call, chat, voice, snap }: { call: ApiCall; chat: Chat; voice: VoiceClient | null; snap: VoiceSnapshot | null }) {
  const [me, setMe] = useState<Me | null>(null);
  const [version, setVersion] = useState<ServerVersion | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [sent, setSent] = useState(false);
  const rate = useBandwidth(voice);
  const now = useNow();
  const desktop = (window as unknown as { openvoxaDesktop?: { appInfo?: () => Promise<AppInfo | null> } }).openvoxaDesktop;

  useEffect(() => {
    let live = true;
    (call("/api/v1/me") as Promise<Me>).then((m) => {
      if (!live) return;
      setMe(m);
      if (isStaffPerms(m.permissions)) {
        (call("/api/v1/version") as Promise<ServerVersion>).then((v) => live && setVersion(v)).catch(() => {});
      }
    }).catch(() => {});
    desktop?.appInfo?.().then((a) => live && setAppInfo(a)).catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call]);

  const staff = isStaffPerms(me?.permissions ?? []);
  const since = chat.connectedSince;
  const inCall = snap?.state === "connected";

  const rows: DebugSection[] = [
    {
      section: "This Server",
      items: [
        ["Address", location.host],
        ...(staff ? [["Version", version ? versionText(version) : "Loading…"] as [string, string]] : []),
        ["Signed in as", me?.username ?? "…"],
        ["Groups", me ? (me.groups.map((g) => g.name).join(", ") || "None") : "…"],
      ],
    },
    {
      section: "This App",
      items: [
        ["Web client", `build ${bundleId()}`],
        ...(desktop
          ? appInfo
            ? ([
                ["Desktop app", appInfo.app],
                ["Electron", appInfo.electron],
                ["Chromium", appInfo.chromium],
                ["System", appInfo.os],
              ] as [string, string][])
            : ([["Desktop app", "Update the app to see its version"]] as [string, string][])
          : ([["Browser", browserName()]] as [string, string][])),
      ],
    },
    {
      section: "Connection",
      items: [
        ["Bandwidth", rate ? `↑ ${rateText(rate.up)}   ↓ ${rateText(rate.down)}` : "Measuring…"],
        ["In a call", inCall ? "Yes" : "No"],
        ["Chat connection", since ? `Connected for ${durationText(now - since)}` : "Not connected"],
      ],
    },
  ];

  // What Copy Debug Info copies and a bug report carries: a header
  // section (time, user agent), then the rows shown on this tab.
  const debug: DebugSection[] = [
    { section: "OpenVoxa debug info", items: [["Time", new Date(now).toISOString()], ["User agent", navigator.userAgent]] },
    ...rows,
  ];

  async function copyDebug() {
    try {
      await navigator.clipboard.writeText(debugText(debug));
      setCopied("Copied.");
    } catch {
      setCopied("Couldn't copy: this browser blocked the clipboard.");
    }
  }

  return (
    <>
      <section className="settings-section">
        <h3 className="settings-head">OpenVoxa</h3>
        <p>
          A self-hosted place to talk, with text channels, voice and screen share, run by whoever hosts this
          server. Non-commercial and free software.
        </p>
        <p className="muted small">
          Licensed under the GNU Affero General Public License v3.0 or later. Source code:{" "}
          <a href={GITHUB} target="_blank" rel="noreferrer">github.com/OpenVoxa/OpenVoxa</a>
        </p>
      </section>

      {rows.map((r) => (
        <section key={r.section} className="settings-section">
          <h3 className="settings-head">{r.section}</h3>
          <dl className="about-grid">
            {r.items.map(([k, v]) => (
              <div key={k} className="about-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {r.section === "Connection" && (
            <p className="muted small">
              Bandwidth is everything this page sends to and receives from this server: the call, chat and
              files. Other apps and tabs aren't included.
            </p>
          )}
        </section>
      ))}

      <section className="settings-section">
        <div className="row-actions">
          <button className="secondary" onClick={() => void copyDebug()}>Copy Debug Info</button>
          <button className="secondary" onClick={() => { setReporting(true); setSent(false); }}
            disabled={reporting}>Report a Bug</button>
        </div>
        {copied && <p className="muted small" role="status">{copied}</p>}
        {sent && <p className="muted small" role="status">Sent to this server's moderators and administrators. Thank you!</p>}
      </section>

      {reporting && (
        <BugReportForm call={call} debug={debug} onCancel={() => setReporting(false)}
          onSent={() => { setReporting(false); setSent(true); }} />
      )}
    </>
  );
}

// ------------------------------------------------------------ bug report

/**
 * Report a Bug: goes to this server's moderators and administrators (decisions.md,
 * Feature decisions, "Planned", bug reports, "Changed and settled"). The
 * debug info is shown in full before it goes, and can be left out.
 */
function BugReportForm({ call, debug, onCancel, onSent }: {
  call: ApiCall;
  debug: DebugSection[];
  onCancel: () => void;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [include, setInclude] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The rows as they were when the form opened, so what was shown is
  // what is sent (bandwidth and uptime keep moving on the tab).
  const [snapshot] = useState(debug);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("/api/v1/bug-reports", {
        method: "POST",
        body: JSON.stringify({ text, ...(include ? { debug: snapshot } : {}) }),
      });
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3 className="settings-head">Report a Bug</h3>
      <form className="settings-form" onSubmit={send}>
        <label>
          What went wrong?
          <textarea value={text} onChange={(e) => { setText(e.target.value); setError(null); }} rows={5}
            maxLength={4000} autoFocus required
            placeholder="What you were doing, what you expected, and what happened instead." />
        </label>
        <label className="check">
          <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
          <span>Include debug info</span>
        </label>
        {include && <pre className="debug-preview small">{debugText(snapshot)}</pre>}
        <p className="muted small">
          Goes to this server's moderators and administrators; administrators can pass real bugs on to the
          OpenVoxa project. No messages or keys are included.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row-actions">
          <button type="submit" className="primary" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send Report"}</button>
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

// ------------------------------------------------------------- helpers

function versionText(v: ServerVersion): string {
  if (v.commit === "unknown") return "Unknown (not built with Docker)";
  const date = v.date ? new Date(v.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  return `${v.commit}${v.dirty ? " + local changes" : ""}${date ? `, ${date}` : ""}`;
}

/** The content hash Vite puts in this bundle's file name; "development" under the dev server. */
function bundleId(): string {
  return /-([\w-]{6,})\.js(?:$|\?)/.exec(import.meta.url)?.[1] ?? "development";
}

function browserName(): string {
  const ua = navigator.userAgent;
  const m =
    /Edg\/(\d+)/.exec(ua) ? ["Edge", /Edg\/(\d+)/.exec(ua)![1]]
    : /OPR\/(\d+)/.exec(ua) ? ["Opera", /OPR\/(\d+)/.exec(ua)![1]]
    : /Firefox\/(\d+)/.exec(ua) ? ["Firefox", /Firefox\/(\d+)/.exec(ua)![1]]
    : /Chrome\/(\d+)/.exec(ua) ? ["Chrome", /Chrome\/(\d+)/.exec(ua)![1]]
    : /Version\/(\d+).*Safari/.exec(ua) ? ["Safari", /Version\/(\d+)/.exec(ua)![1]]
    : null;
  return m ? `${m[0]} ${m[1]}` : "Unknown browser";
}

function rateText(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps < 10 ? kbps.toFixed(1) : Math.round(kbps)} kbps`;
}

function durationText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s % 60} s`;
  return `${s} s`;
}
