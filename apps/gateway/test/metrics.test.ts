import { expect, test } from "bun:test";
import { app } from "../src/app";
import { metricsFetch } from "../src/metrics";

const scrape = async () => (await metricsFetch(new Request("http://gateway:9091/metrics"))).text();

test("API requests are counted by route pattern and status", async () => {
  await app.request("/api/health");
  await app.request("/api/does-not-exist");
  const body = await scrape();
  expect(body).toMatch(/qrb_gateway_http_requests_total\{route="\/api\/health",method="GET",status="200"\} \d+/);
  expect(body).toMatch(/qrb_gateway_http_requests_total\{route="unmatched",method="GET",status="404"\} \d+/);
  expect(body).not.toContain("does-not-exist");
  expect(body).toContain("qrb_gateway_http_request_duration_seconds_bucket");
});

test("the metrics listener answers only /metrics", async () => {
  expect((await metricsFetch(new Request("http://gateway:9091/"))).status).toBe(404);
  expect((await metricsFetch(new Request("http://gateway:9091/api/health"))).status).toBe(404);
});

test("the public app does not route /metrics", async () => {
  expect((await app.request("/metrics")).status).toBe(404);
  expect((await app.request("/api/metrics")).status).toBe(404);
});
