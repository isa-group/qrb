import type { Context } from "hono";
import type { QuotaReservation } from "./limits/quota";

export type Fetcher = (req: Request) => Promise<Response>;

export type GatewayEnv = {
  Variables: {
    /** Caller's user id (session, anonymous identity or, from task 3.3, API key owner). Unset: no identity. */
    userId?: string;
    /** True for an anonymous identity, false for a signed-in user; unset when there is no identity. */
    isAnonymous?: boolean;
    /** Parsed JSON request body, set by `rejectSnapshotPath` when the body is valid JSON. */
    jsonBody?: unknown;
    /** The quota reservation for this request, set by `enforceQuota` on counted requests. */
    quota?: QuotaReservation;
    /** Client IP bucket key, set first on every `/api/*` request (see `client-ip.ts`); `"unknown"` without a socket address. */
    clientIp?: string;
    /** Id of the API key that authenticated the request (set by `withApiKey`), for the per-key burst limit. */
    apiKeyId?: string;
  };
};

export const SECRET_HEADER = "X-QRB-Gateway-Secret";
export const USER_HEADER = "X-QRB-User-Id";

export interface ForwardOptions {
  /** Upstream base URL; defaults to QRB_API_URL or http://127.0.0.1:8000. */
  upstreamUrl?: string;
  /**
   * Shared secret sent to the API. Defaults to QRB_GATEWAY_SECRET. If it is
   * empty, a warning is logged once and no secret header is sent (the API
   * will then reject the request); tests may leave it unset.
   */
  secret?: string;
  /** Injectable fetch, for tests. */
  fetch?: Fetcher;
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const STRIPPED_REQUEST = [
  ...HOP_BY_HOP,
  "host",
  "content-length",
  "cookie",
  "x-api-key",
  "x-captcha-token",
  SECRET_HEADER.toLowerCase(),
  USER_HEADER.toLowerCase(),
];
const PASSED_RESPONSE = ["content-type", "cache-control", "retry-after"];

/** Builds the handler that proxies `/api/<rest>` to `<upstream>/<rest>`. */
export function createForward(opts: ForwardOptions = {}) {
  const base = (opts.upstreamUrl ?? process.env.QRB_API_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
  const secret = opts.secret ?? process.env.QRB_GATEWAY_SECRET ?? "";
  const doFetch: Fetcher = opts.fetch ?? ((r) => fetch(r));
  if (!secret && process.env.NODE_ENV !== "test") {
    console.warn("QRB_GATEWAY_SECRET is not set: upstream requests will be rejected by the API");
  }

  return async (c: Context<GatewayEnv>): Promise<Response> => {
    const url = new URL(c.req.url);
    const target = base + url.pathname.replace(/^\/api/, "") + url.search;

    const headers = new Headers(c.req.raw.headers);
    for (const h of STRIPPED_REQUEST) headers.delete(h);
    if (secret) headers.set(SECRET_HEADER, secret);
    const userId = c.get("userId");
    if (userId) headers.set(USER_HEADER, userId);

    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = {
      method: c.req.method,
      headers,
      redirect: "manual",
    };
    if (hasBody) {
      init.body = c.req.raw.body;
      init.duplex = "half";
    }

    let upstream: Response;
    try {
      upstream = await doFetch(new Request(target, init));
    } catch {
      return c.json({ detail: "Upstream API unavailable" }, 502);
    }

    const out = new Headers();
    for (const h of PASSED_RESPONSE) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}
