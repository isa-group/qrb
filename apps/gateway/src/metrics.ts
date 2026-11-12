/**
 * Prometheus metrics for the gateway.
 *
 * Served by a separate listener (`METRICS_PORT`, see `index.ts`) that only answers `/metrics`:
 * the public app never routes it, so metrics are reachable on the compose network only
 * (Prometheus scrapes `gateway:9091`) and never through the reverse proxy.
 *
 * Labels are the matched route pattern (`/api/catalog/:candidate_id`), never the raw path, so
 * the series count stays bounded. 429s (quota and burst) and 5xx (upstream errors, 502 when the
 * API is unreachable) are read from the `status` label.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import { routePath } from "hono/route";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { GatewayEnv } from "./forward";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "qrb_gateway_" });

const requests = new Counter({
  name: "qrb_gateway_http_requests_total",
  help: "API requests by matched route, method and status.",
  labelNames: ["route", "method", "status"] as const,
  registers: [registry],
});

const duration = new Histogram({
  name: "qrb_gateway_http_request_duration_seconds",
  help: "API request duration by matched route and method (a fresh /select waits tens of seconds on providers).",
  labelNames: ["route", "method"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

/** The matched route pattern, or `unmatched` when only the `/api/*` middleware matched (a 404). */
export function routeLabel(c: Context): string {
  const route = routePath(c, -1);
  return !route || route.endsWith("*") ? "unmatched" : route;
}

/** Records every `/api/*` request. Mount first, so it sees the final status, including 429s. */
export function recordMetrics(): MiddlewareHandler<GatewayEnv> {
  return async (c: Context<GatewayEnv>, next: Next) => {
    const start = performance.now();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      const route = routeLabel(c);
      const method = c.req.method;
      requests.inc({ route, method, status: String(status) });
      duration.observe({ route, method }, (performance.now() - start) / 1000);
    }
  };
}

/** Handler for the metrics listener: `/metrics` in Prometheus text format, 404 for anything else. */
export async function metricsFetch(req: Request): Promise<Response> {
  if (new URL(req.url).pathname !== "/metrics") return new Response("Not Found", { status: 404 });
  return new Response(await registry.metrics(), { headers: { "content-type": registry.contentType } });
}
