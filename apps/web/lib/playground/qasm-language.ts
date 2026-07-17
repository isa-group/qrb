// Minimal OpenQASM3 syntax highlighting for the circuit editor — no
// maintained CodeMirror or Monaco package exists for this language, so this
// is a hand-rolled StreamLanguage tokenizer (keywords/types/gates/comments/
// numbers/strings), not a full grammar. Scoped exception to this app's
// otherwise no-syntax-highlighting rule (see components/code-block.tsx) —
// this is the one control that's genuinely about editing, not reading.
import { HighlightStyle, StreamLanguage, type StreamParser } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

interface QasmState {
  inBlockComment: boolean;
}

const KEYWORDS = new Set([
  "OPENQASM",
  "include",
  "gate",
  "def",
  "if",
  "else",
  "for",
  "while",
  "in",
  "return",
  "const",
  "let",
  "input",
  "output",
  "extern",
  "defcalgrammar",
  "defcal",
  "box",
  "barrier",
  "reset",
  "measure",
  "pragma",
  "cal",
  "break",
  "continue",
  "end",
  "gphase",
]);

const TYPES = new Set([
  "int",
  "uint",
  "float",
  "angle",
  "bool",
  "complex",
  "array",
  "duration",
  "stretch",
  "qubit",
  "bit",
  "creg",
  "qreg",
]);

const GATES = new Set([
  "h",
  "x",
  "y",
  "z",
  "s",
  "sdg",
  "t",
  "tdg",
  "sx",
  "sxdg",
  "rx",
  "ry",
  "rz",
  "u",
  "u1",
  "u2",
  "u3",
  "cx",
  "cy",
  "cz",
  "ch",
  "swap",
  "ccx",
  "cswap",
  "crx",
  "cry",
  "crz",
  "cu",
  "cu1",
  "cu3",
  "id",
  "p",
  "rxx",
  "ryy",
  "rzz",
  "ecr",
  "iswap",
]);

// Explicit, not relying on @codemirror/language's built-in legacy-mode
// defaults — this is the one control in the app with real syntax
// highlighting, so token->tag mapping is spelled out rather than guessed.
const tokenTable = {
  keyword: t.keyword,
  gateName: t.atom,
  typeName: t.typeName,
  variableName: t.variableName,
  number: t.number,
  string: t.string,
  comment: t.comment,
  operator: t.operator,
  bracket: t.bracket,
  separator: t.separator,
};

const qasmStreamParser: StreamParser<QasmState> = {
  name: "qasm3",
  tokenTable,

  startState: () => ({ inBlockComment: false }),

  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match(/^[\s\S]*?\*\//)) {
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }

    if (stream.eatSpace()) return null;

    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match('"')) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '"') break;
      }
      return "string";
    }
    if (stream.match(/^[0-9]+(\.[0-9]+)?(ns|us|µs|ms|s|dt)?/)) {
      return "number";
    }
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      if (KEYWORDS.has(word)) return "keyword";
      if (TYPES.has(word)) return "typeName";
      if (GATES.has(word)) return "gateName";
      return "variableName";
    }
    if (stream.match(/^[{}()[\]]/)) return "bracket";
    if (stream.match(/^[;,]/)) return "separator";
    if (stream.match(/^[-+*/^=<>!&|~%.]+/)) return "operator";

    stream.next();
    return null;
  },
};

export const qasmLanguage = StreamLanguage.define(qasmStreamParser);

// Deliberate visual hierarchy within the app's one accent hue + neutral
// scale (no rainbow of token colors): gate calls are the brightest/boldest
// thing on screen since they're what a circuit reader scans for first,
// then keywords, then identifiers (the qubit/bit names actually being
// operated on), then literals, then the structural stuff (types, brackets,
// operators) fades toward the background, comments faintest of all.
export const qasmHighlightStyle = HighlightStyle.define([
  { tag: t.atom, color: "var(--color-primary-bright)", fontWeight: 600 },
  { tag: t.keyword, color: "var(--color-primary)", fontWeight: 500 },
  { tag: t.variableName, color: "var(--color-ink-primary)" },
  { tag: t.number, color: "var(--color-ink-secondary)" },
  { tag: t.string, color: "var(--color-ink-secondary)" },
  { tag: t.typeName, color: "var(--color-ink-tertiary)", fontStyle: "italic" },
  { tag: t.bracket, color: "var(--color-ink-tertiary)" },
  { tag: t.separator, color: "var(--color-ink-faint)" },
  { tag: t.operator, color: "var(--color-ink-tertiary)" },
  { tag: t.comment, color: "var(--color-ink-faint)", fontStyle: "italic" },
]);
