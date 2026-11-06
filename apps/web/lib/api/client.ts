import createClient from "openapi-fetch";

import type { components, paths } from "./schema";

/** Base URL of the QRB API. Set NEXT_PUBLIC_QRB_API (inlined at build time). */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_QRB_API?.replace(/\/$/, "") ?? "http://localhost:8000";

/** Sends the gateway's session cookie, so a signed-in visitor's requests use their account's budget. */
export const api = createClient<paths>({ baseUrl: API_BASE_URL, credentials: "include" });

export type Schemas = components["schemas"];
export type CatalogSource = Schemas["CatalogSource"];
export type CandidateEvaluation = Schemas["CandidateEvaluation"];
export type SelectRequest = Schemas["SelectRequest"];
export type SelectResponse = Schemas["SelectResponseEnvelope"];
