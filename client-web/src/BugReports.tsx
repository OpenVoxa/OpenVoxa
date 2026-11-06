// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server settings, Bug Reports: holders of View reports, so moderators
 * and administrators (server bugreports.go; decisions.md, Feature
 * decisions, "Planned", bug reports, "Changed and settled"). Users file
 * reports in Settings, About.
 *
 * Send to GitHub is administrators only (greyed for moderators). It opens a prefilled issue in the administrator's own
 * browser (the desktop app hands it to the system browser), where they
 * edit and submit it with their own account. It leaves out who reported
 * it and this server's address, and adds this server's version, which
 * the reporter (not staff) could not see.
 */

import { useEffect, useState } from "react";
import type { ApiCall } from "@core/identity";
import { debugText, type DebugSection } from "./AboutSettings";

const NEW_ISSUE = "https://github.com/OpenVoxa/OpenVoxa/issues/new";
// GitHub refuses very long addresses; leave room under ~8 KB.
const MAX_URL = 7000;
// Rows that say who and where, never forwarded.
const PRIVATE_ROWS = new Set(["Address", "Signed in as", "Groups"]);

interface BugReport {
  id: string;
  reporter: string;
  text: string;
  debug?: DebugSection[];
  gone: boolean;
  status: "open" | "closed";
  sent_to_github_at: string | null;
  created_at: string;
  closed_at: string | null;
}

interface ServerVersion { commit: string; date: string; dirty: boolean }

const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDebug(v: unknown): v is DebugSection[] {
  return Array.isArray(v) && v.every((s) => s && typeof s.section === "string" && Array.isArray(s.items));
}

/** The debug rows fit to leave the server: private rows out, this server's version in. */
function forwardable(debug: DebugSection[] | undefined, version: ServerVersion | null): DebugSection[] {
  const v = version
    ? `${version.commit}${version.dirty ? " + local changes" : ""}${version.date ? `, ${version.date}` : ""}`
    : null;
  const out = (debug ?? []).map((s) => ({
    section: s.section,
    items: s.items.filter(([k]) => !PRIVATE_ROWS.has(k) && !(k === "Version" && s.section === "This Server")),
  }));
  if (v) {
    const server = out.find((s) => s.section === "This Server");
    if (server) server.items.unshift(["Version", v]);
    else out.push({ section: "This Server", items: [["Version", v]] });
  }
  return out.filter((s) => s.items.length > 0);
}

/** The prefilled new-issue address, shortening the report text if it is too long. */
export function issueUrl(text: string, debug: DebugSection[]): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  const title = firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine;
  const build = (t: string) => {
    const body = [
      t,
      "",
      ...(debug.length ? ["<details><summary>Debug info</summary>", "", "```", debugText(debug), "```", "</details>", ""] : []),
      "_Forwarded by the administrator of a self-hosted OpenVoxa server._",
    ].join("\n");
    return `${NEW_ISSUE}?${new URLSearchParams({ title, body }).toString()}`;
  };
  let t = text.trim();
  let url = build(t);
  while (url.length > MAX_URL && t.length > 200) {
    t = `${t.slice(0, Math.floor(t.length * 0.8))}… (shortened)`;
    url = build(t);
  }
  return url;
}

export function BugReportsTab({ call, reload, isAdmin }: { call: ApiCall; reload: number; isAdmin: boolean }) {
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [reports, setReports] = useState<BugReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [version, setVersion] = useState<ServerVersion | null>(null);

  useEffect(() => {
    if (isAdmin) (call("/api/v1/version") as Promise<ServerVersion>).then(setVersion, () => {});
  }, [call, isAdmin]);

  useEffect(() => {
    let live = true;
    setReports(null);
    (call(`/api/v1/bug-reports?status=${status}`) as Promise<BugReport[]>)
      .then((r) => {
        if (!live) return;
        setReports(r);
        setError(null);
      })
      .catch((err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [call, status, reload, tick]);

  async function update(r: BugReport, what: string, body: Record<string, unknown>) {
    setBusy(`${r.id}:${what}`);
    setRowError(null);
    try {
      await call(`/api/v1/bug-reports/${r.id}`, { method: "PATCH", body: JSON.stringify(body) });
    } catch (err) {
      setRowError({ id: r.id, msg: errText(err) });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  }

  async function remove(r: BugReport) {
    setBusy(`${r.id}:delete`);
    setRowError(null);
    try {
      await call(`/api/v1/bug-reports/${r.id}`, { method: "DELETE" });
      setConfirmDelete(null);
    } catch (err) {
      setRowError({ id: r.id, msg: errText(err) });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  }

  function sendToGitHub(r: BugReport) {
    window.open(issueUrl(r.text, forwardable(isDebug(r.debug) ? r.debug : undefined, version)), "_blank", "noopener");
    void update(r, "github", { sent_to_github: true });
  }

  return (
    <section className="settings-section">
      <div className="settings-tabs sub" role="tablist" aria-label="Bug report status">
        {(["open", "closed"] as const).map((id) => (
          <button key={id} role="tab" aria-selected={status === id} className={status === id ? "on" : undefined}
            onClick={() => setStatus(id)}>{id === "open" ? "Open" : "Closed"}</button>
        ))}
      </div>
      <p className="muted small">
        {status === "open"
          ? "Bug reports from people on this server (Settings, About, Report a Bug), seen by moderators and "
            + "administrators. If it's a problem with OpenVoxa itself rather than this server's setup, an "
            + "administrator can use Send to GitHub: it opens a prefilled issue in their browser to check and "
            + "submit with their GitHub account, leaving out who reported it and this server's address."
          : "Reports an administrator closed. The newest 200; delete them when you no longer need them."}
      </p>
      {error && <p className="error" role="alert">Couldn't load bug reports: {error}</p>}
      {!error && !reports && <p className="muted">Loading…</p>}
      {reports && reports.length === 0 && <p className="muted small">None.</p>}
      {reports && reports.length > 0 && (
        <ul className="device-list">
          {reports.map((r) => {
            const debug = isDebug(r.debug) ? r.debug : undefined;
            return (
              <li key={r.id} className="member">
                <div className="report-head small">
                  <strong>{r.reporter}</strong>
                  <span className="muted"> · {when(r.created_at)}{r.closed_at ? ` · closed ${when(r.closed_at)}` : ""}</span>
                  {r.sent_to_github_at && (
                    <span className="tag small" title={`Sent ${when(r.sent_to_github_at)}`}>Sent to GitHub</span>
                  )}
                </div>
                <blockquote className="quoted small">{r.gone
                  ? <em className="muted">(deleted with the reporter's account)</em>
                  : r.text}</blockquote>
                {debug && (
                  <details className="small">
                    <summary className="muted">Debug info</summary>
                    <pre className="debug-preview">{debugText(debug)}</pre>
                  </details>
                )}
                <div className="row-actions">
                  <button className="secondary" disabled={busy !== null || r.gone || !isAdmin}
                    onClick={() => sendToGitHub(r)}
                    title={!isAdmin ? "Only administrators send bug reports to GitHub."
                      : r.gone ? "The report's text was deleted with the account." : undefined}>
                    Send to GitHub
                  </button>
                  <span className="spacer" />
                  {r.status === "open" ? (
                    <button className="secondary" disabled={busy !== null}
                      onClick={() => void update(r, "close", { status: "closed" })}>
                      {busy === `${r.id}:close` ? "…" : "Close"}
                    </button>
                  ) : (
                    <button className="secondary" disabled={busy !== null}
                      onClick={() => void update(r, "open", { status: "open" })}>
                      {busy === `${r.id}:open` ? "…" : "Reopen"}
                    </button>
                  )}
                  <button className="danger" disabled={busy !== null}
                    onClick={() => setConfirmDelete(confirmDelete === r.id ? null : r.id)}
                    aria-expanded={confirmDelete === r.id}>
                    {confirmDelete === r.id ? "Keep" : "Delete"}
                  </button>
                </div>
                {confirmDelete === r.id && (
                  <div className="member-groups">
                    <p className="small">Delete this bug report from <strong>{r.reporter}</strong>? This can't be undone.</p>
                    <div className="row-actions">
                      <button className="danger" disabled={busy !== null} onClick={() => void remove(r)}>
                        {busy === `${r.id}:delete` ? "Deleting…" : "Delete report"}
                      </button>
                      <button className="secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </div>
                  </div>
                )}
                {rowError?.id === r.id && <p className="error small" role="alert">{rowError.msg}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
