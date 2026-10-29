// Cloudflare Turnstile, loaded client-side with explicit rendering. A single
// widget lives in the container registered by <CaptchaSlot />. Tokens are
// single-use, so getCaptchaToken() resets and re-executes the widget for every
// request. appearance "interaction-only" keeps it invisible unless Cloudflare
// needs the visitor to click something.

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TOKEN_TIMEOUT_MS = 120_000;

export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

export class CaptchaError extends Error {
  constructor(
    message: string,
    readonly code: "not-configured" | "no-container" | "load-failed" | "failed" | "busy",
  ) {
    super(message);
  }
}

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let container: HTMLElement | null = null;
let widgetId: string | null = null;
let scriptPromise: Promise<TurnstileApi> | null = null;
let pending: { resolve: (t: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new CaptchaError("CAPTCHA script did not initialise.", "load-failed"));
    script.onerror = () => {
      script.remove();
      reject(new CaptchaError("Could not load the CAPTCHA script.", "load-failed"));
    };
    document.head.appendChild(script);
  }).catch((e) => {
    scriptPromise = null;
    throw e;
  });
  return scriptPromise;
}

function settle(fn: (p: NonNullable<typeof pending>) => void) {
  const p = pending;
  if (!p) return;
  pending = null;
  clearTimeout(p.timer);
  fn(p);
}

// Called by <CaptchaSlot /> on mount (element) and unmount (null).
export function setCaptchaContainer(el: HTMLElement | null) {
  if (el === container) return;
  if (widgetId !== null && window.turnstile) {
    try {
      window.turnstile.remove(widgetId);
    } catch {
      /* already gone */
    }
  }
  widgetId = null;
  container = el;
  settle((p) => p.reject(new CaptchaError("CAPTCHA was closed.", "failed")));
}

// A fresh single-use token. Rejects with CaptchaError.
export async function getCaptchaToken(): Promise<string> {
  if (!TURNSTILE_SITE_KEY) {
    throw new CaptchaError(
      "CAPTCHA is not configured for this deployment (NEXT_PUBLIC_TURNSTILE_SITE_KEY is missing), so anonymous requests can't be verified. Sign in to continue.",
      "not-configured",
    );
  }
  if (!container) throw new CaptchaError("CAPTCHA widget is not on the page.", "no-container");
  if (pending) throw new CaptchaError("A CAPTCHA check is already running.", "busy");

  const turnstile = await loadScript();
  const el = container;
  if (!el) throw new CaptchaError("CAPTCHA widget is not on the page.", "no-container");

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => settle((p) => p.reject(new CaptchaError("CAPTCHA timed out.", "failed"))),
      TOKEN_TIMEOUT_MS,
    );
    pending = { resolve, reject, timer };
    const fail = () => settle((p) => p.reject(new CaptchaError("CAPTCHA check failed.", "failed")));
    if (widgetId === null) {
      widgetId = turnstile.render(el, {
        sitekey: TURNSTILE_SITE_KEY,
        execution: "execute",
        appearance: "interaction-only",
        callback: (token: string) => settle((p) => p.resolve(token)),
        "error-callback": fail,
        "timeout-callback": fail,
        "expired-callback": () => {},
      });
    } else {
      turnstile.reset(widgetId);
    }
    turnstile.execute(widgetId);
  });
}
