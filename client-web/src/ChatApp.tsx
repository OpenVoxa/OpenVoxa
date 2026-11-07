// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed-in client: channel sidebar, message pane, composer (build
 * order 13, M2/M3). Discord-like layout, one server per instance, so no
 * server rail. Clicking a voice channel joins its call; the people in
 * each call are listed under it, and screen shares open in the stage.
 *
 * All chat logic lives in client-core's Chat / ChannelView; this file
 * only draws their snapshots and forwards what the user does.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Chat, type ChannelView, type ChannelInfo, type VoicePresence } from "@core/chat";
import type { VoiceClient, VoiceParticipant } from "@core/voice";
import type { BackupStatus } from "@core/recovery";
import type { Session } from "./api";
import type { BackupManager } from "./backup";
import { apiCall, cryptoSession, localStore, wsUrl } from "./core";
import { BellIcon, ChannelPane } from "./ChannelPane";
import { ChannelSettingsDialog, CreateChannelDialog } from "./ChannelDialogs";
import { ChannelMenu, useMenuTrigger, type MenuItem } from "./ChannelMenu";
import {
  CallView, PersonMenu, ShareDialog, Stage, VoiceBar, VoiceRoster,
  usePushToTalk, useVoiceSnapshot,
} from "./VoiceUI";
import { messageCooldown, mutedChannels, playSound, setChannelMuted, useMutedChannels, useVoiceSounds } from "./sounds";
import { getToggle, MENTION_NOTIFY } from "./settings";
import { SettingsDialog, type AccountActions, type SettingsTab } from "./SettingsDialog";
import { ServerSettingsDialog } from "./ServerSettings";
import { configureStickers, refreshStickers } from "./stickers";
import { configureNames, refreshNames } from "./names";
import { channelLink, LinksContext, onAddressTarget, takePendingTarget, type LinkTarget, type Links } from "./links";
import { serverInfoChanged, useServerInfo } from "./serverInfo";
import { configureHome, HomeIcon, HomePane, markHomeSeen, refreshHome, useHome } from "./home";
import type { ServerTab } from "./ServerSettings";

const LAST_CHANNEL = (userId: string) => `lastChannel.${userId}`;
/** "1" when Home was the last thing open: you come back to it. */
const LAST_HOME = (userId: string) => `lastHome.${userId}`;

export function ChatApp({ session, manager, backup, notice, busy, onLogout, onBackUpNow, onSetUpKey, onEnterKey, onNewKey, onDeleteAccount, onEraseAndLogout, onExpired }: {
  session: Session;
  manager: BackupManager;
  backup: BackupStatus | null;
  notice: string | null;
  busy: string | null;
  onLogout: (chat: Chat | null) => void;
  onBackUpNow: () => void;
  onSetUpKey: () => void;
  onEnterKey: () => void;
  onNewKey: () => void;
  onDeleteAccount: (chat: Chat, password: string) => Promise<void>;
  onEraseAndLogout: (chat: Chat, deviceId: string) => void;
  onExpired: () => void;
}) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [channels, setChannels] = useState<readonly ChannelInfo[]>([]);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const [mentions, setMentions] = useState<ReadonlySet<string>>(new Set());
  // The chat listener is set up once; it reads the channel names from here.
  const channelsRef = useRef<readonly ChannelInfo[]>([]);
  channelsRef.current = channels;
  const [openId, setOpenId] = useState<string | null>(null);
  // Home in the main pane instead of the open channel. null: not decided
  // yet (waits for the first /home answer, to know whether it changed).
  const [homeOpen, setHomeOpenState] = useState<boolean | null>(null);
  const setHomeOpen = (on: boolean) => {
    setHomeOpenState(on);
    localStore.set(LAST_HOME(session.user_id), on ? "1" : "0");
  };
  const home = useHome();
  const serverInfo = useServerInfo();
  // Message sound cooldown (sounds.ts, MESSAGE_COOLDOWNS): when each
  // channel last played the message or mention sound. Looking at a
  // channel clears its entry, so its next message plays again.
  const soundAt = useRef(new Map<string, number>());
  const openRef = useRef<string | null>(null);
  openRef.current = openId;
  useEffect(() => {
    if (openId) soundAt.current.delete(openId);
    const back = () => {
      if (openRef.current && document.visibilityState === "visible" && document.hasFocus()) {
        soundAt.current.delete(openRef.current);
      }
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [openId]);
  const [view, setView] = useState<ChannelView | null>(null);
  // Permissions and rank move while signed in (perms_changed); start
  // from login's. permsTick counts the changes, so Server settings can
  // reload its lists.
  const [perms, setPerms] = useState<readonly string[]>(session.permissions);
  const [rank, setRank] = useState(session.rank);
  const [permsTick, setPermsTick] = useState(0);
  // Open reports, for the dot on the Server settings gear. Only fetched by
  // people who can read reports; reports_changed (sent only to them) and
  // reportsTick trigger a refetch.
  const [openReports, setOpenReports] = useState(0);
  const [reportsTick, setReportsTick] = useState(0);
  // Open bug reports, the same way and for the same people
  // (bug_reports_changed is sent only to them).
  const [openBugs, setOpenBugs] = useState(0);
  const [bugsTick, setBugsTick] = useState(0);
  const [dialog, setDialog] = useState<
    | { k: "create"; kind: "text" | "voice" }
    | { k: "settings"; id: string; focus?: "name" | "delete" }
    | { k: "share" }
    | { k: "prefs"; tab: SettingsTab }
    | { k: "server"; tab?: ServerTab }
    | null
  >(null);
  // The right-click (or long-press) menu on a channel in the sidebar.
  const [chanMenu, setChanMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  const menuTrigger = useMenuTrigger((id, at) => setChanMenu({ id, at }));
  const [presence, setPresence] = useState<VoicePresence>({});
  // Created on first join: loading it pulls in LiveKit, which text-only
  // use never needs.
  const [voiceClient, setVoiceClient] = useState<VoiceClient | null>(null);
  const vsnap = useVoiceSnapshot(voiceClient);
  const muted = useMutedChannels();
  usePushToTalk(voiceClient, vsnap);
  useVoiceSounds(vsnap);
  const [stage, setStage] = useState<{ focus: string | null } | null>(null);
  // The main area shows the call (tiles) rather than chat: on joining, or
  // on clicking the voice channel you're in; a text channel turns it off.
  const [callView, setCallView] = useState(false);
  const [person, setPerson] = useState<{ p: VoiceParticipant; at: { x: number; y: number } } | null>(null);
  const call = useMemo(() => apiCall(session.token, onExpired),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.token]);

  // Sticker images need the token (stickers.tsx).
  useEffect(() => configureStickers(call, session.token), [call, session.token]);
  // Username colours by group (names.tsx).
  useEffect(() => configureNames(call), [call]);
  // The Home page (home.tsx).
  useEffect(() => configureHome(call), [call]);

  // Start the crypto session (this tab takes over the account's device)
  // and the chat on top of it.
  useEffect(() => {
    let live = true;
    let started: Chat | null = null;
    const refreshMe = () => {
      (call("/api/v1/me") as Promise<{ permissions: string[]; rank: number }>)
        .then((me) => {
          if (!live) return;
          setPerms(me.permissions ?? []);
          setRank(me.rank ?? 0);
          setPermsTick((t) => t + 1);
        })
        .catch(() => {});
    };
    cryptoSession(session.user_id, call)
      .then(async (crypto) => {
        if (!live) return;
        const c = new Chat(crypto, {
          call,
          wsUrl,
          userId: session.user_id,
          username: session.username,
          store: localStore,
          onArchived: () => manager.scheduleUpload(),
        });
        started = c;
        // Messages that mentioned you, so their message sound is skipped:
        // the mention sound covers them. The mention usually arrives
        // first (the server sends channel_activity from a goroutine);
        // the message sound waits a moment in case it doesn't.
        const mentionedIds = new Set<string>();
        const looking = () => document.visibilityState === "visible" && document.hasFocus();
        c.on((e) => {
          if (e.type === "channels") setChannels(e.channels);
          else if (e.type === "unread") setUnread(e.unread);
          else if (e.type === "mentions") setMentions(e.mentions);
          else if (e.type === "message") {
            // A background tab or an unfocused window isn't looking.
            if (e.open && looking()) return;
            if (mutedChannels().has(e.channelId)) return;
            setTimeout(() => {
              if (!live || mentionedIds.has(e.messageId)) return;
              const last = soundAt.current.get(e.channelId);
              const wait = messageCooldown();
              if (last !== undefined && (wait < 0 || Date.now() - last < wait * 1000)) return;
              soundAt.current.set(e.channelId, Date.now());
              void playSound("message");
            }, 400);
          }
          else if (e.type === "mentioned") {
            mentionedIds.add(e.messageId);
            setTimeout(() => mentionedIds.delete(e.messageId), 10_000);
            // Quiet only when you're already looking at that channel.
            if (e.open && looking()) return;
            // The mention sound counts towards the channel's cooldown.
            soundAt.current.set(e.channelId, Date.now());
            void playSound("mention");
            if (getToggle(MENTION_NOTIFY) && typeof Notification !== "undefined"
              && Notification.permission === "granted") {
              const name = channelsRef.current.find((ch) => ch.id === e.channelId)?.name;
              // Who and where only: in an encrypted channel the text isn't
              // decrypted until the channel is open, and a notification
              // can be seen by anyone near the screen.
              const n = new Notification(`${e.username || "Someone"} mentioned you`, {
                body: name ? `in #${name}` : undefined,
                tag: `mention:${e.messageId}`,
                // Our own mention tone already played; without this the
                // OS adds its notification sound on top.
                silent: true,
              });
              n.onclick = () => {
                window.focus();
                setOpenId(e.channelId);
                setHomeOpen(false);
                setStage(null);
                setCallView(false);
                n.close();
              };
            }
          }
          else if (e.type === "voice") setPresence(e.presence);
          else if (e.type === "reports_changed") setReportsTick((t) => t + 1);
          else if (e.type === "bug_reports_changed") setBugsTick((t) => t + 1);
          else if (e.type === "stickers_changed") void refreshStickers();
          else if (e.type === "names_changed") refreshNames();
          else if (e.type === "server_info_changed") serverInfoChanged();
          else if (e.type === "home_changed") void refreshHome();
          else if (e.type === "events_reconnected") {
            // Server-wide events sent while the socket was down are lost.
            serverInfoChanged();
            void refreshHome();
            void refreshStickers();
            refreshNames();
            refreshMe();
          }
          else if (e.type === "me_changed") refreshMe();
        });
        // The sign-in's list may be stale: a server update can add a
        // switch (an administrator holds every one), or groups may have
        // changed while this tab was closed.
        refreshMe();
        await c.start();
        if (!live) {
          c.close();
          return;
        }
        setChannels(c.channels);
        setUnread(c.unread);
        setMentions(c.mentions);
        setPresence(c.voicePresence);
        setChat(c);
      })
      .catch((err) => live && setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
      started?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user_id, session.token]);

  // The open channel only counts as read while you can see it: a
  // background tab or another window in front leaves it unread.
  useEffect(() => {
    if (!chat) return;
    const update = () => chat.setLooking(document.visibilityState === "visible" && document.hasFocus());
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [chat]);

  const readsReports = perms.includes("view_reports") || perms.includes("administrator");
  useEffect(() => {
    if (!readsReports) {
      setOpenReports(0);
      return;
    }
    let live = true;
    const load = () => {
      (call("/api/v1/reports?status=open") as Promise<unknown[]>)
        .then((r) => live && setOpenReports(r.length))
        .catch(() => {});
    };
    load();
    // Fallbacks for an event missed while the event socket reconnected.
    const timer = setInterval(load, 120_000);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [call, readsReports, reportsTick, permsTick]);

  const readsBugs = readsReports;
  useEffect(() => {
    if (!readsBugs) {
      setOpenBugs(0);
      return;
    }
    let live = true;
    const load = () => {
      (call("/api/v1/bug-reports?status=open") as Promise<unknown[]>)
        .then((r) => live && setOpenBugs(r.length))
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 120_000);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [call, readsBugs, bugsTick, permsTick]);

  // The gear's tooltip and dot: open message reports and bug reports.
  const waiting = [
    openReports ? `${openReports}${openReports >= 100 ? "+" : ""} open report${openReports === 1 ? "" : "s"}` : "",
    openBugs ? `${openBugs} open bug report${openBugs === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(", ");

  const text = useMemo(() => channels.filter((c) => c.kind === "text"), [channels]);
  const voiceChannels = useMemo(() => channels.filter((c) => c.kind === "voice"), [channels]);

  // Leave the call when the client goes away (sign-out, session end).
  useEffect(() => () => void voiceClient?.leave(), [voiceClient]);

  // Keep the call in step with its channel: forced push-to-talk follows
  // the setting, and a deleted or lost channel ends the call.
  useEffect(() => {
    if (!voiceClient || !vsnap || vsnap.state === "idle" || !chat) return;
    const c = voiceChannels.find((v) => v.id === vsnap.channelId);
    if (!c) void voiceClient.leave();
    else voiceClient.setForcePTT(c.force_ptt);
  }, [voiceClient, vsnap, voiceChannels, chat]);

  // The stage closes itself when the last share ends.
  const screens = vsnap?.screens ?? [];
  const showCall = callView && !!vsnap && vsnap.state !== "idle";
  useEffect(() => {
    if (stage && !screens.length) setStage(null);
    else if (stage?.focus && !screens.some((s) => s.id === stage.focus)) setStage({ focus: null });
  }, [stage, screens]);

  // Following a channel or message link (links.ts): the message to
  // scroll to once its channel is open, and a "can't go there" note for
  // a view that isn't open yet (a link the page was opened with).
  const [jump, setJump] = useState<{ channelId: string; messageId: string } | null>(null);
  const noteLater = useRef<string | null>(null);
  /** Go to a link's channel (and message); false if you can't see it. */
  const go = (t: LinkTarget): boolean => {
    const c = channelsRef.current.find((x) => x.id === t.channelId && x.kind === "text");
    if (!c) {
      const note = "That link goes to a channel you can't see, or one that was deleted.";
      if (chat?.view) chat.view.notice(note);
      else noteLater.current = note;
      return false;
    }
    setOpenId(c.id);
    setHomeOpen(false);
    setStage(null);
    setCallView(false);
    setJump(t.messageId ? { channelId: c.id, messageId: t.messageId } : null);
    return true;
  };
  const goRef = useRef(go);
  goRef.current = go;
  // A link pasted into this tab's address bar.
  useEffect(() => onAddressTarget((t) => void goRef.current(t)), []);
  const links = useMemo<Links>(() => ({ channels, go: (t) => void goRef.current(t) }), [channels]);

  // Pick a channel: the one a link the page was opened with goes to, the
  // open one if it still exists, else the last one used, else the first.
  // Land on Home or not, once: Home if an administrator changed it since
  // you last saw it, or if it was the last thing open; else the channel
  // below. A link the page was opened with leaves Home (go). If /home
  // doesn't answer in a few seconds, the channel.
  useEffect(() => {
    if (!chat || homeOpen !== null) return;
    if (home) {
      setHomeOpenState(home.version > home.seen_version || localStore.get(LAST_HOME(session.user_id)) === "1");
      return;
    }
    const t = setTimeout(() => setHomeOpenState((v) => v ?? false), 4000);
    return () => clearTimeout(t);
  }, [chat, home, homeOpen, session.user_id]);

  useEffect(() => {
    if (!chat || !text.length) return;
    const opened = takePendingTarget();
    if (opened && goRef.current(opened)) return;
    if (openId && text.some((c) => c.id === openId)) return;
    const last = localStore.get(LAST_CHANNEL(session.user_id));
    setOpenId(text.find((c) => c.id === last)?.id ?? text[0].id);
  }, [chat, text, openId, session.user_id]);

  useEffect(() => {
    if (!chat || !openId) return;
    if (chat.view?.channel.id === openId) return;
    try {
      const v = chat.open(openId);
      setView(v);
      localStore.set(LAST_CHANNEL(session.user_id), openId);
      if (noteLater.current) {
        v.notice(noteLater.current);
        noteLater.current = null;
      }
    } catch {
      /* gone from the list meanwhile; the effect above picks another */
    }
  }, [chat, openId, session.user_id]);

  // Home open and in view counts as seen (the dot goes).
  const homeShown = homeOpen === true && !stage && !(callView && !!vsnap && vsnap.state !== "idle");
  useEffect(() => {
    if (!homeShown || !home || home.seen_version >= home.version) return;
    const mark = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) markHomeSeen();
    };
    mark();
    window.addEventListener("focus", mark);
    document.addEventListener("visibilitychange", mark);
    return () => {
      window.removeEventListener("focus", mark);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [homeShown, home]);

  if (failed) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Couldn't start</h1>
          <p className="error">{failed}</p>
          <button className="primary" onClick={() => location.reload()}>Try again</button>
          <button className="link" onClick={() => onLogout(null)} disabled={!!busy}>Log out</button>
        </div>
      </div>
    );
  }
  if (!chat) {
    return <div className="auth-page"><p className="muted">Setting up encryption…</p></div>;
  }

  async function ensureVoice(): Promise<VoiceClient | null> {
    if (!chat) return null;
    let v = voiceClient;
    if (!v) {
      const [{ VoiceClient }, { createE2EEWorker }, { desktopShareSound }, { default: micWorkletUrl },
        { default: rnnoiseWorkletUrl }] = await Promise.all([
        import("@core/voice"),
        import("./voiceWorker"),
        import("./desktopShareSound"),
        import("@core/micWorklet.ts?worker&url"),
        // Only the address: the ~1.9 MB file loads when Strong noise suppression is first used.
        import("@core/rnnoiseWorklet.ts?worker&url"),
      ]);
      v = new VoiceClient(chat.session, {
        call, userId: session.user_id, createWorker: createE2EEWorker, store: localStore,
        windowShareSound: desktopShareSound, micWorkletUrl, rnnoiseWorkletUrl,
      });
      setVoiceClient(v);
      // A handle for the browser console, as the debug page has its
      // helpers: openvoxaVoice.audioStats(), openvoxaVoice.snapshot().
      (window as unknown as { openvoxaVoice?: VoiceClient }).openvoxaVoice = v;
    }
    return v;
  }

  async function joinVoice(channelId: string) {
    const v = await ensureVoice();
    if (!v || !chat) return;
    if (vsnap?.channelId === channelId && vsnap.state !== "idle") return;
    await v.join(channelId);
    void chat.refreshVoice();
  }

  const accountActions: AccountActions = {
    onBackUpNow, onSetUpKey, onEnterKey, onNewKey,
    onDeleteAccount: (password) => onDeleteAccount(chat, password),
    onEraseAndLogout: () => onEraseAndLogout(chat, chat.session.status.deviceId),
  };

  const can = (p: string) => perms.includes(p) || perms.includes("administrator");
  const canDeleteAny = can("delete_messages");
  const canManage = can("manage_channels");
  const canForcePTT = can("force_ptt");
  // Staff: anyone holding a switch. They see the member list; changing
  // groups needs manage_groups (checked inside the dialog).
  const isStaff = perms.length > 0;
  const settingsFor = (c: ChannelInfo) => canManage || (c.kind === "voice" && canForcePTT);
  const dialogChannel = dialog?.k === "settings" ? channels.find((c) => c.id === dialog.id) : undefined;

  const gear = (c: ChannelInfo) => settingsFor(c) && (
    <button className="icon gear" onClick={() => setDialog({ k: "settings", id: c.id })}
      title={`${c.name} settings`} aria-label={`${c.name} settings`}>
      <GearIcon />
    </button>
  );
  const NEEDS_MANAGE = "Needs the Manage channels permission";
  const menuItems = (c: ChannelInfo): (MenuItem | "sep")[] => {
    const manage: MenuItem[] = [
      { label: "Rename Channel", onClick: () => setDialog({ k: "settings", id: c.id, focus: "name" }),
        disabled: !canManage, reason: NEEDS_MANAGE },
      { label: "Channel Settings", onClick: () => setDialog({ k: "settings", id: c.id }),
        disabled: !settingsFor(c), reason: NEEDS_MANAGE },
      { label: "Delete Channel", onClick: () => setDialog({ k: "settings", id: c.id, focus: "delete" }),
        disabled: !canManage, reason: NEEDS_MANAGE, danger: true },
    ];
    if (c.kind === "voice") {
      const here = !!vsnap && vsnap.state !== "idle" && vsnap.channelId === c.id;
      return [
        here
          ? { label: "Leave Call", onClick: () => void voiceClient?.leave() }
          : { label: "Join Call", onClick: () => {
              setStage(null);
              setCallView(true);
              void joinVoice(c.id);
            } },
        "sep",
        ...manage,
      ];
    }
    const isMuted = muted.has(c.id);
    return [
      { label: "Mark as Read", onClick: () => chat.markRead(c.id, c.last_message_at ?? undefined),
        disabled: !unread.has(c.id) && !mentions.has(c.id), reason: "Nothing unread" },
      { label: isMuted ? "Unmute Sounds" : "Mute Sounds", onClick: () => setChannelMuted(c.id, !isMuted) },
      { label: "Copy Channel Link", onClick: () => void navigator.clipboard.writeText(channelLink(c.id)).catch(() => {}) },
      "sep",
      ...manage,
    ];
  };
  const menuChannel = chanMenu ? channels.find((c) => c.id === chanMenu.id) : undefined;

  const heading = (label: string, kind: "text" | "voice") => (
    <div className="list-head">
      <h2>{label}</h2>
      {canManage && (
        <button className="icon" onClick={() => setDialog({ k: "create", kind })}
          title={`Create a ${kind} channel`} aria-label={`Create a ${kind} channel`}>+</button>
      )}
    </div>
  );

  return (
    <LinksContext value={links}>
    <div className="app">
      <nav className="sidebar" aria-label="Channels">
        <header className="sidebar-head">
          OpenVoxa
          {isStaff && (
            <button className="icon dot-host" onClick={() => setDialog({ k: "server" })}
              title={waiting ? `Server settings: ${waiting}` : "Server settings"}
              aria-label={waiting ? `Server settings, ${waiting}` : "Server settings"}>
              <GearIcon />
              {waiting && <span className="alert-dot" aria-hidden="true" />}
            </button>
          )}
        </header>
        <div className="channel-list">
          <div className="channel-row home-row">
            <button className={`channel home${homeShown ? " active" : ""}${home && home.version > home.seen_version ? " unread" : ""}`}
              onClick={() => {
                setHomeOpen(true);
                setStage(null);
                setCallView(false);
              }}
              aria-current={homeShown ? "page" : undefined}
              title="Home: welcome and rules">
              <HomeIcon />
              <span className="name">{serverInfo.name || "Home"}</span>
              {home && home.version > home.seen_version && <span className="dot" aria-label="changed since you last looked" />}
            </button>
          </div>
          {heading("Text channels", "text")}
          <ul>
            {text.map((c) => (
              <li key={c.id} className="channel-row">
                <button
                  className={`channel${c.id === openId && !homeOpen ? " active" : ""}${unread.has(c.id) || mentions.has(c.id) ? " unread" : ""}`}
                  {...menuTrigger.handlers(c.id)}
                  onClick={() => {
                    if (menuTrigger.consumeLongPress()) return;
                    setOpenId(c.id);
                    setHomeOpen(false);
                    setStage(null);
                    setCallView(false);
                  }}
                  aria-current={c.id === openId && !homeOpen ? "page" : undefined}
                  title={c.encrypted ? "End-to-end encrypted" : "Not encrypted"}
                >
                  <span className="hash" aria-hidden>#</span>
                  <span className="name">{c.name}</span>
                  {c.encrypted && <LockIcon />}
                  {muted.has(c.id) && <span className="muted-bell" title="Sounds muted"><BellIcon off size={12} /></span>}
                  {mentions.has(c.id)
                    ? <span className="mention-badge" aria-label="you were mentioned" title="You were mentioned">@</span>
                    : unread.has(c.id) && <span className="dot" aria-label="unread" />}
                </button>
                {gear(c)}
              </li>
            ))}
            {!text.length && <li className="muted empty">No channels you can see.</li>}
          </ul>
          {(voiceChannels.length > 0 || canManage) && (
            <>
              {heading("Voice channels", "voice")}
              <ul>
                {voiceChannels.map((c) => {
                  const here = vsnap && vsnap.state !== "idle" && vsnap.channelId === c.id;
                  return (
                    <li key={c.id} className="voice-item">
                      <div className="channel-row">
                        <button className={`channel${here ? " active" : ""}`}
                          {...menuTrigger.handlers(c.id)}
                          onClick={() => {
                            if (menuTrigger.consumeLongPress()) return;
                            setStage(null);
                            setCallView(true);
                            void joinVoice(c.id);
                          }}
                          title={here ? "Show the call" : "Join the call"}>
                          <SpeakerIcon />
                          <span className="name">{c.name}</span>
                          {c.force_ptt && <span className="tag small" title="Push-to-talk required">PTT</span>}
                        </button>
                        {gear(c)}
                      </div>
                      <VoiceRoster
                        live={here ? vsnap.participants : null}
                        others={presence[c.id] ?? []}
                        onWatch={(pid) => {
                          const s = screens.find((x) => x.participantId === pid);
                          setStage({ focus: s?.id ?? null });
                        }}
                        onPerson={(p, at) => setPerson({ p, at })}
                      />
                    </li>
                  );
                })}
                {!voiceChannels.length && <li className="muted empty">No voice channels yet.</li>}
              </ul>
            </>
          )}
        </div>
        {voiceClient && vsnap && (
          <VoiceBar voice={voiceClient} snap={vsnap}
            channelName={voiceChannels.find((c) => c.id === vsnap.channelId)?.name ?? ""}
            onShare={() => setDialog({ k: "share" })}
            onSettings={() => setDialog({ k: "prefs", tab: "voice" })} />
        )}
        {screens.length > 0 && !stage && !showCall && (
          <button className="watch-banner" onClick={() => setStage({ focus: null })}>
            <span className="live">LIVE</span> {screens.length === 1 ? `${screens[0].name} is sharing` : `${screens.length} screens shared`} · Watch
          </button>
        )}
        <UserPanel session={session} backup={backup} notice={notice} busy={busy}
          onLogout={() => onLogout(chat)} onBackUpNow={onBackUpNow}
          onSettings={() => setDialog({ k: "prefs", tab: "account" })}
          onSetUpKey={onSetUpKey} onEnterKey={onEnterKey} />
      </nav>
      <main className="pane">
        {stage && voiceClient ? (
          <Stage voice={voiceClient} screens={screens} focus={stage.focus}
            setFocus={(focus) => setStage({ focus })} onBack={() => setStage(null)}
            backLabel={showCall ? "Back to Call" : "Back to Chat"} />
        ) : showCall && voiceClient && vsnap ? (
          <CallView voice={voiceClient} snap={vsnap}
            channelName={voiceChannels.find((c) => c.id === vsnap.channelId)?.name ?? ""}
            onWatch={(id) => setStage({ focus: id })} />
        ) : homeOpen ? (
          <HomePane isAdmin={can("administrator")} onEdit={() => setDialog({ k: "server", tab: "general" })} />
        ) : homeOpen === null ? (
          <div className="pane-empty muted">Opening…</div>
        ) : view ? (
          <ChannelPane key={view.channel.id} view={view} call={call} userId={session.user_id} username={session.username} canDeleteAny={canDeleteAny}
            canManageStickers={can("manage_stickers")}
            jumpTo={jump?.channelId === view.channel.id ? jump.messageId : null}
            onJumped={() => setJump(null)} />
        ) : (
          <div className="pane-empty muted">{text.length ? "Opening…" : "Nothing to show yet."}</div>
        )}
      </main>
      {dialog?.k === "create" && (
        <CreateChannelDialog
          call={call}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
          onCreated={(c) => {
            setDialog(null);
            void chat.refreshChannels().then(() => {
              if (c.kind === "text") {
                setOpenId(c.id);
                setHomeOpen(false);
                setCallView(false);
              }
            });
          }}
        />
      )}
      {dialog?.k === "share" && voiceClient && (
        <ShareDialog voice={voiceClient} onClose={() => setDialog(null)} />
      )}
      {dialog?.k === "prefs" && (
        <SettingsDialog tab={dialog.tab} session={session} call={call} chat={chat} deviceId={chat.session.status.deviceId}
          backup={backup} busy={busy} actions={accountActions}
          voice={voiceClient} snap={vsnap} loadVoice={ensureVoice} onClose={() => setDialog(null)} />
      )}
      {dialog?.k === "server" && isStaff && (
        <ServerSettingsDialog call={call} me={{ userId: session.user_id, permissions: perms, rank }}
          reload={permsTick + reportsTick + bugsTick} openReports={openReports} openBugReports={openBugs}
          initialTab={dialog.tab}
          onClose={() => {
            setDialog(null);
            setReportsTick((t) => t + 1);
            setBugsTick((t) => t + 1);
          }} />
      )}
      {person && voiceClient && (
        <PersonMenu voice={voiceClient}
          person={vsnap?.participants.find((p) => p.id === person.p.id) ?? person.p}
          at={person.at} call={call} canServerMute={can("server_mute")}
          onClose={() => setPerson(null)} />
      )}
      {chanMenu && menuChannel && (
        <ChannelMenu title={`${menuChannel.kind === "text" ? "#" : ""}${menuChannel.name}`} at={chanMenu.at}
          items={menuItems(menuChannel)} onClose={() => setChanMenu(null)} />
      )}
      {dialogChannel && (
        <ChannelSettingsDialog
          key={dialogChannel.id}
          focus={dialog?.k === "settings" ? dialog.focus : undefined}
          call={call}
          channel={dialogChannel}
          canManage={canManage}
          canForcePTT={canForcePTT}
          onClose={() => {
            setDialog(null);
            void chat.refreshChannels().catch(() => {});
          }}
          onDeleted={() => {
            setDialog(null);
            void chat.refreshChannels().catch(() => {});
          }}
        />
      )}
    </div>
    </LinksContext>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path fill="currentColor" d="M9.4 1l.3 1.8c.5.2.9.4 1.3.7l1.7-.7 1.4 2.4-1.4 1.1a5 5 0 0 1 0 1.5l1.4 1.1-1.4 2.4-1.7-.7c-.4.3-.8.5-1.3.7L9.4 15H6.6l-.3-1.8c-.5-.2-.9-.4-1.3-.7l-1.7.7-1.4-2.4 1.4-1.1a5 5 0 0 1 0-1.5L1.9 7.1l1.4-2.4 1.7.7c.4-.3.8-.5 1.3-.7L6.6 1h2.8zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="lock" viewBox="0 0 16 16" width="12" height="12" aria-label="encrypted" role="img">
      <path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2z" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg className="hash" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path fill="currentColor" d="M2 6h2.5L8 3v10L4.5 10H2zM10.5 5.2a4 4 0 0 1 0 5.6l-.9-.9a2.7 2.7 0 0 0 0-3.8z" />
    </svg>
  );
}

function UserPanel({ session, backup, notice, busy, onLogout, onBackUpNow, onSetUpKey, onEnterKey, onSettings }: {
  session: Session;
  backup: BackupStatus | null;
  notice: string | null;
  busy: string | null;
  onLogout: () => void;
  onBackUpNow: () => void;
  onSetUpKey: () => void;
  onEnterKey: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="user-panel">
      <div className="who">
        <strong>{session.username}</strong>
        <span className="muted small">
          {!backup && <>No recovery key. <button className="link small" onClick={onSetUpKey}>Set one up</button></>}
          {backup && !backup.unlocked && <>Not backing up. <button className="link small" onClick={onEnterKey}>Enter key</button></>}
          {backup?.unlocked && (
            <>Backed up <TimeAgo at={backup.updatedAt} />. <button className="link small" onClick={onBackUpNow} disabled={!!busy}>Back up now</button></>
          )}
        </span>
        {notice && <span className="muted small" role="status">{notice}</span>}
      </div>
      <button className="icon" onClick={onSettings} title="Settings" aria-label="Settings">
        <GearIcon />
      </button>
      <button className="secondary" onClick={onLogout} disabled={!!busy}>{busy ?? "Log out"}</button>
    </div>
  );
}

/** Re-render once a minute, for relative times. */
function useMinuteTick(): number {
  return useSyncExternalStore(
    (cb) => {
      const t = setInterval(cb, 60_000);
      return () => clearInterval(t);
    },
    () => Math.floor(Date.now() / 60_000),
  );
}

function TimeAgo({ at }: { at: string }) {
  useMinuteTick();
  return <>{timeAgo(at)}</>;
}

function timeAgo(at: string): string {
  const s = (Date.now() - Date.parse(at)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}
