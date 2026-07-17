"use client";

import { useState } from "react";

import { HeroTerminal } from "@/components/hero-terminal";
import { HeroWinnerCard } from "@/components/hero-winner-card";

// One task, two interfaces: the CLI "runs" (typed once, static output), then
// the same resolved winner appears on the right in the real Playground
// result styling. Entirely static/mock — no live resolve, no API call.
export function HeroPreview() {
  const [showWinner, setShowWinner] = useState(false);

  return (
    <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
      <HeroTerminal onDone={() => setShowWinner(true)} />
      <div className="flex items-center">
        {showWinner ? (
          <HeroWinnerCard className="w-full animate-in fade-in slide-in-from-bottom-2 duration-500" />
        ) : (
          <div className="w-full rounded-lg border border-dashed border-hairline p-4">
            <p className="text-body text-ink-faint">
              Resolving…
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
