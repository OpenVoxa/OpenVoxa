// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The small Markdown subset chat uses: **bold**, *italic* / _italic_,
 * ~~strike~~, `inline code`, ```fenced code``` (with an optional language,
 * "```go", which labels and colours it), "> " quotes, links, and
 * @mentions (only names the server accepted for that message).
 *
 * Built as React elements, never as an HTML string, so a user's angle
 * bracket can only ever be text.
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { matchMember, MENTION_RE, type Mention } from "@core/chat";
import { useNameColour } from "./names";
import type { CodeNode } from "./codeHighlight";

/** Who a message mentions, and who is reading. */
interface MentionCtx {
  readonly mentions: readonly Mention[];
  readonly me: string;
}

/** http(s) links, without trailing punctuation. */
export const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}*_~]/g;

/** The first link in some text, for a preview. Code is skipped. */
export function firstLink(text: string): string | null {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]+`/g, " ");
  return plain.match(URL_RE)?.[0] ?? null;
}

export function Markdown({ text, mentions, me }: {
  text: string;
  mentions?: readonly Mention[];
  /** Your user ID, to tell your own mentions apart. */
  me?: string;
}) {
  const ctx: MentionCtx | null = mentions?.length ? { mentions, me: me ?? "" } : null;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/```([\s\S]*?)```/g)) {
    const i = m.index ?? 0;
    if (i > last) out.push(...blocks(trimEnds(text.slice(last, i), last > 0, true), `b${i}`, ctx));
    // A language tag on the opening line ("```js") labels the block.
    const tag = /^([\w+#.-]{0,20})\n/.exec(m[1]);
    const code = (tag ? m[1].slice(tag[0].length) : m[1]).replace(/\n$/, "");
    out.push(<CodeBlock key={`c${i}`} code={code} lang={tag?.[1] ?? ""} />);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(...blocks(trimEnds(text.slice(last), last > 0, false), "tail", ctx));
  return <span className="text md">{out}</span>;
}

// ---------------------------------------------------------- code blocks

type Highlighter = typeof import("./codeHighlight");
let highlighter: Highlighter | null = null;
let loadingHighlighter: Promise<Highlighter> | null = null;

/** The highlighter, loaded once on first use (its own chunk). */
function loadHighlighter(): Promise<Highlighter> {
  loadingHighlighter ??= import("./codeHighlight").then((h) => (highlighter = h));
  return loadingHighlighter;
}

/** A fenced block: its language (if given) and a Copy button on a bar
 * above, the code coloured when the language is one we know. */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [hl, setHl] = useState(highlighter);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (lang && !hl) void loadHighlighter().then(setHl, () => {});
  }, [lang, hl]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const tree = lang && hl ? hl.highlight(code, lang) : null;
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang}</span>
        <button className="secondary code-copy" onClick={() => {
          navigator.clipboard.writeText(code).then(() => setCopied("Copied"), () => setCopied("Couldn't copy"));
        }}>{copied ?? "Copy"}</button>
      </div>
      <pre><code>{tree ? codeNodes(tree, "h") : code}</code></pre>
    </div>
  );
}

/** lowlight's tree as React elements: text stays text, and the only
 * markup is a span with highlight.js's class names ("hljs-keyword"). */
function codeNodes(nodes: readonly CodeNode[], key: string): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === "text") return n.value;
    const cls = n.properties?.className;
    const className = Array.isArray(cls) ? cls.filter((c) => typeof c === "string").join(" ") : undefined;
    return <span key={`${key}.${i}`} className={className}>{codeNodes(n.children ?? [], `${key}.${i}`)}</span>;
  });
}

/** Drop the line break next to a block element: the body is pre-wrap,
 * so it would show as an extra blank line. */
function trimEnds(s: string, afterBlock: boolean, beforeBlock: boolean): string {
  if (afterBlock) s = s.replace(/^\n/, "");
  if (beforeBlock) s = s.replace(/\n$/, "");
  return s;
}

/** Quotes ("> " lines) as blocks; everything else inline. */
function blocks(s: string, key: string, ctx: MentionCtx | null): ReactNode[] {
  if (!s) return [];
  const lines = s.split("\n");
  const out: ReactNode[] = [];
  let run: string[] = [];
  let quote = false;
  // Splitting on "\n" already drops the line break between a run and a
  // quote, so neither side needs trimming.
  const flush = () => {
    if (!run.length) return;
    const k = `${key}.${out.length}`;
    const body = inline(run.join("\n"), k, ctx);
    out.push(quote ? <blockquote key={k}>{body}</blockquote> : <Fragment key={k}>{body}</Fragment>);
    run = [];
  };
  for (const line of lines) {
    const q = /^>\s?/.test(line);
    if (q !== quote) {
      flush();
      quote = q;
    }
    run.push(q ? line.replace(/^>\s?/, "") : line);
  }
  flush();
  return out;
}

// Earliest match wins. Links come first in the alternation so markup
// characters inside a URL are left alone.
const INLINE_RE = new RegExp(
  [
    /`([^`\n]+)`/.source,                          // 1 code
    URL_RE.source,                                  // (whole match) link
    /\*\*(.+?)\*\*/.source,                         // 2 bold
    /~~(.+?)~~/.source,                             // 3 strike
    /(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/.source, // 4 italic
    /(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/.source,   // 5 italic
    MENTION_RE.source,                              // 6 mention
  ].join("|"),
  "g",
);

function inline(s: string, key: string, ctx: MentionCtx | null): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(s.slice(last, i));
    const k = `${key}:${i}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], k, ctx)}</strong>);
    else if (m[3] !== undefined) out.push(<del key={k}>{inline(m[3], k, ctx)}</del>);
    else if (m[4] !== undefined) out.push(<em key={k}>{inline(m[4], k, ctx)}</em>);
    else if (m[5] !== undefined) out.push(<em key={k}>{inline(m[5], k, ctx)}</em>);
    else if (m[6] !== undefined) {
      // A name the server didn't accept (nobody by that name can see the
      // channel) stays plain text, so it can't look like a real mention.
      const who = ctx ? matchMember(m[6], ctx.mentions) : undefined;
      out.push(who ? <MentionChip key={k} who={who} me={who.user_id === ctx!.me} /> : m[0]);
    }
    else out.push(<a key={k} href={m[0]} target="_blank" rel="noopener noreferrer nofollow">{m[0]}</a>);
    last = i + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** An @mention, in the person's name colour (names.tsx). */
function MentionChip({ who, me }: { who: { user_id: string; username: string }; me: boolean }) {
  const colour = useNameColour(who.user_id);
  return (
    <span className={`mention${me ? " me" : ""}`} style={colour ? { color: colour } : undefined}
      title={me ? "Mentions you" : undefined}>@{who.username}</span>
  );
}
