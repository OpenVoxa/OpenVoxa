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
let updating = false; // the Update Ready card is open
let update = null; // { current, ready }
let picking = false;
const errors = new Map(); // origin -> message, for servers that failed to load

function host(origin) {
  return new URL(origin).host;
}

// A server without an icon shows the first letter of its name, or of its
// address (skipping a leading "openvoxa.") when it has no name either.
function letter(s) {
  const src = s.name || new URL(s.origin).hostname.replace(/^openvoxa\./i, "");
  return (Array.from(src)[0] || "?").toUpperCase();
}

// The hover text: the name and the address, or just the address.
function label(s) {
  return s.name ? `${s.name} (${host(s.origin)})` : host(s.origin);
}

function render() {
  list.replaceChildren(
    ...servers.map((s) => {
      const li = document.createElement("li");
      if (s.origin === selected) li.className = "active";
      const b = document.createElement("button");
      b.className = "server-icon";
      // s.icon is a data: URL of a PNG or WebP that the main process
      // fetched and checked itself (fetchServerInfo).
      if (s.icon && /^data:image\/(png|webp);base64,/.test(s.icon)) {
        const img = document.createElement("img");
        img.src = s.icon;
        img.alt = "";
        b.classList.add("has-icon");
        b.append(img);
      } else {
        b.textContent = letter(s);
      }
      b.title = label(s);
      b.setAttribute("aria-label", label(s));
      b.addEventListener("click", () => {
        cancelPick();
        if (adding) closeForm();
        if (updating) closeUpdate();
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
  // The screen share picker, while open, is the only thing shown.
  const failed = selected !== null && errors.has(selected);
  const showUpdate = !picking && updating && !!update?.ready;
  const showForm = !picking && !showUpdate && (adding || servers.length === 0);
  form.hidden = !showForm;
  addCancel.hidden = servers.length === 0;
  updateCard.hidden = !showUpdate;
  updateButton.hidden = !update?.ready;
  if (update?.ready) updateText.textContent = `OpenVoxa ${update.ready} is ready to install. You have ${update.current}.`;
  loadError.hidden = picking || showForm || showUpdate || !failed;
  if (failed) loadErrorText.textContent = `${host(selected)}: ${errors.get(selected)}`;
  shareCard.hidden = !picking;
  content.hidden = !(picking || showForm || showUpdate || failed);
  // The main process owns the overlay while the picker is open.
  if (!picking) window.shell.setOverlay(showForm || showUpdate || failed);
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

document.getElementById("add").addEventListener("click", () => {
  cancelPick();
  updating = false;
  openForm();
});
addCancel.addEventListener("click", closeForm);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (picking) cancelPick();
  else if (updating) closeUpdate();
  else if (adding && servers.length > 0) closeForm();
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

// ---- Update ready (sent by the main process, src/updater.ts) ----

const updateButton = document.getElementById("update");
const updateCard = document.getElementById("update-card");
const updateText = document.getElementById("update-text");
const updateGo = document.getElementById("update-go");

function closeUpdate() {
  updating = false;
  render();
}

updateButton.addEventListener("click", () => {
  cancelPick();
  adding = false;
  updating = !updating;
  render();
});
document.getElementById("update-later").addEventListener("click", closeUpdate);
updateGo.addEventListener("click", () => {
  updateGo.disabled = true;
  updateGo.textContent = "Restarting...";
  window.shell.installUpdate();
});

window.shell.onUpdate((s) => {
  update = s;
  if (!s.ready) updating = false;
  render();
});

window.shell.onServerError(({ origin, message }) => {
  if (message) errors.set(origin, message);
  else errors.delete(origin);
  render();
});

// ---- Screen share picker (opened by the main process) ----

const shareCard = document.getElementById("share");
const shareHost = document.getElementById("share-host");
const tabScreens = document.getElementById("tab-screens");
const tabWindows = document.getElementById("tab-windows");
const sourceList = document.getElementById("sources");
const sourcesEmpty = document.getElementById("sources-empty");
const soundLabel = document.getElementById("sound-label");
const sound = document.getElementById("sound");
const soundNote = document.getElementById("sound-note");
const smartLabel = document.getElementById("smart-label");
const smart = document.getElementById("smart");
const shareGo = document.getElementById("share-go");

let shareReq = null; // { host, audio, screenSound, windowSound }
let sources = [];
let tab = "screens";
let chosen = null; // source id
let listError = null;
let listed = false; // the first list has arrived
let soundWanted = true; // the tickbox as the user left it
let smartWanted = true; // Smart Switch, likewise

function renderShare() {
  tabScreens.classList.toggle("on", tab === "screens");
  tabWindows.classList.toggle("on", tab === "windows");
  tabScreens.setAttribute("aria-selected", String(tab === "screens"));
  tabWindows.setAttribute("aria-selected", String(tab === "windows"));
  const shown = sources.filter((s) => s.screen === (tab === "screens"));
  // The choice is always one you can see: dropped when its window closes
  // or the tab changes; a lone screen is chosen for you.
  if (chosen && !shown.some((s) => s.id === chosen)) chosen = null;
  if (!chosen && tab === "screens" && shown.length === 1) chosen = shown[0].id;

  sourceList.replaceChildren(
    ...shown.map((s) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "source" + (s.id === chosen ? " on" : "");
      b.title = s.name;
      b.setAttribute("aria-pressed", String(s.id === chosen));
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (s.thumbnail) {
        const img = document.createElement("img");
        img.src = s.thumbnail;
        img.alt = "";
        thumb.append(img);
      }
      const name = document.createElement("div");
      name.className = "source-name";
      if (s.icon) {
        const icon = document.createElement("img");
        icon.src = s.icon;
        icon.alt = "";
        icon.className = "app-icon";
        name.append(icon);
      }
      const text = document.createElement("span");
      text.textContent = s.name;
      name.append(text);
      b.append(thumb, name);
      b.addEventListener("click", () => {
        chosen = s.id;
        renderShare();
      });
      b.addEventListener("dblclick", () => window.shell.share(s.id, sound.checked, !!s.smart && smartWanted));
      li.append(b);
      return li;
    }),
  );
  sourcesEmpty.hidden = shown.length > 0;
  sourcesEmpty.textContent = listError ?? (listed ? `No ${tab} to share.` : "Looking for screens and windows...");

  // Sound: only asked for if the page wants it, and only on Windows: a
  // whole screen shares everything but OpenVoxa, a window only its own
  // program (Windows 10 2004 or later).
  soundLabel.hidden = !shareReq?.audio;
  const soundOk = tab === "screens" ? !!shareReq?.screenSound : !!shareReq?.windowSound;
  let why = null;
  if (shareReq?.audio) {
    if (!shareReq.screenSound) why = "Sound can only be shared from Windows in the desktop app.";
    else if (!soundOk) why = "Sound from a single window needs Windows 10 version 2004 or later.";
    else if (tab === "windows") why = "Shares only this window's app sound.";
    else why = "Shares everything your computer plays, except OpenVoxa.";
  }
  sound.disabled = !soundOk;
  sound.checked = soundOk && soundWanted; // greyed out = not shared, so not ticked
  soundLabel.classList.toggle("locked", !soundOk);

  // Smart Switch: only for a window of a game the app knows (main.ts,
  // PAIRS), where the share then follows the game between its client and
  // the game window.
  const game = sources.find((s) => s.id === chosen)?.smart ?? null;
  smartLabel.hidden = !game;
  smart.checked = smartWanted;
  if (game && smartWanted) why = `${why ? why + " " : ""}Smart Switch follows ${game} between its client and the game.`;

  soundNote.hidden = !why;
  soundNote.textContent = why ?? "";
  shareGo.disabled = !chosen;
}

tabScreens.addEventListener("click", () => {
  tab = "screens";
  renderShare();
});
tabWindows.addEventListener("click", () => {
  tab = "windows";
  renderShare();
});
sound.addEventListener("change", () => {
  soundWanted = sound.checked;
});
smart.addEventListener("change", () => {
  smartWanted = smart.checked;
  renderShare();
});
// Like the web client's dialogs: Cancel, Escape, a click outside the
// picker, or any pane button closes it without sharing.
function cancelPick() {
  if (picking) window.shell.share(null, false, false);
}
document.getElementById("share-cancel").addEventListener("click", cancelPick);
content.addEventListener("mousedown", (e) => {
  if (picking && e.target === content) cancelPick();
});
shareGo.addEventListener("click", () => {
  if (chosen) window.shell.share(chosen, sound.checked, !!sources.find((s) => s.id === chosen)?.smart && smartWanted);
});

window.shell.onShareOpen((req) => {
  shareReq = req;
  sources = [];
  tab = "screens";
  chosen = null;
  listError = null;
  listed = false;
  soundWanted = true;
  smartWanted = true;
  // gone: the window being shared closed; the share waits for a new pick.
  shareHost.textContent = req.gone
    ? "The window you were sharing closed. Pick another to keep sharing, or Cancel to stop."
    : `${req.host} wants to see a screen or window.`;
  if (req.gone) tab = "windows";
  picking = true;
  render();
  renderShare();
});
window.shell.onShareSources((list) => {
  sources = list;
  listed = true;
  listError = null;
  renderShare();
});
window.shell.onShareError((message) => {
  listError = message;
  renderShare();
});
window.shell.onShareClose(() => {
  picking = false;
  shareReq = null;
  sources = [];
  sourceList.replaceChildren();
  render();
});

window.shell.ready();
