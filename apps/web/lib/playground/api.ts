import { apiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";

import { authMessage, extractErrorMessage, parseRetryAfter, quotaMessage } from "@/lib/api/errors";
import { parseQuotaHeaders, type QuotaInfo } from "@/lib/api/quota";
import { CaptchaError, getCaptchaToken } from "@/lib/captcha";

import type { TaskSpecFormValues } from "./schema";

export type Instance = components["schemas"]["Instance"];
export type SolveResponse = components["schemas"]["SolveResponse"];
export type TimingsResponse = components["schemas"]["TimingsResponse"];

export type ResolveOutcome =
  | { kind: "success"; instance?: Instance; response: SolveResponse; timings: TimingsResponse; quota?: QuotaInfo }
  | { kind: "infeasible"; instance?: Instance; response: SolveResponse; timings: TimingsResponse; quota?: QuotaInfo }
  | { kind: "validation-error"; message: string }
  | { kind: "unauthorized"; message: string } // 401: sign in / API key needed
  | { kind: "forbidden"; message: string } // 403: server detail (sign-in, CAPTCHA, ...)
  | { kind: "rate-limited"; message: string; quota?: QuotaInfo } // 429: quota reached, with reset time
  | { kind: "unavailable"; message: string };

const UNAVAILABLE_MESSAGE =
  "Playground requires a running QRB API — see README for local setup.";

export interface ResolveContext {
  // Signed in with a real (non-anonymous) session. Anything else is treated
  // as anonymous: CAPTCHA header, force_refresh pinned to false.
  signedIn: boolean;
  // Injectable for tests; defaults to the Turnstile widget.
  getCaptchaToken?: () => Promise<string>;
}

function buildRequestBody(values: TaskSpecFormValues, signedIn: boolean) {
  return {
    circuit_qasm: values.circuitQasm,
    shots: values.shots,
    live: true,
    // Anonymous requests must send an explicit false (omitted counts as true
    // and gets 403), whatever the form says.
    force_refresh: signedIn ? values.forceRefresh : false,
    engine_id: values.engine ?? null,
    preferences: {
      weights: values.weights,
      constraints: Object.entries(values.constraints).map(([feature, { op, value }]) => ({
        feature,
        op,
        value,
      })),
      require_provider:
        values.providerConstraint === "any" ? null : values.providerConstraint,
      pareto: values.pareto,
    },
  };
}

// Real POST /select against apps/api, then POST /instance — replaces the
// old client-side mock (see lib/playground/eligibility.ts for what stayed
// client-side and why). Sequential, not Promise.all: both endpoints
// independently call fetch_catalog(), and firing them in parallel doubles
// concurrent load on IBM/Braket during a cold cache, which stalls under
// IBM's rate limiting. Calling /instance second means it lands within
// fetch_catalog()'s 20s process-wide cache window and returns near-
// instantly instead of re-fetching. /instance is best-effort — only
// needed for the optional Instance JSON viewer, never blocks showing the
// actual solve result.
//
// Anonymous callers: every /select and /instance needs a fresh single-use
// Turnstile token, so /instance is skipped (one token, one counted request per
// resolve); the Instance JSON viewer simply isn't shown for them.
export async function resolveBinding(
  values: TaskSpecFormValues,
  ctx: ResolveContext = { signedIn: true }
): Promise<ResolveOutcome> {
  const { signedIn } = ctx;
  const body = buildRequestBody(values, signedIn);

  const headers: Record<string, string> = {};
  if (!signedIn) {
    try {
      headers["X-Captcha-Token"] = await (ctx.getCaptchaToken ?? getCaptchaToken)();
    } catch (e) {
      const message =
        e instanceof CaptchaError && e.code === "not-configured"
          ? e.message
          : "The CAPTCHA check didn't complete. Please try again.";
      return { kind: "unavailable", message };
    }
  }

  const selectResult = await apiClient
    .POST("/select", { body, headers })
    .catch(() => null);
  if (!selectResult) {
    return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
  }

  if (selectResult.error) {
    const status = selectResult.response.status;
    const message = extractErrorMessage(selectResult.error);
    if (status === 422) {
      return { kind: "validation-error", message: message || "Invalid circuit or preferences." };
    }
    if (status === 401) return { kind: "unauthorized", message: authMessage(401, selectResult.error) };
    if (status === 403) {
      const captchaFailed = !signedIn && /captcha/i.test(message);
      return {
        kind: "forbidden",
        message: captchaFailed
          ? "CAPTCHA verification failed. Please try again."
          : authMessage(403, selectResult.error),
      };
    }
    if (status === 429) {
      const seconds = parseRetryAfter(selectResult.response.headers.get("Retry-After"));
      return {
        kind: "rate-limited",
        message: quotaMessage(selectResult.response, selectResult.error),
        quota:
          seconds === null ? undefined : { limit: null, remaining: 0, resetAtMs: Date.now() + seconds * 1000 },
      };
    }
    if (status === 503 && !signedIn) {
      return { kind: "unavailable", message: "Verification is temporarily unavailable. Please try again shortly." };
    }
    return {
      kind: "unavailable",
      message: message || "The solver is unavailable — try again.",
    };
  }

  const { result: response, timings_ms: timings } = selectResult.data as {
    result: SolveResponse;
    timings_ms: TimingsResponse;
  };

  let quota = parseQuotaHeaders(selectResult.response.headers) ?? undefined;

  let instance: Instance | undefined;
  if (signedIn) {
    instance = await apiClient
      .POST("/instance", { body, headers })
      .then((r) => {
        quota = parseQuotaHeaders(r.response.headers) ?? quota;
        return r.error ? undefined : (r.data as { result: Instance }).result;
      })
      .catch(() => undefined);
  }

  return response.feasibility === "INFEASIBLE"
    ? { kind: "infeasible", instance, response, timings, quota }
    : { kind: "success", instance, response, timings, quota };
}
