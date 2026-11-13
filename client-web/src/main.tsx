// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyAppearance } from "./appearance";
import { startTrafficMeter } from "./AboutSettings";
import { refreshServerInfo } from "./serverInfo";
import { startInstallSupport } from "./install";
import "./styles.css";

// Before the first paint, so saved colours never flash the defaults.
applyAppearance();
// Before anything is fetched, so the About tab's bandwidth counts it all.
startTrafficMeter();
// The tab title and icon, and the name on the sign-in page.
void refreshServerInfo();
// The installable web app: the service worker and the install prompt,
// which the browser may announce before anything is drawn.
startInstallSupport();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
