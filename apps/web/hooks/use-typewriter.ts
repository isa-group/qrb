"use client";

import { useEffect, useState } from "react";

// One-shot (not looping) — types `text` out at `speedMs` per character, then
// stays settled. Returns the substring typed so far and whether typing has
// finished, so callers can gate what appears next (e.g. output lines that
// should only reveal once the command is fully typed).
export function useTypewriter(text: string, speedMs = 35) {
  const [length, setLength] = useState(0);

  useEffect(() => {
    if (length >= text.length) return;
    const timeout = setTimeout(() => setLength((l) => l + 1), speedMs);
    return () => clearTimeout(timeout);
  }, [length, text, speedMs]);

  return { typed: text.slice(0, length), done: length >= text.length };
}
