"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // resolvedTheme is undefined on the server (and on the client's first
  // render, before next-themes' own effects run) — rendering Moon/Sun off
  // of it directly makes the client's first paint pick a different icon
  // than the server did, which React can't reconcile via
  // suppressHydrationWarning (that only covers text/attribute diffs on the
  // same element, not swapping which icon renders). Gating on `mounted`
  // keeps the first client render identical to the server's.
  const [mounted, setMounted] = useState(false);
  // Deliberately post-mount, not derived from render — the whole point is
  // to render a value React can't know during SSR (whether hydration has
  // finished), so it can't come from a pure render calculation.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {mounted && resolvedTheme === "dark" ? (
        <Moon className="size-4" />
      ) : (
        <Sun className="size-4" />
      )}
    </Button>
  );
}
