import type { MiddlewareHandler } from "hono";
import type { GatewayEnv } from "./forward";

export const MAX_BODY_BYTES = 1024 * 1024;

export interface SnapshotPathOptions {
  /** Maximum request body size in bytes (default 1 MiB). */
  maxBytes?: number;
}

/**
 * Rejects requests whose JSON body has a non-null `snapshot_path` (422, same
 * message as the Python API) and bodies larger than `maxBytes` (413), before
 * anything is forwarded. The body is read from a clone, so the original
 * request body still reaches the upstream intact.
 *
 * Malformed or non-object JSON is NOT rejected here: it is forwarded as-is so
 * the Python API produces its own 422 validation error.
 *
 * A successfully parsed body is stashed as `jsonBody` on the context, so later
 * middleware (quota cost, route policy) reads it without consuming the stream
 * again.
 */
export function rejectSnapshotPath(opts: SnapshotPathOptions = {}): MiddlewareHandler<GatewayEnv> {
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return next();
    }
    c.set("jsonBody", parsed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).snapshot_path != null) {
      return c.json({ detail: "snapshot_path is not accepted" }, 422);
    }
    return next();
  };
}
