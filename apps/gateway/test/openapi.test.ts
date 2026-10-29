import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { buildOpenApi } from "../src/openapi";

// Open routes touch the database only for the per-IP limiter; no auth or
// identity is involved, so a minimal in-memory app is enough.
import { createTestDatabase } from "../src/db";
import { migrateUp } from "../src/db/migrator";
import { createAuth } from "../src/auth";
import { baseConfig, BEHIND_PROXY } from "./helpers/providers";
import { sql } from "kysely";

async function makeApp() {
  const db = createTestDatabase();
  await migrateUp(db);
  const app = createApp({
    ...BEHIND_PROXY,
    auth: createAuth(db, baseConfig, { logLevel: "error" }),
    db,
    upstreamUrl: "http://upstream.test:8000",
    secret: "s",
    fetch: async () => {
      throw new Error("docs routes must not reach the upstream");
    },
  });
  return { app, db };
}

const FORWARDED = ["/select", "/instance", "/catalog", "/catalog/{candidate_id}", "/engines", "/presets"];
const OWN = ["/health", "/keys", "/keys/{id}", "/usage"];
const AUTH = ["/auth/sign-in/social", "/auth/sign-out", "/auth/get-session", "/auth/list-accounts", "/auth/link-social", "/auth/unlink-account"];

describe("OpenAPI document", () => {
  const doc = buildOpenApi();

  test("is OpenAPI 3.x with the /api server and every route", () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.servers).toEqual([{ url: "/api" }]);
    for (const p of [...FORWARDED, ...OWN, ...AUTH]) expect(doc.paths[p]).toBeDefined();
    expect(Object.keys(doc.paths["/keys"]).sort()).toEqual(["get", "post"]);
    expect(doc.paths["/keys/{id}"].delete).toBeDefined();
  });

  test("every $ref resolves", () => {
    const text = JSON.stringify(doc);
    for (const m of text.matchAll(/"\$ref":"#\/components\/([^/]+)\/([^"]+)"/g)) {
      expect(doc.components[m[1]][m[2]]).toBeDefined();
    }
  });

  test("resolve routes document the error responses, quota headers and security", () => {
    for (const p of ["/select", "/instance"]) {
      const op = doc.paths[p].post;
      for (const code of ["401", "403", "413", "422", "429", "503"]) expect(op.responses[code]).toBeDefined();
      expect(op.responses["429"].headers["Retry-After"]).toBeDefined();
      for (const h of ["X-Quota-Limit", "X-Quota-Remaining", "X-Quota-Reset"]) expect(op.responses["200"].headers[h]).toBeDefined();
      expect(op.responses["401"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Error" });
      expect(op.security).toContainEqual({ captchaToken: [] });
    }
    expect(doc.components.schemas.Error.properties.detail.type).toBe("string");
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(["apiKey", "captchaToken", "sessionCookie"]);
    expect(doc.components.securitySchemes.apiKey.name).toBe("x-api-key");
    expect(doc.components.securitySchemes.captchaToken.name).toBe("X-Captcha-Token");
  });

  test("catalog reads document 403, 429 and quota headers", () => {
    for (const p of ["/catalog", "/catalog/{candidate_id}"]) {
      const op = doc.paths[p].get;
      expect(op.responses["403"]).toBeDefined();
      expect(op.responses["429"].headers["Retry-After"]).toBeDefined();
      expect(op.responses["200"].headers["X-Quota-Remaining"]).toBeDefined();
    }
  });

  test("snapshot_path is not an accepted field", () => {
    expect(doc.components.schemas.SelectRequest.properties.snapshot_path).toBeUndefined();
    expect(doc.components.schemas.InstanceRequest.properties.snapshot_path).toBeUndefined();
    expect(JSON.stringify(doc.components.schemas)).not.toContain("snapshot_path");
  });
});

describe("docs routes", () => {
  test("schema route returns the document; page returns HTML; neither creates an identity", async () => {
    const { app, db } = await makeApp();
    try {
      const schema = await app.request("/api/openapi.json");
      expect(schema.status).toBe(200);
      expect(schema.headers.get("content-type")).toContain("application/json");
      const body = (await schema.json()) as { openapi: string; paths: Record<string, unknown> };
      expect(body.openapi).toMatch(/^3\./);
      expect(body.paths["/select"]).toBeDefined();

      const page = await app.request("/api/scalar");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("/api/openapi.json");

      const users = await sql<{ n: string }>`select count(*)::text as n from "user"`.execute(db);
      expect(users.rows[0].n).toBe("0");
    } finally {
      await db.destroy();
    }
  });

  test("both routes are per-IP rate limited", async () => {
    const db = createTestDatabase();
    await migrateUp(db);
    const app = createApp({
      ...BEHIND_PROXY,
      auth: createAuth(db, baseConfig, { logLevel: "error" }),
      db,
      upstreamUrl: "http://upstream.test:8000",
      secret: "s",
      limits: { openRoutePerIp: { limit: 2, windowSeconds: 60 } },
      fetch: async () => Response.json({}),
    });
    try {
      expect((await app.request("/api/openapi.json")).status).toBe(200);
      expect((await app.request("/api/scalar")).status).toBe(200);
      const third = await app.request("/api/scalar");
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toBeTruthy();
    } finally {
      await db.destroy();
    }
  });
});
