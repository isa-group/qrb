import type { MiddlewareHandler } from "hono";
import type { GatewayEnv } from "./forward";

export const MAX_BODY_BYTES = 1024 * 1024;

export interface ReadBodyOptions {
  /** Maximum request body size in bytes (default 1 MiB). */
  maxBytes?: number;
}

/**
 * Rejects bodies larger than `maxBytes` (413) before anything is forwarded,
 * and stashes a JSON body as `jsonBody` so later middleware (the quota cost
 * reads `force_refresh`) does not consume the stream again. The body is read
 * from a clone, so the original still reaches the upstream intact.
 *
 * Malformed or non-object JSON is NOT rejected here: it is forwarded as-is so
 * the Python API produces its own 422 validation error.
 */
export function readJsonBody(opts: ReadBodyOptions = {}): MiddlewareHandler<GatewayEnv> {
  const max = opts.maxBytes ?? MAX_BODY_BYTES;
  return async (c, next) => {
    const tooLarge = () => c.json({ detail: "Request body too large" }, 413);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > max) return tooLarge();

    const stream = c.req.raw.clone().body;
    if (!stream) return next();

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }

    try {
      c.set("jsonBody", JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      // Not JSON: the API answers 422.
    }
    return next();
  };
}
