import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { withWeb } from "../src/server";

let dir: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "gw-static-"));
  dir = join(base, "out");
  mkdirSync(join(dir, "catalog"), { recursive: true });
  mkdirSync(join(dir, "_next/static"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<h1>home</h1>");
  writeFileSync(join(dir, "playground.html"), "<h1>playground</h1>");
  writeFileSync(join(dir, "catalog/resource.html"), "<h1>resource</h1>");
  writeFileSync(join(dir, "docs/index.html"), "<h1>docs</h1>");
  writeFileSync(join(dir, "404.html"), "<h1>not found page</h1>");
  writeFileSync(join(dir, "_next/static/x.js"), "console.log(1)");
  writeFileSync(join(base, "secret.txt"), "SECRET");
  app = withWeb(createApp(), dir);
});

afterAll(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const get = (p: string, init?: RequestInit) => app.request(p, init);

test("serves /, /playground, nested and directory-index routes", async () => {
  for (const [p, body] of [
    ["/", "home"],
    ["/playground", "playground"],
    ["/playground/", "playground"],
    ["/catalog/resource", "resource"],
    ["/docs", "docs"],
  ]) {
    const res = await get(p);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(body);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  }
});

test("missing path returns the 404 page with status 404", async () => {
  const res = await get("/nope/missing");
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("not found page");
});

test("traversal attempts do not escape the root", async () => {
  for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/a/..%5csecret.txt", "/%00"]) {
    const res = await get(p);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SECRET");
  }
});

test("hashed _next/static assets are immutable", async () => {
  const res = await get("/_next/static/x.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("immutable");
});

test("HEAD works and non-GET methods are not served", async () => {
  const head = await get("/playground", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect((await head.text()).length).toBe(0);
  expect((await get("/playground", { method: "POST" })).status).toBe(404);
});

test("/api/health still answers from the API and unknown /api/* is not the web 404", async () => {
  const res = await get("/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
  const miss = await get("/api/nope");
  expect(miss.status).toBe(404);
  expect(await miss.text()).not.toContain("not found page");
});
