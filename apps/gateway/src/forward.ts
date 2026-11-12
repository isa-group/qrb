import type { Context } from "hono";
import type { QuotaReservation } from "./limits/quota";

export type Fetcher = (req: Request) => Promise<Response>;

export type GatewayEnv = {
  Variables: {
    /** Caller's identity: the session user, the API key's owner, or `ip:<client IP>` for keyless callers. */
    userId?: string;
    /** True for a keyless caller (identified by IP), false for a signed-in user or API key. */
    isAnonymous?: boolean;
    /** Parsed JSON request body, set by `readJsonBody` when the body is valid JSON. */
    jsonBody?: unknown;
    /** The quota reservation for this request, set by `enforceQuota` on counted requests. */
    quota?: QuotaReservation;
    /** Client IP bucket key, set first on every `/api/*` request (see `client-ip.ts`); `"unknown"` without a socket address. */
    clientIp?: string;
    /** Id of the API key that authenticated the request (set by `withApiKey`), for the per-key burst limit. */
    apiKeyId?: string;
    /** First characters of that key, for the account's request log (survives revoking it). */
    apiKeyStart?: string;
    /** The session user's `role` (Better Auth admin plugin), set by `sessionUser`; never set for an API key. */
    sessionRole?: string | null;
    /** When the session was created (the last sign-in), set by `sessionUser`; for the admin step-up check. */
    sessionCreatedAt?: Date;
    /** Set by `POST /api/binds` once the bind is accepted: its request log row is written when it finishes. */
    asyncBind?: boolean;
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
  SECRET_HEADER.toLowerCase(),
  USER_HEADER.toLowerCase(),
];
const PASSED_RESPONSE = ["content-type", "cache-control", "retry-after"];

/**
 * Sends a request to the Python API at `<upstream><path>`: strips hop-by-hop and credential
 * headers, adds the gateway secret and the caller's id. Throws when the upstream is unreachable.
 */
export type Upstream = (
  pathAndQuery: string,
  init: { method: string; headers?: ConstructorParameters<typeof Headers>[0]; body?: RequestInit["body"]; userId?: string; signal?: AbortSignal },
) => Promise<Response>;

export function createUpstream(opts: ForwardOptions = {}): Upstream {
  const base = (opts.upstreamUrl ?? process.env.QRB_API_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
  const secret = opts.secret ?? process.env.QRB_GATEWAY_SECRET ?? "";
  const doFetch: Fetcher = opts.fetch ?? ((r) => fetch(r));
  if (!secret && process.env.NODE_ENV !== "test") {
    console.warn("QRB_GATEWAY_SECRET is not set: upstream requests will be rejected by the API");
  }
  return (pathAndQuery, init) => {
    const headers = new Headers(init.headers);
    for (const h of STRIPPED_REQUEST) headers.delete(h);
    if (secret) headers.set(SECRET_HEADER, secret);
    if (init.userId) headers.set(USER_HEADER, init.userId);
    const req: RequestInit & { duplex?: "half" } = { method: init.method, headers, redirect: "manual", signal: init.signal };
    if (init.body !== undefined && init.body !== null) {
      req.body = init.body;
      req.duplex = "half";
    }
    return doFetch(new Request(base + pathAndQuery, req));
  };
}

/** Builds the handler that proxies `/api/<rest>` to `<upstream>/<rest>`. */
export function createForward(opts: ForwardOptions = {}, upstream: Upstream = createUpstream(opts)) {
  return async (c: Context<GatewayEnv>): Promise<Response> => {
    const url = new URL(c.req.url);
    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    let res: Response;
    try {
      res = await upstream(url.pathname.replace(/^\/api/, "") + url.search, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: hasBody ? c.req.raw.body : undefined,
        userId: c.get("userId"),
      });
    } catch {
      return c.json({ detail: "Upstream API unavailable" }, 502);
    }

    const out = new Headers();
    for (const h of PASSED_RESPONSE) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  };
}
