// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// The server pane. window.shell comes from src/panePreload.ts.
"use strict";

const list = document.getElementById("servers");
const content = document.getElementById("content");
const form = document.getElementById("add-form");
const address = document.getElementById("address");
const addError = document.getElementById("add-error");
const addSubmit = document.getElementById("add-submit");
const addCancel = document.getElementById("add-cancel");
const loadError = document.getElementById("load-error");
const loadErrorText = document.getElementById("load-error-text");

let servers = [];
let selected = null;
let adding = false;
const errors = new Map(); // origin -> message, for servers that failed to load

function host(origin) {
  return new URL(origin).host;
}

// Until administrators can set a name and icon (a later step), a server
// shows the first letter of its address, skipping a leading "openvoxa.".
function letter(origin) {
  const h = new URL(origin).hostname.replace(/^openvoxa\./i, "");
  return (h[0] || "?").toUpperCase();
}

function render() {
  list.replaceChildren(
    ...servers.map((s) => {
      const li = document.createElement("li");
      if (s.origin === selected) li.className = "active";
      const b = document.createElement("button");
      b.className = "server-icon";
      b.textContent = letter(s.origin);
      b.title = host(s.origin);
      b.setAttribute("aria-label", host(s.origin));
      b.addEventListener("click", () => {
        if (adding) closeForm();
        window.shell.select(s.origin);
      });
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        window.shell.menu(s.origin);
      });
      li.append(b);
      return li;
    }),
  );

  // The pane covers the window (and the server view is hidden) while the
  // form is open, when there are no servers yet, or when the selected
  // server failed to load.
  const failed = selected !== null && errors.has(selected);
  const showForm = adding || servers.length === 0;
  form.hidden = !showForm;
  addCancel.hidden = servers.length === 0;
  loadError.hidden = showForm || !failed;
  if (failed) loadErrorText.textContent = `${host(selected)}: ${errors.get(selected)}`;
  content.hidden = !(showForm || failed);
  window.shell.setOverlay(showForm || failed);
}

function openForm() {
  adding = true;
  addError.hidden = true;
  address.value = "";
  render();
  address.focus();
}

function closeForm() {
  adding = false;
  render();
}

document.getElementById("add").addEventListener("click", openForm);
addCancel.addEventListener("click", closeForm);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && adding && servers.length > 0) closeForm();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  addSubmit.disabled = true;
  addSubmit.textContent = "Checking...";
  addError.hidden = true;
  try {
    const { error } = await window.shell.add(address.value);
    if (error) {
      addError.textContent = error;
      addError.hidden = false;
      address.focus();
    } else {
      adding = false;
    }
  } finally {
    addSubmit.disabled = false;
    addSubmit.textContent = "Add Server";
  }
  render();
});

document.getElementById("retry").addEventListener("click", () => {
  if (!selected) return;
  errors.delete(selected);
  window.shell.reload(selected);
  render();
});

window.shell.onServers((s) => {
  servers = s.servers;
  selected = s.selected;
  for (const origin of errors.keys()) {
    if (!servers.some((x) => x.origin === origin)) errors.delete(origin);
  }
  render();
  if (servers.length === 0) address.focus();
});

window.shell.onServerError(({ origin, message }) => {
  if (message) errors.set(origin, message);
  else errors.delete(origin);
  render();
});

window.shell.ready();
