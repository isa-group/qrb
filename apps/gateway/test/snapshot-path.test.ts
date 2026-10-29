import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

function setup() {
  const seen: { url: string; body: string }[] = [];
  const app = createApp({
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async (req) => {
      seen.push({ url: req.url, body: await req.text() });
      return Response.json({ ok: true });
    },
  });
  return { app, seen };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-captcha-token": "t" }, body });

describe("snapshot_path rejection", () => {
  for (const path of ["/api/select", "/api/instance"]) {
    test(`${path}: snapshot_path -> 422, upstream not called`, async () => {
      const { app, seen } = setup();
      const res = await post(app, path, JSON.stringify({ a: 1, snapshot_path: "/etc/passwd" }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ detail: "snapshot_path is not accepted" });
      expect(seen).toHaveLength(0);
    });

    test(`${path}: without snapshot_path (or null) -> forwarded intact`, async () => {
      for (const body of [JSON.stringify({ force_refresh: false }), '{ "force_refresh": false, "snapshot_path": null }']) {
        const { app, seen } = setup();
        const res = await post(app, path, body);
        expect(res.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0].body).toBe(body);
        expect(seen[0].url).toBe("http://upstream.test:8000" + path.replace("/api", ""));
      }
    });

    test(`${path}: oversized body -> 413`, async () => {
      const { app, seen } = setup();
      const res = await post(app, path, JSON.stringify({ pad: "x".repeat(1024 * 1024 + 1) }));
      expect(res.status).toBe(413);
      expect(seen).toHaveLength(0);
    });
  }

  test("malformed JSON from an anonymous caller is treated as a live refresh (403)", async () => {
    const { app, seen } = setup();
    const res = await post(app, "/api/select", "{not json");
    // An unparseable body has no boolean force_refresh, so it counts as the
    // default (live refresh): an anonymous caller gets 403 instead of a forward.
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});
