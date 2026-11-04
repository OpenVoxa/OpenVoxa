// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Screen share quality: the presets, and the server-wide limit an
 * administrator sets in Server settings > Voice and Video (server
 * sharelimit.go).
 * The share dialog hides presets above the limit; client-core also caps
 * the capture and encoder to it, and the server stops shares that
 * declare more.
 */

import { useEffect, useState } from "react";
import type { ApiCall } from "@core/identity";

export interface Preset { label: string; width: number; height: number; fps: number; kbps: number }
export interface ShareLimit { res: number; fps: number; kbps: number }

// Duplicated from client-core's SHARE_PRESETS so the UI needs no runtime
// import of the (lazy) voice module.
export const PRESETS: readonly Preset[] = [
  { label: "720p 30fps", width: 1280, height: 720, fps: 30, kbps: 2500 },
  { label: "1080p 30fps", width: 1920, height: 1080, fps: 30, kbps: 4000 },
  { label: "1080p 60fps", width: 1920, height: 1080, fps: 60, kbps: 8000 },
  { label: "1440p 60fps", width: 2560, height: 1440, fps: 60, kbps: 14000 },
  { label: "4K 30fps", width: 3840, height: 2160, fps: 30, kbps: 20000 },
];

/** Same rule as client-core's presetAllowed. */
export function presetAllowed(p: Preset, limit: ShareLimit | null): boolean {
  return !limit || (Math.min(p.width, p.height) <= limit.res && p.fps <= limit.fps && p.kbps <= limit.kbps);
}

const limitOf = (p: Preset): ShareLimit => ({ res: Math.min(p.width, p.height), fps: p.fps, kbps: p.kbps });
const sameLimit = (a: ShareLimit | null, b: ShareLimit | null) =>
  a === b || (!!a && !!b && a.res === b.res && a.fps === b.fps && a.kbps === b.kbps);
const mbps = (kbps: number) => `${(kbps / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} Mbps`;

/** Share of the measured upload a suggestion may use; the rest is for voice, chat and everything else. */
const HEADROOM = 0.7;

interface UploadTest { mbps: number | null; at: string | null; site: string | null }

/**
 * The best choice for an upload and an audience: the highest preset whose
 * bitrate times viewers fits in HEADROOM of the upload; "none" when even
 * the highest fits; the lowest (with fits false) when nothing does.
 */
export function suggestChoice(uploadMbps: number, viewers: number): { choice: string; fits: boolean } {
  const budget = uploadMbps * 1000 * HEADROOM;
  let best = -1;
  PRESETS.forEach((p, i) => { if (p.kbps * viewers <= budget) best = i; });
  if (best === PRESETS.length - 1) return { choice: "none", fits: true };
  if (best < 0) return { choice: "0", fits: false };
  return { choice: String(best), fits: true };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Server settings > Voice and Video. Administrators only. Draws the
 * dialog's body and footer itself, so Save sits bottom left beside Done.
 */
export function VoiceTab({ call, onClose }: { call: ApiCall; onClose: () => void }) {
  const [saved, setSaved] = useState<ShareLimit | null | undefined>(undefined);
  const [choice, setChoice] = useState<string>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [viewers, setViewers] = useState("5");
  const viewerCount = Math.max(1, Number(viewers) || 1);

  useEffect(() => {
    let live = true;
    call("/api/v1/voice/share-limit")
      .then((d) => {
        if (!live) return;
        const limit = (d as { limit: ShareLimit | null }).limit ?? null;
        setSaved(limit);
        setChoice(choiceFor(limit));
      })
      .catch((err) => live && setError(errText(err)));
    return () => { live = false; };
  }, [call]);

  // A limit set some other way than a preset shows as itself.
  const custom = saved && PRESETS.every((p) => !sameLimit(limitOf(p), saved)) ? saved : null;
  const picked: ShareLimit | null =
    choice === "none" ? null : choice === "custom" ? custom : limitOf(PRESETS[Number(choice)]);

  async function save() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await call("/api/v1/voice/share-limit", { method: "PUT", body: JSON.stringify({ limit: picked }) });
      setSaved(picked);
      setDone(true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (saved === undefined) {
    return (
      <>
        <div className="modal-body">
          {error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>}
        </div>
        <div className="modal-actions modal-foot"><button className="primary" onClick={onClose}>Done</button></div>
      </>
    );
  }
  return (
    <>
    <div className="modal-body">
      <h3>Screen share quality limit</h3>
      <p className="muted small">
        The voice server sends a separate copy of each screen share to every viewer, so your upload
        carries about the share's bitrate times the number of people watching. A limit keeps one share
        from filling your connection. Shares above it are hidden from the share menu, and a share that
        goes over it anyway is stopped.
      </p>
      <label>
        Max screen share quality
        <select value={choice} onChange={(e) => { setChoice(e.target.value); setDone(false); }}>
          <option value="none">No limit</option>
          {PRESETS.map((p, i) => <option key={p.label} value={String(i)}>{p.label} ({mbps(p.kbps)})</option>)}
          {custom && <option value="custom">Custom: {custom.res}p {custom.fps}fps ({mbps(custom.kbps)})</option>}
        </select>
      </label>
      {picked && (
        <p className="muted small">
          Each viewer then costs you up to {mbps(picked.kbps)} of upload: {viewerCount} viewer{viewerCount === 1 ? "" : "s"}
          {" "}is about {mbps(picked.kbps * viewerCount)}.
        </p>
      )}
      <UploadTestSection call={call} viewers={viewers} setViewers={setViewers}
        onUse={(c) => { setChoice(c); setDone(false); }} current={choice} />
      {done && <p className="muted small">Saved. Shares already running are checked within a few seconds.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
      <div className="modal-actions modal-foot">
        <button className="save" onClick={() => void save()} disabled={busy || sameLimit(picked, saved)}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </>
  );

  function choiceFor(limit: ShareLimit | null): string {
    if (!limit) return "none";
    const i = PRESETS.findIndex((p) => sameLimit(limitOf(p), limit));
    return i >= 0 ? String(i) : "custom";
  }
}

/**
 * Measures this server's upload (server uploadtest.go: about ten seconds
 * of test data to Cloudflare's speed test) and suggests a limit for it.
 */
function UploadTestSection({ call, viewers, setViewers, onUse, current }: {
  call: ApiCall;
  viewers: string;
  setViewers: (v: string) => void;
  onUse: (choice: string) => void;
  current: string;
}) {
  const [last, setLast] = useState<UploadTest | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call("/api/v1/voice/upload-test")
      .then((d) => live && setLast(d as UploadTest))
      .catch((err) => live && setError(errText(err)));
    return () => { live = false; };
  }, [call]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setLast((await call("/api/v1/voice/upload-test", { method: "POST" })) as UploadTest);
    } catch (err) {
      setError(errText(err));
    } finally {
      setRunning(false);
    }
  }

  const n = Math.max(1, Number(viewers) || 1);
  const result = last?.mbps != null ? last.mbps : null;
  const tip = result !== null ? suggestChoice(result, n) : null;
  const tipLabel = tip ? (tip.choice === "none" ? "No limit" : PRESETS[Number(tip.choice)].label) : "";

  return (
    <div className="upload-test">
      <h3>This server's upload speed</h3>
      <p className="muted small">
        Measures the upload of the machine this server runs on, by sending test data to Cloudflare's
        speed test (speed.cloudflare.com) for about 10 seconds. Nothing is published. Shares may stutter
        while it runs.
      </p>
      <div className="inline-form">
        <button className="outline" onClick={() => void run()} disabled={running}>
          {running ? "Testing… (about 10 seconds)" : "Test upload speed"}
        </button>
        {result !== null && !running && (
          <span>
            <strong>{Math.round(result).toLocaleString()} Mbps</strong>
            <span className="muted small">
              {last?.at ? ` · tested ${new Date(last.at).toLocaleString()}` : ""}
              {last?.site ? ` · Cloudflare ${last.site}` : ""}
            </span>
          </span>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {tip && (
        <>
<div className="inline-form small viewers">
            <label className="inline">
              Viewers you expect at once
              <input value={viewers} onChange={(e) => setViewers(e.target.value.replace(/\D/g, "").slice(0, 3))}
                inputMode="numeric" className="narrow" aria-label="Viewers you expect at once" />
            </label>
          </div>
          <p className="small">
            Suggested: <strong>{tipLabel}</strong>
            {tip.fits
              ? <span className="muted"> (keeps {n} viewer{n === 1 ? "" : "s"} within {Math.round(HEADROOM * 100)}% of your upload, leaving room for voice and everything else)</span>
              : <span className="error"> Even the lowest quality is more than {Math.round(HEADROOM * 100)}% of your upload for {n} viewer{n === 1 ? "" : "s"}.</span>}
          </p>
          <div className="suggest-action">
            <button className="outline" onClick={() => onUse(tip.choice)} disabled={current === tip.choice}
              title={current === tip.choice ? "Already selected" : undefined}>Use this</button>
          </div>
        </>
      )}
    </div>
  );
}
