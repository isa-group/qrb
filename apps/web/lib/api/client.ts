import createClient from "openapi-fetch";

import type { paths } from "./schema";

// The gateway serves the web build and the API from one origin, with the API
// under /api. Override NEXT_PUBLIC_API_BASE_URL only for local dev where the
// web dev server (:3000) and the gateway run on different ports, e.g.
// http://localhost:3001/api (cross-origin, so the gateway must allow it).
const configuredBase = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";

// openapi-fetch builds `new Request(baseUrl + path)`, which needs an absolute
// URL outside the browser. Resolve a relative base against the page origin
// when one exists; in the static export (no window) the relative base is kept
// and only ever used by browser-side calls.
export const API_BASE_URL =
  configuredBase.startsWith("/") && typeof window !== "undefined"
    ? new URL(configuredBase, window.location.origin).toString().replace(/\/$/, "")
    : configuredBase.replace(/\/$/, "");

// Sessions are cookies, so send them explicitly (also for a cross-origin dev
// base; same-origin would include them by default).
export const apiClient = createClient<paths>({
  baseUrl: API_BASE_URL,
  credentials: "include",
});
