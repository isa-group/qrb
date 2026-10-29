/**
 * Log-only mode (task 4.6): a limit that would reject logs one structured JSON
 * line and lets the request through. Grep the logs for `limit_would_reject`
 * to size the limits before turning enforcement on.
 */
export interface WouldReject {
  /** Which limit: `user_daily`, `ip_daily`, `ip_daily_gate`, `burst:<tier>`, `open_route_ip`. */
  limit: string;
  /** Counter key: user id, API key id or client IP. */
  key: string;
  /** Status the request would have got in enforce mode. */
  status: 429;
  [extra: string]: unknown;
}

export function logWouldReject(event: WouldReject): void {
  console.warn(JSON.stringify({ event: "limit_would_reject", mode: "log", ...event }));
}
