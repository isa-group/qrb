"use client";

import { Check, Copy } from "@phosphor-icons/react/dist/ssr";
import { useState } from "react";

/** Copies `text`; reports success or failure in place and to screen readers. */
/** `name` says what is copied, for screen readers ("Copy POST /select"); the visible label stays short. */
export function CopyButton({
  text,
  label = "Copy",
  name,
  className = "",
}: {
  text: string;
  label?: string;
  name?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2000);
  };

  return (
    <button
      type="button"
      className={`btn btn-secondary button-sm ${className}`}
      onClick={copy}
      aria-label={name && state === "idle" ? `${label} ${name}` : undefined}
    >
      {state === "done" ? <Check size={16} weight="bold" aria-hidden /> : <Copy size={16} aria-hidden />}
      <span aria-live="polite">{state === "done" ? "Copied" : state === "failed" ? "Copy failed. Select the text instead." : label}</span>
    </button>
  );
}
