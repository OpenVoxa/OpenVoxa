// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { call, type Session } from "./api";
import { loadSession, saveSession } from "./session";
import { Login } from "./Login";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);

  function update(s: Session | null) {
    saveSession(s);
    setSession(s);
  }

  async function logout() {
    // Clear locally even if the server call fails: a dead token is harmless.
    try {
      await call("/api/v1/auth/logout", { method: "POST", token: session?.token });
    } catch {
      /* ignore */
    }
    update(null);
  }

  if (!session) return <Login onSession={update} />;

  // Placeholder home until the recovery key (parts 2-4) and the text UI (M2).
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>OpenVoxa</h1>
        <p>Logged in as <strong>{session.username}</strong></p>
        <p className="muted">Groups: {session.groups.map((g) => g.name).join(", ") || "none"}</p>
        <p className="muted">The new client is under construction. Chat still lives in the debug page.</p>
        <a href="/debug/chat.html">Open the debug page</a>
        <button className="primary" onClick={logout}>Log out</button>
      </div>
    </div>
  );
}
