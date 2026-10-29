// Shared handling for auth / rate-limit responses from the gateway.

export type LimitStatus = 401 | 403 | 429;

interface FastApiValidationDetail {
  msg?: string;
}

export function extractErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d: FastApiValidationDetail) => d.msg ?? JSON.stringify(d))
        .join("; ");
    }
  }
  return "";
}

// Retry-After is delta-seconds or an HTTP date. Returns seconds, or null.
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(1, Math.round(totalSeconds));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  const hours = `${h} hour${h === 1 ? "" : "s"}`;
  return rem ? `${hours} ${rem} minute${rem === 1 ? "" : "s"}` : hours;
}

export function quotaMessage(response: Response, error: unknown): string {
  const seconds = parseRetryAfter(response.headers.get("Retry-After"));
  const reset = seconds === null ? "" : ` Resets in ${formatDuration(seconds)}.`;
  const detail = extractErrorMessage(error);
  return `Quota reached.${reset}${detail ? ` ${detail}` : ""}`.trim();
}

export function authMessage(status: 401 | 403, error: unknown): string {
  const detail = extractErrorMessage(error);
  if (status === 401) {
    return "Sign in (or use an API key) to resolve bindings — a session is required for this request.";
  }
  return detail || "This request isn't allowed for your account.";
}

// Thrown by catalog fetches so react-query surfaces a specific message.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export function catalogError(response: Response, error: unknown): ApiError {
  const status = response.status;
  if (status === 429) return new ApiError(quotaMessage(response, error), status);
  if (status === 401 || status === 403) return new ApiError(authMessage(status, error), status);
  return new ApiError("Failed to load catalog", status);
}
