// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Syntax colouring for fenced code blocks ("```go"). Loaded lazily by
 * markdown.tsx the first time a block with a language is drawn, so the
 * grammars stay out of the main bundle.
 *
 * lowlight runs highlight.js's grammars but returns a syntax tree rather
 * than HTML, so markdown.tsx builds React elements from it: a message
 * body is untrusted and never becomes HTML (decisions.md, "Markdown
 * escapes before formatting, never after").
 *
 * The languages: lowlight's "common" set without arduino, vbnet and wasm,
 * plus dockerfile, nginx and powershell (self-hosters paste those).
 */

import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import phpTemplate from "highlight.js/lib/languages/php-template";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import pythonRepl from "highlight.js/lib/languages/python-repl";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const lowlight = createLowlight({
  bash, c, cpp, csharp, css, diff, dockerfile, go, graphql, ini, java,
  javascript, json, kotlin, less, lua, makefile, markdown, nginx,
  objectivec, perl, php, "php-template": phpTemplate, plaintext, powershell,
  python, "python-repl": pythonRepl, r, ruby, rust, scss, shell, sql,
  swift, typescript, xml, yaml,
});

/** The parts of lowlight's tree we draw: text, and spans with classes. */
export type CodeNode =
  | { type: "text"; value: string }
  | { type: "element"; properties?: { className?: unknown }; children: CodeNode[] };

/** The coloured tree for some code, or null for a language we don't have
 * (aliases count: "js", "sh", "yml", "html", "toml"…). */
export function highlight(code: string, lang: string): CodeNode[] | null {
  const name = lang.toLowerCase();
  if (!lowlight.registered(name)) return null;
  try {
    return lowlight.highlight(name, code).children as CodeNode[];
  } catch {
    return null;
  }
}
