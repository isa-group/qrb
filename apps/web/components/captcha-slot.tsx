"use client";

import { useEffect, useRef } from "react";

import { setCaptchaContainer, TURNSTILE_SITE_KEY } from "@/lib/captcha";

// Mount point for the Turnstile widget (rendered only for not-signed-in
// users). The widget stays invisible unless Cloudflare asks for interaction.
export function CaptchaSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setCaptchaContainer(ref.current);
    return () => setCaptchaContainer(null);
  }, []);
  return (
    <div className="mt-3">
      <div ref={ref} />
      <p className="text-caption text-ink-tertiary">
        {TURNSTILE_SITE_KEY
          ? "Anonymous requests are verified with a CAPTCHA when you resolve."
          : "CAPTCHA is not configured here (NEXT_PUBLIC_TURNSTILE_SITE_KEY), so anonymous resolves will fail. Sign in to continue."}
      </p>
    </div>
  );
}
