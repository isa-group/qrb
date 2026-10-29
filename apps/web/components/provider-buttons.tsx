"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PROVIDERS, startOAuth, type Provider } from "@/lib/auth/client";

export function ProviderButtons({
  mode,
  next,
  errorPath,
  only,
  onError,
}: {
  mode: "sign-in" | "link";
  next: string;
  errorPath: string;
  only?: Provider[];
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<Provider | null>(null);

  const go = async (provider: Provider) => {
    setBusy(provider);
    const message = await startOAuth(mode, provider, next, errorPath);
    if (message) {
      onError(message);
      setBusy(null);
    }
    // otherwise the browser is navigating to the provider
  };

  return (
    <>
      {PROVIDERS.filter((p) => !only || only.includes(p.id)).map((p) => (
        <Button
          key={p.id}
          type="button"
          variant="outline"
          size="lg"
          disabled={busy !== null}
          onClick={() => go(p.id)}
        >
          {busy === p.id
            ? "Redirecting…"
            : mode === "link"
              ? `Link ${p.label}`
              : `Continue with ${p.label}`}
        </Button>
      ))}
    </>
  );
}
