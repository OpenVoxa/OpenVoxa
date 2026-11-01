// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The small Markdown subset chat uses: **bold**, *italic* / _italic_,
 * ~~strike~~, `inline code`, ```fenced code```, "> " quotes, and links.
 *
 * Built as React elements, never as an HTML string, so a user's angle
 * bracket can only ever be text. Same subset as the debug page.
 */

import { Fragment, type ReactNode } from "react";

/** http(s) links, without trailing punctuation. */
export const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}*_~]/g;

/** The first link in some text, for a preview. Code is skipped. */
export function firstLink(text: string): string | null {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]+`/g, " ");
  return plain.match(URL_RE)?.[0] ?? null;
}

export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/```([\s\S]*?)```/g)) {
    const i = m.index ?? 0;
    if (i > last) out.push(...blocks(trimEnds(text.slice(last, i), last > 0, true), `b${i}`));
    // A language tag on the opening line ("```js") is dropped.
    const code = m[1].replace(/^[\w+-]*\n/, "").replace(/\n$/, "");
    out.push(<pre key={`c${i}`}><code>{code}</code></pre>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(...blocks(trimEnds(text.slice(last), last > 0, false), "tail"));
  return <span className="text md">{out}</span>;
}

/** Drop the line break next to a block element: the body is pre-wrap,
 * so it would show as an extra blank line. */
function trimEnds(s: string, afterBlock: boolean, beforeBlock: boolean): string {
  if (afterBlock) s = s.replace(/^\n/, "");
  if (beforeBlock) s = s.replace(/\n$/, "");
  return s;
}

/** Quotes ("> " lines) as blocks; everything else inline. */
function blocks(s: string, key: string): ReactNode[] {
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
    const body = inline(run.join("\n"), k);
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
  ].join("|"),
  "g",
);

function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(s.slice(last, i));
    const k = `${key}:${i}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else if (m[3] !== undefined) out.push(<del key={k}>{inline(m[3], k)}</del>);
    else if (m[4] !== undefined) out.push(<em key={k}>{inline(m[4], k)}</em>);
    else if (m[5] !== undefined) out.push(<em key={k}>{inline(m[5], k)}</em>);
    else out.push(<a key={k} href={m[0]} target="_blank" rel="noopener noreferrer nofollow">{m[0]}</a>);
    last = i + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
