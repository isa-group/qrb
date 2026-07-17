"use client";

import { syntaxHighlighting } from "@codemirror/language";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EXAMPLE_CIRCUITS } from "@/lib/playground/example-circuits";
import {
  qasmHighlightStyle,
  qasmLanguage,
} from "@/lib/playground/qasm-language";

// Matches the app's own palette via CSS custom properties (see
// qasm-language.ts) rather than importing an unrelated editor theme package
// — light/dark follows the active theme automatically.
const qasmEditorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--color-deep-well)",
    color: "var(--color-ink-primary)",
    fontSize: "var(--text-mono-body)",
  },
  ".cm-content": {
    caretColor: "var(--color-primary)",
    color: "var(--color-ink-primary)",
    fontFamily: "var(--font-geist-mono)",
    padding: "12px 0",
  },
  ".cm-line": { color: "var(--color-ink-primary)" },
  ".cm-gutters": {
    backgroundColor: "var(--color-deep-well)",
    color: "var(--color-ink-faint)",
    border: "none",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionBackground": { backgroundColor: "var(--color-primary-dim) !important" },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--color-primary-dim)",
    color: "var(--color-primary-bright) !important",
    outline: "none",
  },
});

const extensions = [
  qasmLanguage,
  syntaxHighlighting(qasmHighlightStyle),
  qasmEditorTheme,
  EditorView.lineWrapping,
];

export function CircuitEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-body text-ink-secondary">Circuit (OpenQASM 3)</span>
        <Select
          onValueChange={(id) => {
            const example = EXAMPLE_CIRCUITS.find((c) => c.id === id);
            if (example) onChange(example.qasm);
          }}
        >
          <SelectTrigger className="h-8 w-[180px] text-caption">
            <SelectValue placeholder="Load an example…" />
          </SelectTrigger>
          <SelectContent>
            {EXAMPLE_CIRCUITS.map((example) => (
              <SelectItem key={example.id} value={example.id}>
                {example.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="overflow-hidden rounded-md border border-hairline">
        <CodeMirror
          value={value}
          onChange={onChange}
          theme="none"
          extensions={extensions}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
          }}
          height="220px"
        />
      </div>
    </div>
  );
}
