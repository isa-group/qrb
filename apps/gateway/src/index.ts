import { app } from "./app";
import { purgeActivity } from "./activity";
import { recoverInterruptedBinds } from "./binds";
import { authFromEnv } from "./auth/from-env";
import type { Database } from "./db";
import { withWeb } from "./web";
import { metricsFetch } from "./metrics";

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST ?? "127.0.0.1";

// WEB_UPSTREAM_URL: the website's Next.js server (`next start`), served at `/`
// while the API stays under /api/*. Unset: only the API is served.
const webUpstream = process.env.WEB_UPSTREAM_URL?.trim();
if (webUpstream) {
  withWeb(app, { upstreamUrl: webUpstream });
  console.log(`serving the website from ${webUpstream}`);
} else {
  console.log("WEB_UPSTREAM_URL is not set; serving the API only");
}

Bun.serve({
  port,
  hostname,
  fetch: app.fetch,
  // A fresh /select waits on the providers for tens of seconds; Bun's default
  // idle timeout (10 s) would cut it off.
  idleTimeout: 255,
});

console.log(`gateway listening on http://${hostname}:${port}`);

// Prometheus metrics on their own port: never routed by the public app, so the reverse proxy
// cannot reach them. Compose does not publish this port; Prometheus scrapes it on the network.
const metricsPort = Number(process.env.METRICS_PORT ?? 9091);
if (metricsPort > 0) {
  Bun.serve({ port: metricsPort, hostname, fetch: metricsFetch });
  console.log(`metrics on http://${hostname}:${metricsPort}/metrics`);
}

// Account activity is kept 30 days: purge older rows at startup and then hourly, and recover
// async binds interrupted by a restart.
const purge = async () => {
  try {
    const db = (await authFromEnv()()).options.database.db as Database;
    await purgeActivity(db);
    // Binds left pending by a restart: fail them and refund their units.
    await recoverInterruptedBinds(db);
  } catch (e) {
    console.error("activity purge failed", e);
  }
};
void purge();
setInterval(purge, 3_600_000).unref();
