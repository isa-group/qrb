import { apiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";

import type { TaskSpecFormValues } from "./schema";

export type Instance = components["schemas"]["Instance"];
export type SolveResponse = components["schemas"]["SolveResponse"];
export type TimingsResponse = components["schemas"]["TimingsResponse"];

export type ResolveOutcome =
  | { kind: "success"; instance?: Instance; response: SolveResponse; timings: TimingsResponse }
  | { kind: "infeasible"; instance?: Instance; response: SolveResponse; timings: TimingsResponse }
  | { kind: "validation-error"; message: string }
  | { kind: "unavailable"; message: string };

const UNAVAILABLE_MESSAGE =
  "Playground requires a running QRB API — see README for local setup.";

function buildRequestBody(values: TaskSpecFormValues) {
  return {
    circuit_qasm: values.circuitQasm,
    shots: values.shots,
    live: true,
    force_refresh: values.forceRefresh,
    engine_id: values.engine ?? null,
    preferences: {
      weights: values.weights,
      constraints: Object.entries(values.constraints).map(([feature, { op, value }]) => ({
        feature,
        op,
        value,
      })),
      require_provider:
        values.providerConstraint === "any" ? null : values.providerConstraint,
      pareto: values.pareto,
    },
  };
}

interface FastApiValidationDetail {
  msg?: string;
}

function extractErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d: FastApiValidationDetail) => d.msg ?? JSON.stringify(d))
        .join("; ");
    }
  }
  return "";
}

// Real POST /select against apps/api, then POST /instance — replaces the
// old client-side mock (see lib/playground/eligibility.ts for what stayed
// client-side and why). Sequential, not Promise.all: both endpoints
// independently call fetch_catalog(), and firing them in parallel doubles
// concurrent load on IBM/Braket during a cold cache, which stalls under
// IBM's rate limiting. Calling /instance second means it lands within
// fetch_catalog()'s 20s process-wide cache window and returns near-
// instantly instead of re-fetching. /instance is best-effort — only
// needed for the optional Instance JSON viewer, never blocks showing the
// actual solve result.
export async function resolveBinding(
  values: TaskSpecFormValues
): Promise<ResolveOutcome> {
  const body = buildRequestBody(values);

  const selectResult = await apiClient
    .POST("/select", { body })
    .catch(() => null);
  if (!selectResult) {
    return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
  }

  if (selectResult.error) {
    const status = selectResult.response.status;
    const message = extractErrorMessage(selectResult.error);
    if (status === 422) {
      return { kind: "validation-error", message: message || "Invalid circuit or preferences." };
    }
    return {
      kind: "unavailable",
      message: message || "The solver is unavailable — try again.",
    };
  }

  const { result: response, timings_ms: timings } = selectResult.data as {
    result: SolveResponse;
    timings_ms: TimingsResponse;
  };

  const instance = await apiClient
    .POST("/instance", { body })
    .then((r) => (r.error ? undefined : (r.data as { result: Instance }).result))
    .catch(() => undefined);

  return response.feasibility === "INFEASIBLE"
    ? { kind: "infeasible", instance, response, timings }
    : { kind: "success", instance, response, timings };
}
