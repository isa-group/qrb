import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { GatewayEnv } from "../src/forward";
import { withWeb } from "../src/web";

function site(respond: (r: Request) => Response = () => new Response("<html>ok</html>", { headers: { "content-type": "text/html" } })) {
  const seen: Request[] = [];
  const app = new Hono<GatewayEnv>();
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  withWeb(app, { upstreamUrl: "http://web.test:3000/", fetch: async (r) => (seen.push(r), respond(r)) });
  return { app, seen };
}

describe("website behind the gateway", () => {
  test("pages are proxied to the Next server with path and query; API routes still win", async () => {
    const { app, seen } = site();
    const res = await app.request("http://qrb.test/catalog/ibm.ibm_aachen?view=map");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>ok</html>");
    expect(seen[0]!.url).toBe("http://web.test:3000/catalog/ibm.ibm_aachen?view=map");
    expect(seen[0]!.headers.get("x-forwarded-host")).toBe("qrb.test");
    expect(seen[0]!.headers.get("x-forwarded-proto")).toBe("http");

    expect(await (await app.request("http://qrb.test/api/health")).json()).toEqual({ status: "ok" });
    expect(seen).toHaveLength(1);
  });

  test("unknown /api paths get a JSON 404 and never reach the site", async () => {
    const { app, seen } = site();
    for (const path of ["/api", "/api/nope", "/api/scalar"]) {
      const res = await app.request(`http://qrb.test${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: "Not Found" });
    }
    expect(seen).toHaveLength(0);
  });

  test("credentials and internal headers are not passed to the site; its status, redirects and cookies come back", async () => {
    const { app, seen } = site(
      () =>
        new Response(null, {
          status: 307,
          headers: [
            ["location", "/bind"],
            ["set-cookie", "a=1; Path=/"],
            ["set-cookie", "b=2; Path=/"],
            ["content-encoding", "gzip"],
          ],
        }),
    );
    const res = await app.request("http://qrb.test/old", {
      headers: { "x-api-key": "qrb_secret", "x-qrb-gateway-secret": "s", "x-qrb-user-id": "u", "accept-encoding": "gzip", cookie: "c=1" },
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/bind");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(res.headers.get("content-encoding")).toBeNull();
    const h = seen[0]!.headers;
    for (const name of ["x-api-key", "x-qrb-gateway-secret", "x-qrb-user-id", "accept-encoding"]) expect(h.get(name)).toBeNull();
    expect(h.get("cookie")).toBe("c=1");
  });

  test("the site being down is a 502", async () => {
    const app = new Hono<GatewayEnv>();
    withWeb(app, {
      upstreamUrl: "http://web.test:3000",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect((await app.request("http://qrb.test/")).status).toBe(502);
  });
});
