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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent } from "react";
import { Chat, dmChannel, type ChannelCategory, type ChannelView, type ChannelInfo, type DMInfo, type VoicePresence } from "@core/chat";
import type { VoiceClient, VoiceParticipant } from "@core/voice";
import type { BackupStatus } from "@core/recovery";
import type { Session } from "./api";
import type { BackupManager } from "./backup";
import { apiCall, cryptoSession, localStore, wsUrl } from "./core";
import { BellIcon, ChannelPane } from "./ChannelPane";
import { ChannelSettingsDialog, CreateChannelDialog } from "./ChannelDialogs";
import { ChannelMenu, useMenuTrigger, type MenuItem } from "./ChannelMenu";
import {
  CallView, MenuNote, MOVE_DRAG_TYPE, MoveMenu, PersonMenu, ShareDialog, Stage, VoiceBar, VoiceRoster,
  usePushToTalk, useVoiceSnapshot,
} from "./VoiceUI";
import { messageCooldown, mutedChannels, playSound, setChannelMuted, useMutedChannels, useVoiceSounds } from "./sounds";
import { getToggle, MENTION_NOTIFY } from "./settings";
import { SettingsDialog, type AccountActions, type SettingsTab } from "./SettingsDialog";
import { ServerSettingsDialog } from "./ServerSettings";
import { configureStickers, refreshStickers } from "./stickers";
import { configureNames, refreshNames } from "./names";
import { checkForNewVersion } from "./newVersion";
import { avatarChanged, configureAvatars, refreshAvatars, useAvatarVersion } from "./avatars";
import { channelLink, LinksContext, onAddressTarget, takePendingTarget, type LinkTarget, type Links } from "./links";
import { serverInfoChanged, useServerInfo } from "./serverInfo";
import { configureHome, HomeIcon, HomePane, markHomeSeen, refreshHome, useHome } from "./home";
import type { ServerTab } from "./ServerSettings";
import { isStaffPerms } from "./perms";
import { DMList, NewMessageDialog } from "./dms";
import { ProfileCard } from "./profiles";
import { configureStatuses, refreshStatuses, SetStatusDialog, statusChanged, StatusLine, useStatus } from "./statuses";
import { mayDM, NO_DM_REASON } from "./dmText";
import { SidebarResizer, useSidebarWidth } from "./sidebarWidth";
import {
  CategoryDialog, DeleteCategoryDialog, MoveChannelDialog, mergeDrop, sectionLayout, stepMoves, useCollapsedCategories, useLayoutDrag,
} from "./channelCategories";

const LAST_CHANNEL = (userId: string) => `lastChannel.${userId}`;
/** "1" when Home was the last thing open: you come back to it. */
const LAST_HOME = (userId: string) => `lastHome.${userId}`;
/** Least time between two alert sounds from one direct message. */
const DM_SOUND_COOLDOWN_MS = 60_000;
/** Least time between two @mention sounds, across all channels. */
const MENTION_SOUND_COOLDOWN_MS = 60_000;
/** "dms" when the sidebar last showed Direct Messages. */
const SIDE_TAB = (userId: string) => `sideTab.${userId}`;

/** Someone whose name was clicked, for the name menu ("Message"). */
export interface NamedUser {
  id: string;
  username: string;
}

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
  // Sidebar categories (channelCategories.tsx), and which ones this
  // browser has collapsed.
  const [categories, setCategories] = useState<readonly ChannelCategory[]>([]);
  const [collapsedCats, setCollapsedCat] = useCollapsedCategories();
  const [dms, setDms] = useState<readonly DMInfo[]>([]);
  /** User ids you block (Chat.blocked). */
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const dmsRef = useRef<readonly DMInfo[]>([]);
  dmsRef.current = dms;
  // Which list the sidebar shows: the channels or your direct messages.
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  const [sideTab, setSideTabState] = useState<"channels" | "dms">(
    () => localStore.get(SIDE_TAB(session.user_id)) === "dms" ? "dms" : "channels");
  const setSideTab = (t: "channels" | "dms") => {
    setSideTabState(t);
    localStore.set(SIDE_TAB(session.user_id), t);
  };
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
  // When the last @mention sound played, in any channel (one cooldown
  // for all of them, so mention spam can't be spread across channels).
  const mentionSoundAt = useRef<number | null>(null);
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
    | { k: "create"; kind: "text" | "voice"; categoryId?: string }
    | { k: "category"; kind: "text" | "voice"; id?: string }
    | { k: "deleteCategory"; id: string }
    | { k: "settings"; id: string; focus?: "name" | "delete" }
    | { k: "share" }
    | { k: "prefs"; tab: SettingsTab }
    | { k: "server"; tab?: ServerTab }
    | { k: "newdm" }
    | { k: "status" }
    | null
  >(null);
  // The right-click (or long-press) menu on a channel in the sidebar.
  const [chanMenu, setChanMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  // The menu on a category header (catId), the section's + menu, or a
  // right-click on the Text channels heading (section).
  const [layoutMenu, setLayoutMenu] = useState<{ kind: "text" | "voice"; catId?: string; section?: boolean; at: { x: number; y: number } } | null>(null);
  // Right-click on the Messages tab: Mark All as Read for direct messages.
  const [dmTabMenu, setDmTabMenu] = useState<{ x: number; y: number } | null>(null);
  // Move to Category from a channel's menu: the categories to pick from.
  const [catPicker, setCatPicker] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  // A newer web client on the server (newVersion.ts), and the one the
  // notice was closed for.
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  // The profile card on someone's name (a message author; someone in a
  // call through View Profile): profiles.tsx.
  const [nameMenu, setNameMenu] = useState<{ user: NamedUser; at: { x: number; y: number } } | null>(null);
  const nameMenuHasAvatar = useAvatarVersion(nameMenu?.user.id) !== undefined;
  const nameMenuHasStatus = useStatus(nameMenu?.user.id) !== undefined;
  const closeNameMenu = useCallback(() => setNameMenu(null), []);
  // Channel rows and category headers: a tap opens, a long press opens
  // the menu, a long press then moving the finger drags (manage_channels).
  const rowAt = (id: string) => document.querySelector(`[data-drop-key="${CSS.escape(id)}"]`);
  const menuTrigger = useMenuTrigger((id, at) => setChanMenu({ id, at }), {
    start: (id, at) => {
      const c = channels.find((x) => x.id === id);
      if (!c || (c.kind !== "text" && c.kind !== "voice")) return false;
      const ok = layoutDrag.touch.start({ what: "channel", id, kind: c.kind },
        `${c.kind === "text" ? "#" : ""}${c.name}`, at, rowAt(id));
      if (ok) setChanMenu(null);
      return ok;
    },
    move: (at) => layoutDrag.touch.move(at),
    end: (at) => layoutDrag.touch.end(at),
  });
  const sectionMenuTrigger = useMenuTrigger((_id, at) => setLayoutMenu({ kind: "text", section: true, at }));
  const dmTabMenuTrigger = useMenuTrigger((_id, at) => setDmTabMenu(at));
  const catMenuTrigger = useMenuTrigger((id, at) => {
    const cat = categories.find((c) => c.id === id);
    if (cat) setLayoutMenu({ kind: cat.kind, catId: id, at });
  }, {
    start: (id, at) => {
      const cat = categories.find((x) => x.id === id);
      if (!cat) return false;
      const ok = layoutDrag.touch.start({ what: "category", id, kind: cat.kind }, cat.name, at, rowAt(id));
      if (ok) setLayoutMenu(null);
      return ok;
    },
    move: (at) => layoutDrag.touch.move(at),
    end: (at) => layoutDrag.touch.end(at),
  });
  const [presence, setPresence] = useState<VoicePresence>({});
  // Created on first join: loading it pulls in LiveKit, which text-only
  // use never needs.
  const [voiceClient, setVoiceClient] = useState<VoiceClient | null>(null);
  const vsnap = useVoiceSnapshot(voiceClient);
  // For the event handler, which is set up once per session.
  const voiceRef = useRef<VoiceClient | null>(null);
  voiceRef.current = voiceClient;
  const muted = useMutedChannels();
  usePushToTalk(voiceClient, vsnap);
  useVoiceSounds(vsnap);
  const [stage, setStage] = useState<{ focus: string | null } | null>(null);
  // The main area shows the call (tiles) rather than chat: on joining, or
  // on clicking the voice channel you're in; a text channel turns it off.
  const [callView, setCallView] = useState(false);
  const [person, setPerson] = useState<{ p: VoiceParticipant; at: { x: number; y: number } } | null>(null);
  // Move or disconnect someone in a call you're not in (move_members).
  const [moveMenu, setMoveMenu] = useState<{
    p: { user_id: string; username: string }; from: string; at: { x: number; y: number };
  } | null>(null);
  // Drag and drop moves (move_members): who is being dragged and from
  // where (drag data can't be read until the drop), the channel it's
  // over, and why a drop was refused.
  const dragging = useRef<{ p: { user_id: string; username: string }; from: string } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [dropNote, setDropNote] = useState<{ title: string; text: string; at: { x: number; y: number } } | null>(null);
  const call = useMemo(() => apiCall(session.token, onExpired),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.token]);
  // Drag-to-reorder channels and categories (manage_channels).
  const layoutError = useCallback((title: string, err: unknown, at: { x: number; y: number }) =>
    setDropNote({ title, text: err instanceof Error ? err.message : String(err), at }), []);
  // Every move of a channel to another place asks first, showing what
  // each permissions choice changes (MoveChannelDialog); the answer
  // settles the move's promise. Reordering within one place doesn't.
  type MoveChoice = { keep_access?: boolean; follow_category?: boolean } | null;
  const [moveAsk, setMoveAsk] = useState<{
    channel: ChannelInfo; from?: ChannelCategory; to?: ChannelCategory; answer: (c: MoveChoice) => void;
  } | null>(null);
  const confirmMove = useCallback((channelId: string, categoryId: string | null) => {
    const c = channels.find((x) => x.id === channelId);
    if (!c || (c.category_id ?? null) === categoryId) return Promise.resolve({});
    const from = categories.find((x) => x.id === c.category_id);
    const to = categoryId ? categories.find((x) => x.id === categoryId) : undefined;
    return new Promise<MoveChoice>((resolve) =>
      setMoveAsk({ channel: c, from, to, answer: (choice) => { setMoveAsk(null); resolve(choice); } }));
  }, [channels, categories]);
  const layoutDrag = useLayoutDrag(call,
    perms.includes("manage_channels") || perms.includes("administrator"), layoutError, confirmMove);
  // A Move Up / Move Down from a menu is on its way: those entries wait
  // for the refetched layout (channel_layout_changed), so a quick second
  // tap moves from the new place, not the old one.
  const [moving, setMoving] = useState(false);
  useEffect(() => setMoving(false), [channels, categories]);
  useEffect(() => {
    if (!moving) return;
    const t = window.setTimeout(() => setMoving(false), 3000);
    return () => clearTimeout(t);
  }, [moving]);
  const runMove = (p: Promise<boolean>) => {
    setMoving(true);
    void p.then((ok) => { if (!ok) setMoving(false); });
  };

  // Shift+Esc: every text channel read (not direct messages), as in
  // Discord. Not while a dialog or menu is open, or another field has focus.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !e.shiftKey || e.defaultPrevented) return;
      if (document.querySelector("[role=dialog], [role=menu], [role=listbox], .modal-backdrop")) return;
      if (!chat || (e.target as HTMLElement | null)?.closest("input, select, textarea:not(.composer textarea)")) return;
      chat.markAllRead(chat.channels.filter((c) => c.kind === "text").map((c) => c.id));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [chat]);
  // Sticker images need the token (stickers.tsx).
  useEffect(() => configureStickers(call, session.token), [call, session.token]);
  // Username colours by group (names.tsx).
  useEffect(() => configureNames(call), [call]);
  // User avatars (avatars.tsx); the pictures need the token.
  useEffect(() => configureAvatars(call, session.token), [call, session.token]);
  // Custom statuses (statuses.tsx).
  useEffect(() => configureStatuses(call), [call]);
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
          if (e.type === "channels") {
            setChannels(e.channels);
            setCategories(e.categories);
          }
          else if (e.type === "dms") setDms(e.dms);
          else if (e.type === "blocks") setBlocked(c.blocked);
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
            // Quiet only when you're already looking at that channel, or
            // for a direct message whose sounds you muted (every message
            // in one alerts like a mention, so Mute Sounds has to cover it).
            if (e.open && looking()) return;
            if (e.dm && mutedChannels().has(e.channelId)) return;
            // A direct message plays at most once a minute per conversation
            // (sound and pop-up), so a flood of messages can't be used to
            // spam someone. Looking at the conversation resets it.
            if (e.dm) {
              const last = soundAt.current.get(e.channelId);
              if (last !== undefined && Date.now() - last < DM_SOUND_COOLDOWN_MS) return;
            } else {
              // @mentions: at most once a minute over all channels, sound
              // and pop-up. The @ badge still shows on every channel.
              const last = mentionSoundAt.current;
              if (last !== null && Date.now() - last < MENTION_SOUND_COOLDOWN_MS) return;
              mentionSoundAt.current = Date.now();
            }
            // The mention sound counts towards the channel's cooldown.
            soundAt.current.set(e.channelId, Date.now());
            void playSound("mention");
            if (getToggle(MENTION_NOTIFY) && typeof Notification !== "undefined"
              && Notification.permission === "granted") {
              const name = channelsRef.current.find((ch) => ch.id === e.channelId)?.name;
              // Who and where only: in an encrypted channel the text isn't
              // decrypted until the channel is open, and a notification
              // can be seen by anyone near the screen.
              const n = new Notification(e.dm
                ? `${e.username || "Someone"} sent you a message`
                : `${e.username || "Someone"} mentioned you`, {
                body: !e.dm && name ? `in #${name}` : undefined,
                tag: `mention:${e.messageId}`,
                // Our own mention tone already played; without this the
                // OS adds its notification sound on top.
                silent: true,
              });
              n.onclick = () => {
                window.focus();
                setOpenId(e.channelId);
                if (e.dm) setSideTab("dms");
                setHomeOpen(false);
                setStage(null);
                setCallView(false);
                n.close();
              };
            }
          }
          else if (e.type === "voice") setPresence(e.presence);
          else if (e.type === "voice_moved") {
            // Sent to every device of this account; only the one in that
            // call acts. The server takes a device that doesn't out of the
            // old call anyway.
            const v = voiceRef.current;
            if (!v) return;
            const who = e.username || "A moderator";
            if (!e.to) {
              void v.endedBy(e.from, `${who} disconnected you from the call.`);
              return;
            }
            const snap = v.snapshot();
            if (snap.state === "idle" || snap.channelId !== e.from) return;
            const name = channelsRef.current.find((ch) => ch.id === e.to)?.name ?? "another channel";
            void v.join(e.to).then(() => {
              if (v.snapshot().channelId === e.to) v.showNotice(`${who} moved you to ${name}.`);
              void c.refreshVoice();
            });
          }
          else if (e.type === "reports_changed") setReportsTick((t) => t + 1);
          else if (e.type === "bug_reports_changed") setBugsTick((t) => t + 1);
          else if (e.type === "stickers_changed") void refreshStickers();
          else if (e.type === "names_changed") refreshNames();
          else if (e.type === "avatars_changed") avatarChanged(e.userId, e.version);
          else if (e.type === "status_changed") statusChanged(e.userId, e.status);
          else if (e.type === "server_info_changed") serverInfoChanged();
          else if (e.type === "home_changed") void refreshHome();
          else if (e.type === "events_reconnected") {
            // Server-wide events sent while the socket was down are lost.
            serverInfoChanged();
            void refreshHome();
            void refreshStickers();
            refreshNames();
            refreshAvatars();
            refreshStatuses();
            refreshMe();
            // A server restart may have brought a new web client.
            void checkForNewVersion().then((v) => v && setNewVersion(v));
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
        setCategories(c.categories);
        setDms(c.dms);
        setBlocked(c.blocked);
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
  // The text channel pane is on screen (not Home, the call or a stream).
  const paneShown = homeOpen === false && !showCall && !(stage && voiceClient);

  // The open channel only counts as read while you can see it: a
  // background tab, another window in front, or Home, the call or a
  // stream in its place leaves it unread.
  useEffect(() => {
    if (!chat) return;
    const update = () => chat.setLooking(paneShown && document.visibilityState === "visible" && document.hasFocus());
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [chat, paneShown]);
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
    setSideTab("channels");
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
    if (!chat || (!text.length && !dms.length)) return;
    const opened = takePendingTarget();
    if (opened && goRef.current(opened)) return;
    const known = (id: string | null) => !!id && (text.some((c) => c.id === id) || dms.some((d) => d.channel_id === id));
    if (known(openId)) return;
    const last = localStore.get(LAST_CHANNEL(session.user_id));
    setOpenId(known(last) ? last : text[0]?.id ?? null);
  }, [chat, text, dms, openId, session.user_id]);

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

  /** Open your direct message with someone, starting it if needed.
   * Resolves to the server's refusal, or null once it is open. */
  async function openDM(userId: string): Promise<string | null> {
    if (!chat) return "Not connected yet.";
    try {
      const d = await chat.startDM(userId);
      setOpenId(d.channel_id);
      setSideTab("dms");
      setHomeOpen(false);
      setStage(null);
      setCallView(false);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  /** "Message" from a name menu; a refusal shows where the menu was. */
  const messageFrom = (u: NamedUser, at: { x: number; y: number }) => {
    void openDM(u.id).then((err) => err && setDropNote({ title: `Couldn't message ${u.username}`, text: err, at }));
  };

  /** Block or Unblock from a menu; a refusal shows where the menu was. */
  const toggleBlock = (u: NamedUser, at: { x: number; y: number }) => {
    if (!chat) return;
    const was = chat.blocked.has(u.id);
    void (was ? chat.unblock(u.id) : chat.block(u.id, u.username)).catch((err) =>
      setDropNote({ title: `Couldn't ${was ? "unblock" : "block"} ${u.username}`, text: err instanceof Error ? err.message : String(err), at }));
  };
  /** Moderators: Remove Avatar (logged; the server checks rank). */
  const removeAvatar = (u: NamedUser, at: { x: number; y: number }) => {
    void call(`/api/v1/avatars/${u.id}`, { method: "DELETE" }).then(
      () => avatarChanged(u.id, null),
      (err) => setDropNote({ title: `Couldn't remove ${u.username}'s avatar`, text: err instanceof Error ? err.message : String(err), at }));
  };
  /** Moderators: Clear Bio (logged; the server checks rank). */
  const clearBio = (u: NamedUser, at: { x: number; y: number }) => {
    void call(`/api/v1/users/${u.id}/bio`, { method: "DELETE" }).catch((err) =>
      setDropNote({ title: `Couldn't clear ${u.username}'s bio`, text: err instanceof Error ? err.message : String(err), at }));
  };
  const clearStatus = (u: NamedUser, at: { x: number; y: number }) => {
    void call(`/api/v1/users/${u.id}/status`, { method: "DELETE" }).catch((err) =>
      setDropNote({ title: `Couldn't clear ${u.username}'s status`, text: err instanceof Error ? err.message : String(err), at }));
  };
  const blockItem = (u: NamedUser, at: { x: number; y: number }): MenuItem => blocked.has(u.id)
    ? { label: "Unblock", onClick: () => toggleBlock(u, at) }
    : { label: "Block", onClick: () => toggleBlock(u, at), danger: true };

  const accountActions: AccountActions = {
    onBackUpNow, onSetUpKey, onEnterKey, onNewKey,
    onDeleteAccount: (password) => onDeleteAccount(chat, password),
    onEraseAndLogout: () => onEraseAndLogout(chat, chat.session.status.deviceId),
  };

  const can = (p: string) => perms.includes(p) || perms.includes("administrator");
  const canDeleteAny = can("delete_messages");
  const canManage = can("manage_channels");
  const canForcePTT = can("force_ptt");
  const canMove = can("move_members");
  // Staff: anyone holding a switch (Direct messages aside). They see the
  // member list; changing groups needs manage_groups (checked inside the dialog).
  const isStaff = isStaffPerms(perms);
  const canDM = mayDM(perms);
  const dmAlerts = dms.filter((d) => mentions.has(d.channel_id)).length;
  const onName = (u: NamedUser, at: { x: number; y: number }) => {
    if (u.id) setNameMenu({ user: u, at });
  };
  const settingsFor = (c: ChannelInfo) => canManage || (c.kind === "voice" && canForcePTT);
  const dialogChannel = dialog?.k === "settings" ? channels.find((c) => c.id === dialog.id) : undefined;

  const gear = (c: ChannelInfo) => settingsFor(c) && (
    <button className="icon gear" onClick={() => setDialog({ k: "settings", id: c.id })}
      title={`${c.name} settings`} aria-label={`${c.name} settings`}>
      <GearIcon />
    </button>
  );
  const NEEDS_MANAGE = "Needs the Manage channels permission";
  // Move Up / Move Down: greyed without manage_channels, at either end,
  // and while the last move is on its way.
  const stepItems = (up: string | undefined, down: string | null | undefined,
    move: (before: string | null) => Promise<boolean>): MenuItem[] => {
    const why = (end: string) => !canManage ? NEEDS_MANAGE : moving ? "Moving…" : end;
    return [
      { label: "Move Up", keepOpen: true, disabled: !canManage || moving || up === undefined,
        reason: why("Already at the top"), onClick: () => up !== undefined && runMove(move(up)) },
      { label: "Move Down", keepOpen: true, disabled: !canManage || moving || down === undefined,
        reason: why("Already at the bottom"), onClick: () => down !== undefined && runMove(move(down)) },
    ];
  };
  const menuItems = (c: ChannelInfo): (MenuItem | "sep")[] => {
    const at = chanMenu?.at ?? { x: 0, y: 0 };
    const moves: MenuItem[] = [];
    if (c.kind === "text" || c.kind === "voice") {
      // Its place: the top level, or the category it's in.
      const lay = sectionLayout(channels, categories, c.kind);
      const group = lay.groups.find((g) => g.cat.id === c.category_id);
      const place = group ? group.channels : lay.top;
      const { up, down } = stepMoves(place, c.id);
      moves.push(
        ...stepItems(up, down, (before) => layoutDrag.moveChannel(c.id, group?.cat.id ?? null, before, at)),
        { label: "Move to Category…", onClick: () => setCatPicker({ id: c.id, at }),
          disabled: !canManage, reason: NEEDS_MANAGE },
      );
    }
    const manage: MenuItem[] = [
      ...moves,
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
    if (c.kind === "dm") {
      const other = c.dm && !c.dm.user.deleted ? { id: c.dm.user.id, username: c.dm.user.username } : null;
      return [
        { label: "Mark as Read", onClick: () => chat.markAllRead([c.id]),
          disabled: !unread.has(c.id) && !mentions.has(c.id), reason: "Nothing unread" },
        { label: isMuted ? "Unmute Sounds" : "Mute Sounds", onClick: () => setChannelMuted(c.id, !isMuted) },
        ...(other && chanMenu ? ["sep" as const, blockItem(other, chanMenu.at)] : []),
      ];
    }
    return [
      { label: "Mark as Read", onClick: () => chat.markAllRead([c.id]),
        disabled: !unread.has(c.id) && !mentions.has(c.id), reason: "Nothing unread" },
      { label: isMuted ? "Unmute Sounds" : "Mute Sounds", onClick: () => setChannelMuted(c.id, !isMuted) },
      { label: "Copy Channel Link", onClick: () => void navigator.clipboard.writeText(channelLink(c.id)).catch(() => {}) },
      "sep",
      ...manage,
    ];
  };
  const pickerChannel = catPicker ? channels.find((c) => c.id === catPicker.id) : undefined;
  const menuChannel = chanMenu ? channels.find((c) => c.id === chanMenu.id)
    ?? (() => {
      const d = dms.find((x) => x.channel_id === chanMenu.id);
      return d && dmChannel(d);
    })() : undefined;

  // A section heading ("Text channels"): + opens Create Channel /
  // Create Category; a channel dropped on it goes to the top level.
  const heading = (label: string, kind: "text" | "voice") => (
    <div className={`list-head${layoutDrag.hintClass(`section-${kind}`)}`} {...layoutDrag.sectionDrop(kind)}
      {...(kind === "text" ? sectionMenuTrigger.handlers("text") : {})}>
      <h2>{label}</h2>
      {canManage && (
        <button className="icon" title={`Create a ${kind} channel or category`} aria-label={`Create a ${kind} channel or category`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setLayoutMenu({ kind, at: { x: r.left, y: r.bottom + 4 } });
          }}>+</button>
      )}
    </div>
  );

  const openText = (id: string) => {
    setOpenId(id);
    setHomeOpen(false);
    setStage(null);
    setCallView(false);
  };
  const openVoice = (id: string) => {
    setStage(null);
    setCallView(true);
    void joinVoice(id);
  };
  const textRow = (c: ChannelInfo, scope: readonly ChannelInfo[]) => (
    <li key={c.id} className={`channel-row${layoutDrag.hintClass(c.id)}`}
      {...layoutDrag.channelDrop(c, scope)} {...layoutDrag.channelDrag(c)}>
      <button
        className={`channel${c.id === openId && !homeOpen ? " active" : ""}${unread.has(c.id) || mentions.has(c.id) ? " unread" : ""}`}
        {...menuTrigger.handlers(c.id, () => openText(c.id))}
        onClick={() => {
          if (menuTrigger.touchHandled()) return;
          openText(c.id);
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
  );

  const voiceRow = (c: ChannelInfo, scope: readonly ChannelInfo[]) => {
    const here = vsnap && vsnap.state !== "idle" && vsnap.channelId === c.id;
    // Dragged people (move_members) and dragged channels (manage_channels)
    // both land here; each handler ignores the other's drags.
    const memberDrop = canMove ? {
      onDragOver: (e: DragEvent) => {
        const d = dragging.current;
        if (!d || d.from === c.id || !e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dropOn !== c.id) setDropOn(c.id);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
      },
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
        setDropOn(null);
        const d = dragging.current;
        dragging.current = null;
        if (!d || d.from === c.id) return;
        const at = { x: e.clientX, y: e.clientY };
        call(`/api/v1/users/${d.p.user_id}/voice-move`, {
          method: "POST",
          body: JSON.stringify({ from_channel_id: d.from, to_channel_id: c.id }),
        }).catch((err) => setDropNote({
          title: `Couldn't move ${d.p.username}`,
          text: err instanceof Error ? err.message : String(err),
          at,
        }));
      },
    } : {};
    return (
      <li key={c.id} className={`voice-item${dropOn === c.id ? " drop-target" : ""}${layoutDrag.hintClass(c.id)}`}
        {...mergeDrop(memberDrop, layoutDrag.channelDrop(c, scope))}>
        <div className="channel-row" {...layoutDrag.channelDrag(c)}>
          <button className={`channel${here ? " active" : ""}`}
            {...menuTrigger.handlers(c.id, () => openVoice(c.id))}
            onClick={() => {
              if (menuTrigger.touchHandled()) return;
              openVoice(c.id);
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
          onOther={canMove ? (p, at) => setMoveMenu({ p, from: c.id, at })
            : (p, at) => onName({ id: p.user_id, username: p.username }, at)}
          onDrag={canMove ? (p) => {
            dragging.current = p && { p, from: c.id };
            if (!p) setDropOn(null);
          } : undefined}
        />
      </li>
    );
  };

  // A section: top-level channels, then its categories. A collapsed
  // category still shows the channel you have open or the call you're in.
  const section = (kind: "text" | "voice") => {
    const lay = sectionLayout(channels, categories, kind);
    const row = kind === "text" ? textRow : voiceRow;
    const cats = lay.groups.map((g) => g.cat);
    const showing = (c: ChannelInfo) => kind === "text"
      ? c.id === openId && !homeOpen
      : !!vsnap && vsnap.state !== "idle" && vsnap.channelId === c.id;
    return (
      <ul>
        {lay.top.map((c) => row(c, lay.top))}
        {lay.groups.map(({ cat, channels: inside }) => {
          const shut = collapsedCats.has(cat.id);
          const shown = shut ? inside.filter(showing) : inside;
          const mention = shut && inside.some((c) => mentions.has(c.id));
          const unreadIn = shut && inside.some((c) => unread.has(c.id));
          return (
            <li key={cat.id} className="category">
              <div className={`category-head${layoutDrag.hintClass(cat.id)}`}
                {...layoutDrag.categoryDrop(cat, cats)} {...layoutDrag.categoryDrag(cat)}>
                <button className={`category-toggle${mention || unreadIn ? " unread" : ""}`}
                  style={cat.colour ? { color: cat.colour } : undefined}
                  aria-expanded={!shut}
                  title={shut ? "Show channels" : "Hide channels"}
                  {...catMenuTrigger.handlers(cat.id, () => setCollapsedCat(cat.id, !shut))}
                  onClick={() => {
                    if (catMenuTrigger.touchHandled()) return;
                    setCollapsedCat(cat.id, !shut);
                  }}>
                  <span className={`chevron${shut ? " shut" : ""}`} aria-hidden>▾</span>
                  <span className="name">{cat.name}</span>
                  {mention
                    ? <span className="mention-badge" aria-label="you were mentioned" title="You were mentioned">@</span>
                    : unreadIn && <span className="dot" aria-label="unread" />}
                </button>
                {canManage && (
                  <button className="icon" title={`Create a channel in ${cat.name}`} aria-label={`Create a channel in ${cat.name}`}
                    onClick={() => setDialog({ k: "create", kind, categoryId: cat.id })}>+</button>
                )}
              </div>
              {shown.length > 0 && <ul>{shown.map((c) => row(c, inside))}</ul>}
              {!shut && !inside.length && canManage && (
                <p className="muted empty">Drag channels here.</p>
              )}
            </li>
          );
        })}
        {!lay.top.length && !lay.groups.some((g) => g.channels.length) && (
          <li className="muted empty">{kind === "text" ? "No channels you can see." : "No voice channels yet."}</li>
        )}
      </ul>
    );
  };

  // Mark Category / All as Read, greyed when none of `ids` is unread.
  const markReadItem = (label: string, ids: readonly string[]): MenuItem => ({
    label, onClick: () => chat.markAllRead(ids),
    disabled: !ids.some((id) => unread.has(id) || mentions.has(id)), reason: "Nothing unread",
  });
  const textIds = channels.filter((c) => c.kind === "text").map((c) => c.id);

  // The category menu, or the section's + menu.
  const layoutMenuCat = layoutMenu?.catId ? categories.find((c) => c.id === layoutMenu.catId) : undefined;
  const layoutMenuItems = (): (MenuItem | "sep")[] => {
    if (!layoutMenu) return [];
    const kind = layoutMenu.kind;
    if (!layoutMenuCat && layoutMenu.section) {
      return [
        markReadItem("Mark All as Read", textIds),
        "sep",
        { label: "Create Channel", onClick: () => setDialog({ k: "create", kind }), disabled: !canManage, reason: NEEDS_MANAGE },
        { label: "Create Category", onClick: () => setDialog({ k: "category", kind }), disabled: !canManage, reason: NEEDS_MANAGE },
      ];
    }
    if (!layoutMenuCat) {
      return [
        { label: "Create Channel", onClick: () => setDialog({ k: "create", kind }) },
        { label: "Create Category", onClick: () => setDialog({ k: "category", kind }) },
      ];
    }
    const cat = layoutMenuCat;
    const shut = collapsedCats.has(cat.id);
    const at = layoutMenu.at;
    const { up, down } = stepMoves(categories.filter((c) => c.kind === kind), cat.id);
    const inCat = channels.filter((c) => c.kind === "text" && c.category_id === cat.id).map((c) => c.id);
    return [
      ...(kind === "text" ? [markReadItem("Mark Category as Read", inCat)] : []),
      { label: shut ? "Expand Category" : "Collapse Category", onClick: () => setCollapsedCat(cat.id, !shut) },
      "sep",
      ...stepItems(up, down, (before) => layoutDrag.moveCategory(cat.id, before, at)),
      { label: "Create Channel", onClick: () => setDialog({ k: "create", kind, categoryId: cat.id }),
        disabled: !canManage, reason: NEEDS_MANAGE },
      { label: "Edit Category", onClick: () => setDialog({ k: "category", kind, id: cat.id }),
        disabled: !canManage, reason: NEEDS_MANAGE },
      { label: "Delete Category", onClick: () => setDialog({ k: "deleteCategory", id: cat.id }),
        disabled: !canManage, reason: NEEDS_MANAGE, danger: true },
    ];
  };

  return (
    <LinksContext value={links}>
    <div className="app" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
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
        <div className="settings-tabs sidebar-tabs" role="tablist" aria-label="Sidebar">
          <button role="tab" aria-selected={sideTab === "channels"} className={sideTab === "channels" ? "on" : undefined}
            onClick={() => setSideTab("channels")}>Channels</button>
          <button role="tab" aria-selected={sideTab === "dms"} className={sideTab === "dms" ? "on" : undefined}
            {...dmTabMenuTrigger.handlers("dms", () => setSideTab("dms"))}
            onClick={() => {
              if (dmTabMenuTrigger.touchHandled()) return;
              setSideTab("dms");
            }}
            title={dmAlerts ? `Direct Messages: ${dmAlerts} with new messages` : "Direct Messages"}>
            Messages
            {dmAlerts > 0 && <span className="mention-badge" aria-label={`${dmAlerts} with new messages`}>{dmAlerts}</span>}
          </button>
        </div>
        <div className="channel-list">
          {sideTab === "dms" ? (
            <DMList dms={dms} openId={homeOpen ? null : openId} unread={unread} mentions={mentions} muted={muted}
              canStart={canDM}
              onOpen={(id) => {
                setOpenId(id);
                setHomeOpen(false);
                setStage(null);
                setCallView(false);
              }}
              onNew={() => setDialog({ k: "newdm" })}
              menuHandlers={menuTrigger.handlers} touchHandled={menuTrigger.touchHandled} />
          ) : (<>
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
          {section("text")}
          {(voiceChannels.length > 0 || canManage) && (
            <>
              {heading("Voice channels", "voice")}
              {section("voice")}
            </>
          )}
          </>)}
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
          onStatus={() => setDialog({ k: "status" })}
          onSetUpKey={onSetUpKey} onEnterKey={onEnterKey} />
        <SidebarResizer width={sidebarWidth} onWidth={setSidebarWidth} />
      </nav>
      <main className="pane">
        {/* Not during a call: reloading would drop it (gaming first). */}
        {newVersion && newVersion !== dismissedVersion && !(vsnap && vsnap.state !== "idle") && (
          <div className="update-bar" role="status">
            <span className="update-bar-text">New features are available.</span>
            <button className="primary" onClick={() => location.reload()}>Reload</button>
            <button className="icon reply-x" title="Hide until the next update" aria-label="Hide"
              onClick={() => setDismissedVersion(newVersion)}>×</button>
          </div>
        )}
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
            onName={onName}
            blocked={blocked}
            onUnblock={(id) => void chat.unblock(id).catch((err) => view.notice(err instanceof Error ? err.message : String(err)))}
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
          categories={categories}
          categoryId={dialog.categoryId}
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
      {dialog?.k === "category" && (
        <CategoryDialog call={call} kind={dialog.kind}
          category={dialog.id ? categories.find((c) => c.id === dialog.id) : undefined}
          channels={dialog.id ? channels.filter((c) => c.category_id === dialog.id) : undefined}
          onClose={() => setDialog(null)} />
      )}
      {dialog?.k === "deleteCategory" && (() => {
        const cat = categories.find((c) => c.id === dialog.id);
        return cat && <DeleteCategoryDialog call={call} category={cat} onClose={() => setDialog(null)} />;
      })()}
      {layoutMenu && (layoutMenuCat || !layoutMenu.catId) && (
        <ChannelMenu title={layoutMenuCat ? layoutMenuCat.name : layoutMenu.kind === "text" ? "Text channels" : "Voice channels"}
          at={layoutMenu.at} items={layoutMenuItems()} onClose={() => setLayoutMenu(null)} />
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
          move={canMove && vsnap?.channelId ? { from: vsnap.channelId, channels: voiceChannels } : undefined}
          message={{ disabled: !canDM, onClick: () => messageFrom({ id: person.p.id, username: person.p.name }, person.at) }}
          onProfile={() => setNameMenu({ user: { id: person.p.id, username: person.p.name }, at: person.at })}
          onClose={() => setPerson(null)} />
      )}
      {dropNote && <MenuNote {...dropNote} onClose={() => setDropNote(null)} />}
      {moveAsk && <MoveChannelDialog channel={moveAsk.channel} from={moveAsk.from} to={moveAsk.to} onPick={moveAsk.answer} />}
      {moveMenu && (
        <MoveMenu person={moveMenu.p} from={moveMenu.from} channels={voiceChannels}
          at={moveMenu.at} call={call}
          message={{ disabled: !canDM, onClick: () => messageFrom({ id: moveMenu.p.user_id, username: moveMenu.p.username }, moveMenu.at) }}
          onProfile={() => setNameMenu({ user: { id: moveMenu.p.user_id, username: moveMenu.p.username }, at: moveMenu.at })}
          onClose={() => setMoveMenu(null)} />
      )}
      {layoutDrag.ghost && (
        <div className="drag-ghost" style={{ left: layoutDrag.ghost.x, top: layoutDrag.ghost.y }} aria-hidden>
          {layoutDrag.ghost.label}
        </div>
      )}
      {catPicker && pickerChannel && (pickerChannel.kind === "text" || pickerChannel.kind === "voice") && (
        <ChannelMenu title={`Move ${pickerChannel.kind === "text" ? "#" : ""}${pickerChannel.name} to`} at={catPicker.at}
          items={[
            { label: "No Category", disabled: !pickerChannel.category_id, reason: "It's already here",
              onClick: () => void layoutDrag.moveChannel(pickerChannel.id, null, null, catPicker.at) },
            ...categories.filter((g) => g.kind === pickerChannel.kind).map((g): MenuItem => ({
              label: g.name, disabled: g.id === pickerChannel.category_id, reason: "It's already here",
              onClick: () => void layoutDrag.moveChannel(pickerChannel.id, g.id, null, catPicker.at),
            })),
          ]}
          onClose={() => setCatPicker(null)} />
      )}
      {dmTabMenu && (
        <ChannelMenu title="Direct Messages" at={dmTabMenu}
          items={[markReadItem("Mark All as Read", dms.map((d) => d.channel_id))]} onClose={() => setDmTabMenu(null)} />
      )}
      {chanMenu && menuChannel && (
        <ChannelMenu title={`${menuChannel.kind === "text" ? "#" : menuChannel.kind === "dm" ? "@" : ""}${menuChannel.name}`} at={chanMenu.at}
          items={menuItems(menuChannel)} onClose={() => setChanMenu(null)} />
      )}
      {nameMenu && (
        <ProfileCard userId={nameMenu.user.id} username={nameMenu.user.username} at={nameMenu.at} call={call}
          items={(p) => nameMenu.user.id === session.user_id
            ? ["sep", { label: "Set Status", onClick: () => setDialog({ k: "status" }) },
              { label: "Edit Profile", onClick: () => setDialog({ k: "prefs", tab: "profile" }) }]
            : ["sep", { label: "Message", disabled: !canDM, reason: NO_DM_REASON,
              onClick: () => messageFrom(nameMenu.user, nameMenu.at) },
              blockItem(nameMenu.user, nameMenu.at),
              ...(canDeleteAny ? ["sep" as const, {
                label: "Remove Avatar", danger: true, disabled: !nameMenuHasAvatar, reason: "No avatar to remove",
                onClick: () => removeAvatar(nameMenu.user, nameMenu.at) }, {
                label: "Clear Bio", danger: true, disabled: !p?.bio, reason: "No bio to clear",
                onClick: () => clearBio(nameMenu.user, nameMenu.at) }, {
                label: "Clear Status", danger: true, disabled: !nameMenuHasStatus, reason: "No status to clear",
                onClick: () => clearStatus(nameMenu.user, nameMenu.at) }] : [])]}
          onClose={closeNameMenu} />
      )}
      {dialog?.k === "status" && (
        <SetStatusDialog call={call} userId={session.user_id} onClose={() => setDialog(null)} />
      )}
      {dialog?.k === "newdm" && (
        <NewMessageDialog call={call} onClose={() => setDialog(null)}
          onPick={async (id) => {
            const err = await openDM(id);
            if (!err) setDialog(null);
            return err;
          }} />
      )}
      {dialogChannel && (
        <ChannelSettingsDialog
          key={dialogChannel.id}
          focus={dialog?.k === "settings" ? dialog.focus : undefined}
          call={call}
          channel={dialogChannel}
          categories={categories}
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

function UserPanel({ session, backup, notice, busy, onLogout, onBackUpNow, onSetUpKey, onEnterKey, onSettings, onStatus }: {
  session: Session;
  backup: BackupStatus | null;
  notice: string | null;
  busy: string | null;
  onLogout: () => void;
  onBackUpNow: () => void;
  onSetUpKey: () => void;
  onEnterKey: () => void;
  onSettings: () => void;
  onStatus: () => void;
}) {
  const hasStatus = useStatus(session.user_id) !== undefined;
  return (
    <div className="user-panel">
      <div className="who">
        <strong>{session.username}</strong>
        {hasStatus && (
          <button className="link status-button" onClick={onStatus} title="Set Status">
            <StatusLine userId={session.user_id} />
          </button>
        )}
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
