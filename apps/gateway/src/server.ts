import type { Hono } from "hono";
import type { GatewayEnv } from "./forward";
import { serveWeb } from "./static";

/**
 * Mount the static web build as the fallback for everything the API routes
 * did not match, so `/api/*` always wins. Used by index.ts and tests.
 */
export function withWeb<E extends GatewayEnv>(app: Hono<E>, webRoot: string): Hono<E> {
  app.notFound(serveWeb({ root: webRoot }) as never);
  return app;
}
