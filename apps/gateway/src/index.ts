import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { app } from "./app";
import { withWeb } from "./server";

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST ?? "127.0.0.1";

// WEB_ROOT: directory of the Next static export served at `/` (API stays under
// /api/*). Default: apps/web/out in the repo (resolved relative to this file,
// not the cwd). If the directory is missing, only the API is served.
const webRoot = resolve(process.env.WEB_ROOT ?? resolve(import.meta.dir, "../../web/out"));
if (existsSync(webRoot) && statSync(webRoot).isDirectory()) {
  withWeb(app, webRoot);
  console.log(`serving web from ${webRoot}`);
} else {
  console.log(`web root ${webRoot} not found; serving API only (set WEB_ROOT)`);
}

Bun.serve({
  port,
  hostname,
  fetch: app.fetch,
});

console.log(`gateway listening on http://${hostname}:${port}`);
