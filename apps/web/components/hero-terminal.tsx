"use client";

import { useTypewriter } from "@/hooks/use-typewriter";

const COMMAND = "qrb select ghz3.qasm --preset fidelity-first";

const OUTPUT_LINES = [
  "feasibility: FEASIBLE",
  "binding: {'task': 'ibm.ibm_kyoto'}",
  "  objective_value: 0.912",
  "  features: {'expected_fidelity': 0.994, 'cost': 0.42, 'queue': 3}",
];

// Illustrative only — mirrors the real CLI's actual output shape (see
// apps/cli/src/qrb_cli/main.py:select_command's typer.echo calls) but
// is fully static, no live resolve. The hero shouldn't trigger a real
// solve just to render itself.
export function HeroTerminal({ onDone }: { onDone?: () => void }) {
  const { typed, done } = useTypewriter(COMMAND, 35);

  return (
    <div className="rounded-lg border border-hairline bg-instrument p-4 font-geist-mono text-mono-body">
      <div className="flex items-center gap-1.5 pb-3">
        <span className="size-2.5 rounded-full bg-ink-faint/40" />
        <span className="size-2.5 rounded-full bg-ink-faint/40" />
        <span className="size-2.5 rounded-full bg-ink-faint/40" />
      </div>
      <div className="text-ink-primary">
        <span className="text-ink-tertiary">$ </span>
        {typed}
        {!done && (
          <span className="ml-px inline-block h-[1em] w-[0.5ch] translate-y-[0.15em] animate-pulse bg-ink-primary align-middle" />
        )}
      </div>
      {done && (
        <RevealLines onRevealed={onDone} />
      )}
    </div>
  );
}

function RevealLines({ onRevealed }: { onRevealed?: () => void }) {
  return (
    <div className="mt-2 flex flex-col gap-0.5 text-ink-secondary">
      {OUTPUT_LINES.map((line, i) => (
        <span
          key={i}
          className="animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards duration-300"
          style={{ animationDelay: `${i * 150}ms` }}
          onAnimationEnd={
            i === OUTPUT_LINES.length - 1 ? onRevealed : undefined
          }
        >
          {line}
        </span>
      ))}
    </div>
  );
}
