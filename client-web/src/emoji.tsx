// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Emoji: the picker beside the composer and the ":name:" autocomplete.
 *
 * Emoji are plain Unicode text, so they need nothing from the server and
 * work in encrypted channels unchanged. They are drawn with the device's
 * own emoji font (Ryan's call, 2026-11-04): no image set is shipped, so
 * they look native on each system.
 *
 * The names, keywords and shortcodes come from emojibase-data (MIT),
 * bundled with the client and loaded only the first time the picker opens
 * or someone types ":" plus two letters. No CDN, for the same reason as
 * LiveKit. Shortcodes are GitHub's set (":+1:", ":smile:", ...), which is
 * what most people already know.
 *
 * Emoji newer than the device's font are hidden (see maxSupportedVersion),
 * so the picker never offers an empty box.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { localStore } from "./core";

export interface Emoji {
  /** The emoji itself, default (yellow) skin. */
  char: string;
  hexcode: string;
  name: string;
  /** Shortcodes without colons; the first is the one shown. */
  codes: string[];
  tags: string[];
  group: number;
  /** The five single skin-tone variants, light to dark, if it has them. */
  skins?: string[];
}

export interface EmojiData {
  list: Emoji[];
  byCode: Map<string, Emoji>;
  byHex: Map<string, Emoji>;
}

interface RawEmoji {
  hexcode: string;
  emoji: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
  version: number;
  skins?: { hexcode: string; emoji: string; tone?: number | number[] }[];
}

/** Picker tabs, in emojibase group order (group 2, "components", is skipped). */
export const GROUPS: { group: number; label: string; icon: string }[] = [
  { group: 0, label: "Smileys & emotion", icon: "😀" },
  { group: 1, label: "People & body", icon: "👋" },
  { group: 3, label: "Animals & nature", icon: "🐻" },
  { group: 4, label: "Food & drink", icon: "🍔" },
  { group: 5, label: "Travel & places", icon: "🚗" },
  { group: 6, label: "Activities", icon: "⚽" },
  { group: 7, label: "Objects", icon: "💡" },
  { group: 8, label: "Symbols", icon: "🔣" },
  { group: 9, label: "Flags", icon: "🏁" },
];

const EMOJI_FONTS = `"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif`;

let loading: Promise<EmojiData> | null = null;

/** The emoji data, fetched once per page load (its own ~100 KB chunk). */
export function loadEmoji(): Promise<EmojiData> {
  loading ??= Promise.all([
    import("emojibase-data/en/data.json"),
    import("emojibase-data/en/shortcodes/github.json"),
  ]).then(([d, s]) => build(d.default as unknown as RawEmoji[], s.default as unknown as Record<string, string | string[]>))
    .catch((err) => {
      loading = null; // try again next time
      throw err;
    });
  return loading;
}

function build(raw: RawEmoji[], shortcodes: Record<string, string | string[]>): EmojiData {
  const max = maxSupportedVersion(raw);
  const list: Emoji[] = [];
  for (const r of raw
    .filter((r) => r.group !== undefined && r.group !== 2 && r.version <= max)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const sc = shortcodes[r.hexcode];
    const codes = sc === undefined ? [slug(r.label)] : typeof sc === "string" ? [sc] : sc;
    const skins = r.skins?.filter((s) => typeof s.tone === "number")
      .sort((a, b) => (a.tone as number) - (b.tone as number)).map((s) => s.emoji);
    list.push({
      char: r.emoji,
      hexcode: r.hexcode,
      name: r.label,
      codes,
      tags: r.tags ?? [],
      group: r.group!,
      skins: skins?.length === 5 ? skins : undefined,
    });
  }
  const byCode = new Map<string, Emoji>();
  const byHex = new Map<string, Emoji>();
  for (const e of list) {
    byHex.set(e.hexcode, e);
    for (const c of e.codes) if (!byCode.has(c)) byCode.set(c, e);
  }
  return { list, byCode, byHex };
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9+]+/g, "_").replace(/^_|_$/g, "");
}

/**
 * The newest emoji version this device's font draws. Each version from
 * Emoji 11 up gets one test emoji drawn on a canvas: a colour emoji font
 * paints colour, a missing glyph paints a grey box. If even an old emoji
 * fails (no colour font at all, or the canvas is blocked) nothing is
 * hidden, since the test can't tell.
 */
function maxSupportedVersion(raw: RawEmoji[]): number {
  const test = makeTester();
  if (!test) return Infinity;
  const sample = (v: number) => raw.find((r) => r.version === v && !r.hexcode.includes("200D"))?.emoji;
  const old = sample(1);
  if (!old || !test(old)) return Infinity;
  const versions = [...new Set(raw.map((r) => r.version))].filter((v) => v >= 11).sort((a, b) => a - b);
  let max = 5;
  for (const v of versions) {
    const s = sample(v);
    if (s && !test(s)) break;
    max = v;
  }
  return max;
}

function makeTester(): ((s: string) => boolean) | null {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 24;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.font = `18px ${EMOJI_FONTS}`;
    g.textBaseline = "top";
    return (s) => {
      g.clearRect(0, 0, 24, 24);
      g.fillStyle = "#000";
      g.fillText(s, 0, 2);
      const px = g.getImageData(0, 0, 24, 24).data;
      for (let i = 0; i < px.length; i += 4) {
        const [r, gr, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
        if (a > 0 && (Math.abs(r - gr) > 20 || Math.abs(gr - b) > 20)) return true;
      }
      return false;
    };
  } catch {
    return null;
  }
}

/** Load the data when `want` turns true; null until it's there. */
export function useEmojiData(want: boolean): EmojiData | null {
  const [data, setData] = useState<EmojiData | null>(null);
  useEffect(() => {
    if (!want || data) return;
    let live = true;
    loadEmoji().then((d) => live && setData(d)).catch(() => {});
    return () => {
      live = false;
    };
  }, [want, data]);
  return data;
}

/** Best matches first: shortcode prefix, then name words, then keywords. */
export function searchEmoji(data: EmojiData, query: string, limit = Infinity): Emoji[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, "");
  if (!q) return [];
  const ranked: [number, Emoji][] = [];
  for (const e of data.list) {
    let score = -1;
    if (e.codes.some((c) => c === q)) score = 0;
    else if (e.codes.some((c) => c.startsWith(q))) score = 1;
    else if (e.name.split(/[\s:-]+/).some((w) => w.startsWith(q))) score = 2;
    else if (e.tags.some((t) => t.startsWith(q))) score = 3;
    else if (q.length > 2 && e.name.includes(q)) score = 4;
    if (score >= 0) ranked.push([score, e]);
  }
  // Array.sort is stable, so equal scores keep the picker's own order.
  return ranked.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, e]) => e);
}

// ------------------------------------------------- per-browser memory

const TONE_KEY = "emoji.tone";
const RECENT_KEY = "emoji.recent";
const MAX_RECENT = 24;
/** Shown on the skin tone button: default, then light to dark. */
const TONE_SWATCH = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

/** 0 = default yellow, 1-5 = light to dark. */
function readTone(): number {
  const t = Number(localStore.get(TONE_KEY));
  return Number.isInteger(t) && t >= 0 && t <= 5 ? t : 0;
}

export function withTone(e: Emoji, tone: number): string {
  return tone > 0 && e.skins ? e.skins[tone - 1] : e.char;
}

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStore.get(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remember an emoji as recently used (by hexcode, so tone changes follow). */
export function noteRecent(e: Emoji): void {
  const next = [e.hexcode, ...readRecent().filter((h) => h !== e.hexcode)].slice(0, MAX_RECENT);
  localStore.set(RECENT_KEY, JSON.stringify(next));
}

// ------------------------------------------------------------- picker

/**
 * The emoji grid that opens from the composer's smiley button. Click to
 * insert and close; Shift+click inserts and keeps it open. Typing searches;
 * Enter takes the first result.
 */
export function EmojiPicker({ onPick, onClose }: {
  /** The emoji text to insert, with the chosen skin tone applied. */
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  const data = useEmojiData(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState(readTone);
  const [hover, setHover] = useState<Emoji | null>(null);
  const [recent] = useState(readRecent); // fixed while open, so the grid doesn't jump
  const box = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    let live = true;
    loadEmoji().catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, []);

  // Close on Escape or a click outside.
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    const click = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, [onClose]);

  const sections = useMemo(() => {
    if (!data) return [];
    if (query.trim()) return [{ key: "results", label: "Results", items: searchEmoji(data, query) }];
    const out: { key: string; label: string; items: Emoji[] }[] = [];
    const rec = recent.flatMap((h) => data.byHex.get(h) ?? []);
    if (rec.length) out.push({ key: "recent", label: "Recently used", items: rec });
    for (const g of GROUPS) {
      out.push({ key: `g${g.group}`, label: g.label, items: data.list.filter((e) => e.group === g.group) });
    }
    return out;
  }, [data, query, recent]);

  const choose = useCallback((e: Emoji, keepOpen: boolean) => {
    noteRecent(e);
    onPick(withTone(e, tone));
    if (!keepOpen) onClose();
  }, [onPick, onClose, tone]);

  function cycleTone() {
    const t = (tone + 1) % 6;
    setTone(t);
    localStore.set(TONE_KEY, String(t));
  }

  function jump(key: string) {
    setQuery("");
    requestAnimationFrame(() => {
      grid.current?.querySelector(`[data-section="${key}"]`)?.scrollIntoView({ block: "start" });
    });
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    const first = sections[0]?.items[0];
    if (e.key === "Enter" && first) {
      e.preventDefault();
      choose(first, e.shiftKey);
    }
  }

  const shown = hover ?? sections[0]?.items[0] ?? null;

  return (
    <div className="emoji-picker" ref={box} role="dialog" aria-label="Emoji">
      <div className="emoji-top">
        <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
          placeholder="Search emoji" aria-label="Search emoji" />
        <button className="secondary emoji-tone" onClick={cycleTone}
          title="Skin tone (click to change)" aria-label="Skin tone">{TONE_SWATCH[tone]}</button>
      </div>
      <div className="emoji-tabs" role="toolbar" aria-label="Emoji categories">
        {recent.length > 0 && (
          <button onClick={() => jump("recent")} title="Recently used" aria-label="Recently used">🕘</button>
        )}
        {GROUPS.map((g) => (
          <button key={g.group} onClick={() => jump(`g${g.group}`)} title={g.label} aria-label={g.label}>{g.icon}</button>
        ))}
      </div>
      <div className="emoji-grid" ref={grid}>
        {error && <p className="error small" role="alert">Couldn't load emoji. Close and try again.</p>}
        {!data && !error && <span className="muted small">Loading…</span>}
        {data && query.trim() && !sections[0]?.items.length && <span className="muted small">No emoji found.</span>}
        <EmojiSections sections={sections} tone={tone} onChoose={choose} onHover={setHover} />
      </div>
      <div className="emoji-foot">
        {shown ? (
          <>
            <span className="emoji-big">{withTone(shown, tone)}</span>
            <span className="emoji-name">{shown.name}</span>
            <span className="muted small">:{shown.codes[0]}:</span>
          </>
        ) : <span className="muted small">Shift+click to pick several</span>}
      </div>
    </div>
  );
}

/** The grid itself, memoised: hovering only re-renders the footer. */
const EmojiSections = memo(function EmojiSections({ sections, tone, onChoose, onHover }: {
  sections: { key: string; label: string; items: Emoji[] }[];
  tone: number;
  onChoose: (e: Emoji, keepOpen: boolean) => void;
  onHover: (e: Emoji | null) => void;
}) {
  return (
    <>
      {sections.map((s) => s.items.length > 0 && (
        <section key={s.key} data-section={s.key}>
          <h4>{s.label}</h4>
          <div className="emoji-cells">
            {s.items.map((e) => (
              <button key={e.hexcode} className="emoji-cell" title={`:${e.codes[0]}:`} aria-label={e.name}
                onClick={(ev) => onChoose(e, ev.shiftKey)} onMouseEnter={() => onHover(e)} onFocus={() => onHover(e)}>
                {withTone(e, tone)}
              </button>
            ))}
          </div>
        </section>
      ))}
    </>
  );
});

// ----------------------------------------------- ":name" autocomplete

/** ":" plus at least two characters of a shortcode, right before the caret. */
const CODE_TYPING = /(?:^|[\s(]):([a-z0-9_+-]{2,32})$/i;
/** A complete ":code:", right before the caret. */
const CODE_DONE = /(?:^|[\s(]):([a-z0-9_+-]{1,32}):$/i;
const MAX_SUGGESTIONS = 8;

/**
 * Shortcodes while typing: ":smi" opens a list (arrows move, Enter or Tab
 * picks, Escape closes), and typing a whole ":smile:" turns into 😄 on the
 * closing colon. Text that merely looks like a time (12:30) is left alone,
 * since the colon must follow a space, a bracket, or the start.
 */
export function useEmojiShortcodes(
  text: string,
  setText: (v: string) => void,
  ref: React.RefObject<HTMLTextAreaElement | null>,
) {
  const [query, setQuery] = useState<{ at: number; q: string } | null>(null);
  const [active, setActive] = useState(0);
  // Set on the keydown of a ":" so the following select event can finish
  // a complete code; caret moves alone never rewrite text.
  const typedColon = useRef(false);
  const data = useEmojiData(query !== null);

  const matches = query && data ? searchEmoji(data, query.q, MAX_SUGGESTIONS) : [];
  const open = matches.length > 0;

  /** Swap text[from, to) for `value`; `space` adds one after it, like @mentions. */
  const replace = (from: number, to: number, value: string, space: boolean) => {
    const current = ref.current?.value ?? text;
    const insert = space ? `${value} ` : value;
    const after = space ? current.slice(to).replace(/^ /, "") : current.slice(to);
    setText(current.slice(0, from) + insert + after);
    setQuery(null);
    const caret = from + insert.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const caret = el.selectionStart;
    const before = el.selectionEnd === caret ? el.value.slice(0, caret) : null;

    if (typedColon.current && before !== null) {
      typedColon.current = false;
      const done = CODE_DONE.exec(before);
      if (done) {
        void loadEmoji().then((d) => {
          const hit = d.byCode.get(done[1].toLowerCase());
          // Still the same text? (The user may have typed on meanwhile.)
          if (hit && ref.current?.value.slice(0, caret) === before) {
            noteRecent(hit);
            replace(caret - done[1].length - 2, caret, withTone(hit, readTone()), false);
          }
        }).catch(() => {});
        return;
      }
    }

    const m = before !== null ? CODE_TYPING.exec(before) : null;
    const next = m ? { at: caret - m[1].length - 1, q: m[1] } : null;
    if (next?.at !== query?.at || next?.q !== query?.q) {
      setQuery(next);
      setActive(0);
    }
  };

  const pick = (e: Emoji) => {
    if (!query) return;
    noteRecent(e);
    replace(query.at, query.at + 1 + query.q.length, withTone(e, readTone()), true);
  };

  /** Handle a key if the list is open; true if it was used. */
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    typedColon.current = e.key === ":";
    if (!open || e.nativeEvent.isComposing) return false;
    switch (e.key) {
      case "ArrowDown":
        setActive((i) => (i + 1) % matches.length);
        break;
      case "ArrowUp":
        setActive((i) => (i - 1 + matches.length) % matches.length);
        break;
      case "Enter":
      case "Tab":
        if (e.shiftKey) return false;
        pick(matches[Math.min(active, matches.length - 1)]);
        break;
      case "Escape":
        setQuery(null);
        break;
      default:
        return false;
    }
    e.preventDefault();
    return true;
  };

  const list = open ? (
    <ul className="mention-list emoji-list" role="listbox" aria-label="Emoji">
      {matches.map((m, i) => (
        <li key={m.hexcode} role="option" aria-selected={i === active}
          className={i === active ? "active" : undefined}
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus in the textarea
            pick(m);
          }}
          onMouseEnter={() => setActive(i)}>
          <span className="emoji-char">{withTone(m, readTone())}</span> :{m.codes[0]}:
        </li>
      ))}
    </ul>
  ) : null;

  return { list, onKey, onSelect };
}
