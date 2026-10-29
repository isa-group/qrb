import { resolve, sep, extname } from "node:path";
import type { Context } from "hono";

export interface ServeWebOptions {
  /** Directory holding the Next static export (`apps/web/out`). */
  root: string;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

/**
 * Hono handler that serves a Next static export. GET/HEAD only.
 *
 * Route mapping: `/` -> index.html; `/x` -> `x` (a file), else `x.html`, else
 * `x/index.html`. Anything else gets `404.html` with status 404. `/api` and
 * `/api/*` are never handled (except the exact `/api` docs page the web app
 * exports as `api.html`): callers mount this as a fallback after API routes.
 */
export function serveWeb({ root }: ServeWebOptions) {
  const rootDir = resolve(root);

  const find = async (pathname: string): Promise<string | null> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes("\0") || decoded.includes("\\")) return null;
    if (decoded.split("/").some((s) => s === "..")) return null;

    const rel = decoded.replace(/\/+$/, "");
    const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, `${rel}/index.html`];
    for (const cand of candidates) {
      const abs = resolve(rootDir, "." + (cand.startsWith("/") ? cand : "/" + cand));
      if (!abs.startsWith(rootDir + sep)) continue;
      const file = Bun.file(abs);
      // Bun.file on a directory reports size 0 / exists() false for dirs.
      if (await file.exists()) return abs;
    }
    return null;
  };

  return async (c: Context) => {
    const method = c.req.method;
    const pathname = new URL(c.req.url).pathname;
    const isApi = pathname.startsWith("/api/");
    if ((method !== "GET" && method !== "HEAD") || isApi) {
      return c.json({ error: "not_found" }, 404);
    }

    const abs = await find(pathname);
    const status = abs ? 200 : 404;
    const target = abs ?? resolve(rootDir, "404.html");
    const file = Bun.file(target);
    if (!abs && !(await file.exists())) return c.text("Not Found", 404);

    const isHtml = extname(target) === ".html";
    const hashed = abs !== null && pathname.startsWith("/_next/static/");
    const headers = new Headers({
      "Content-Type": file.type,
      "Cache-Control": hashed ? IMMUTABLE : isHtml || !abs ? NO_CACHE : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    if (method === "HEAD") {
      headers.set("Content-Length", String(file.size));
      return new Response(null, { status, headers });
    }
    return new Response(file, { status, headers });
  };
}
