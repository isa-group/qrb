import { Fragment, type ReactNode } from "react";

/**
 * A small, dependency-free syntax highlighter for the three languages the site shows: JSON (API
 * requests and responses), OpenQASM 3 (circuits) and shell (the curl calls, including the JSON in
 * their heredoc). It returns spans with `tok-*` classes; the colours live in globals.css.
 */
export type Lang = "json" | "qasm" | "shell";

type Tok = [cls: string | null, text: string];

const JSON_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|(…)|([{}[\],:])/g;

function json(src: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  for (const m of src.matchAll(JSON_RE)) {
    if (m.index! > last) out.push([null, src.slice(last, m.index)]);
    if (m[1]) {
      out.push([m[2] ? "tok-key" : "tok-string", m[1]]);
      if (m[2]) out.push(["tok-punct", m[2]]);
    } else if (m[3]) out.push(["tok-number", m[3]]);
    else if (m[4]) out.push(["tok-keyword", m[4]]);
    else if (m[5]) out.push(["tok-comment", m[5]]);
    else out.push(["tok-punct", m[6]]);
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push([null, src.slice(last)]);
  return out;
}

const QASM_KEYWORDS = new Set([
  "OPENQASM",
  "include",
  "qubit",
  "bit",
  "qreg",
  "creg",
  "measure",
  "reset",
  "barrier",
  "gate",
  "def",
  "if",
  "else",
  "for",
  "while",
  "in",
  "let",
  "const",
  "input",
  "output",
  "return",
  "ctrl",
  "inv",
  "pow",
  "box",
  "delay",
]);
const QASM_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("[^"\n]*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([[\]{}();,=@-]|->)/g;

function qasm(src: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  let lineStart = true; // the first identifier of a statement is the gate or keyword
  for (const m of src.matchAll(QASM_RE)) {
    const gap = src.slice(last, m.index);
    if (gap) {
      out.push([null, gap]);
      if (gap.includes("\n")) lineStart = true;
    }
    if (m[1]) out.push(["tok-comment", m[1]]);
    else if (m[2]) out.push(["tok-string", m[2]]);
    else if (m[3]) out.push(["tok-number", m[3]]);
    else if (m[4]) {
      const w = m[4];
      out.push([
        QASM_KEYWORDS.has(w) ? "tok-keyword" : lineStart ? "tok-fn" : null,
        w,
      ]);
      lineStart = false;
    } else {
      out.push(["tok-punct", m[5]]);
      if (m[5] === ";" || m[5] === "{" || m[5] === "}") lineStart = true;
    }
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push([null, src.slice(last)]);
  return out;
}

const SHELL_RE =
  /(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^'\n]*')|(\s--?[A-Za-z][\w-]*)|(\$\{[^}]*\}|\$[A-Za-z_]\w*)|(<<|\\$|&&|\|)/gm;

function shell(src: string): Tok[] {
  // The heredoc body is JSON: highlight it as JSON between `<<'X'` and the closing `X`.
  const here = src.match(/<<'?(\w+)'?\n([\s\S]*?)\n\1\s*$/);
  if (here) {
    const start = here.index! + here[0].indexOf("\n") + 1;
    const end = start + here[2].length;
    return [
      ...shellLine(src.slice(0, start)),
      ...json(src.slice(start, end)),
      ...shellLine(src.slice(end)),
    ];
  }
  return shellLine(src);
}
function shellLine(src: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  let first = true;
  for (const m of src.matchAll(SHELL_RE)) {
    const gap = src.slice(last, m.index);
    if (gap) pushWords(out, gap, first) && (first = false);
    if (m[1]) out.push(["tok-comment", m[1]]);
    else if (m[2]) out.push(["tok-string", m[2]]);
    else if (m[3]) out.push(["tok-keyword", m[3]]);
    else if (m[4]) out.push(["tok-number", m[4]]);
    else out.push(["tok-punct", m[5]]);
    if (m[5] === "&&" || m[5] === "|") first = true;
    last = m.index! + m[0].length;
  }
  if (last < src.length) pushWords(out, src.slice(last), first);
  return out;
}
/** Plain text; the first word of a command (curl, git, task…) is marked as the command. */
function pushWords(out: Tok[], text: string, first: boolean): boolean {
  if (!first) {
    out.push([null, text]);
    return false;
  }
  const m = text.match(/^(\s*)([A-Za-z][\w.-]*)/);
  if (!m) {
    out.push([null, text]);
    return false;
  }
  if (m[1]) out.push([null, m[1]]);
  out.push(["tok-fn", m[2]]);
  if (text.length > m[0].length) out.push([null, text.slice(m[0].length)]);
  return true;
}

export function highlight(code: string, lang: Lang): ReactNode {
  const toks =
    lang === "json" ? json(code) : lang === "qasm" ? qasm(code) : shell(code);
  return toks.map(([cls, text], i) =>
    cls ? (
      <span key={i} className={cls}>
        {text}
      </span>
    ) : (
      <Fragment key={i}>{text}</Fragment>
    ),
  );
}
