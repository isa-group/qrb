import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

function setup(respond: (req: Request) => Response | Promise<Response>, pre?: (app: ReturnType<typeof createApp>) => void) {
  const seen: Request[] = [];
  const app = createApp({
    upstreamUrl: "http://upstream.test:8000",
    secret: "s3cret",
    fetch: async (req) => {
      seen.push(req);
      return respond(req);
    },
  });
  pre?.(app);
  return { app, seen };
}

describe("forward", () => {
  test("sends secret, replaces client-sent secret, strips client user id", async () => {
    const { app, seen } = setup(() => Response.json({ ok: true }));
    await app.request("/api/engines", {
      headers: { "X-QRB-Gateway-Secret": "evil", "X-QRB-User-Id": "attacker", cookie: "a=b" },
    });
    expect(seen[0].url).toBe("http://upstream.test:8000/engines");
    expect(seen[0].headers.get("x-qrb-gateway-secret")).toBe("s3cret");
    expect(seen[0].headers.get("x-qrb-user-id")).toBeNull();
    expect(seen[0].headers.get("cookie")).toBeNull();
  });

  test("forwards userId from context", async () => {
    const seen: Request[] = [];
    const { Hono } = await import("hono");
    const { createForward } = await import("../src/forward");
    const app = new Hono<{ Variables: { userId?: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", "u1");
      await next();
    });
    app.get("/api/presets", createForward({ upstreamUrl: "http://u", secret: "x", fetch: async (r) => (seen.push(r), Response.json([])) }));
    await app.request("/api/presets", { headers: { "X-QRB-User-Id": "attacker" } });
    expect(seen[0].headers.get("x-qrb-user-id")).toBe("u1");
  });

  test("preserves query string and path param", async () => {
    const { app, seen } = setup(() => Response.json({}));
    await app.request("/api/catalog/abc-1?x=1&y=a%20b");
    expect(seen[0].url).toBe("http://upstream.test:8000/catalog/abc-1?x=1&y=a%20b");
  });

  test("passes status and body through, including 422", async () => {
    const { app } = setup((req) =>
      new URL(req.url).pathname === "/select"
        ? Response.json({ detail: [{ msg: "bad" }] }, { status: 422 })
        : Response.json({ items: [1, 2] }),
    );
    const bad = await app.request("/api/select", { method: "POST", body: '{"force_refresh":false}', headers: { "content-type": "application/json", "x-captcha-token": "t" } });
    expect(bad.status).toBe(422);
    expect(bad.headers.get("content-type")).toContain("application/json");
    expect(await bad.json()).toEqual({ detail: [{ msg: "bad" }] });
    const ok = await app.request("/api/catalog");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ items: [1, 2] });
  });

  test("forwards POST body", async () => {
    const { app, seen } = setup(() => Response.json({}));
    await app.request("/api/instance", { method: "POST", body: '{"force_refresh":false}', headers: { "content-type": "application/json", "x-captcha-token": "t" } });
    expect(seen[0].method).toBe("POST");
    expect(await seen[0].text()).toBe('{"force_refresh":false}');
  });

  test("upstream down returns 502 with detail", async () => {
    const app = createApp({
      upstreamUrl: "http://upstream.test",
      secret: "s",
      fetch: async () => {
        throw new TypeError("connect ECONNREFUSED");
      },
    });
    const res = await app.request("/api/engines");
    expect(res.status).toBe(502);
    expect(typeof ((await res.json()) as { detail: unknown }).detail).toBe("string");
  });

  test("health is answered locally and unknown paths are not forwarded", async () => {
    const { app, seen } = setup(() => Response.json({}));
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/other")).status).toBe(404);
    expect(seen.length).toBe(0);
  });
});
