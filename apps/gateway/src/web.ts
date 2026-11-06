/**
 * The website behind the gateway: every request that no `/api/*` route
 * matched is proxied to the Next.js server (`next start`, `WEB_UPSTREAM_URL`).
 * One origin for the site and the API, so the session cookie set by sign-in
 * (`/api/auth/*`) is sent with the site's API calls, and CORS is not needed.
 *
 * Unknown `/api/*` paths never reach the site: they get a JSON 404.
 */
import type { Context, Hono } from "hono";
import type { Fetcher, GatewayEnv } from "./forward";

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
// accept-encoding: the site answers uncompressed, so a decoding fetch never
// hands back a body that no longer matches its content-encoding header.
const STRIPPED_REQUEST = [...HOP_BY_HOP, "host", "content-length", "accept-encoding", "x-api-key", "x-qrb-gateway-secret", "x-qrb-user-id", "x-qrb-client-ip"];
const STRIPPED_RESPONSE = [...HOP_BY_HOP, "content-length", "content-encoding"];

export interface WebOptions {
  /** Base URL of the Next.js server, e.g. `http://web:3000`. */
  upstreamUrl: string;
  /** Injectable fetch, for tests. */
  fetch?: Fetcher;
}

export function proxyWeb({ upstreamUrl, fetch: doFetch = (r) => fetch(r) }: WebOptions) {
  const base = upstreamUrl.replace(/\/+$/, "");
  return async (c: Context<GatewayEnv>): Promise<Response> => {
    const url = new URL(c.req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return c.json({ detail: "Not Found" }, 404);

    const headers = new Headers(c.req.raw.headers);
    for (const h of STRIPPED_REQUEST) headers.delete(h);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

    const method = c.req.method;
    const init: RequestInit & { duplex?: "half" } = { method, headers, redirect: "manual" };
    if (method !== "GET" && method !== "HEAD") {
      init.body = c.req.raw.body;
      init.duplex = "half";
    }

    let upstream: Response;
    try {
      upstream = await doFetch(new Request(base + url.pathname + url.search, init));
    } catch {
      return c.text("The website is unavailable.", 502);
    }
    const out = new Headers(upstream.headers);
    for (const h of STRIPPED_RESPONSE) out.delete(h);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  };
}

/** Mount the website as the fallback for everything the API routes did not match. */
export function withWeb<E extends GatewayEnv>(app: Hono<E>, opts: WebOptions): Hono<E> {
  app.notFound(proxyWeb(opts) as never);
  return app;
}
