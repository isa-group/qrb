import createClient from "openapi-fetch";

import type { paths } from "./schema";

// Points at apps/api (FastAPI). Configure per-environment via .env —
// see .env.example. Falls back to the local dev server.
const baseUrl =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export const apiClient = createClient<paths>({ baseUrl });
