import { expect, test } from "bun:test";
import { app } from "../src/app";

test("GET /api/health returns ok", async () => {
  const res = await app.request("/api/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});
