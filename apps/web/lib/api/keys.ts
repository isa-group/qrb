// API-key management against the gateway (/keys). Not in schema.d.ts yet, so
// the types are local. The full secret exists only in createApiKey's result.
import { API_BASE_URL } from "./client";
import { ApiError, extractErrorMessage, quotaMessage } from "./errors";

export interface ApiKeySummary {
  id: string;
  name: string;
  start: string;
  prefix: string;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeySummary {
  key: string;
}

export const KEY_NAME_MAX = 32;

// Mirrors the server: 1-32 characters after trimming.
export function validateKeyName(raw: string): string | null {
  const name = raw.trim();
  if (name.length < 1) return "Enter a name for the key.";
  if (name.length > KEY_NAME_MAX) return `Names can be at most ${KEY_NAME_MAX} characters.`;
  return null;
}

async function failure(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const detail = extractErrorMessage(body);
  switch (res.status) {
    case 400:
      return new ApiError(detail || "That key name isn't valid.", 400);
    case 401:
      return new ApiError("Your session has expired. Sign in again to manage API keys.", 401);
    case 403:
      return new ApiError("API keys need a signed-in account. Sign in with GitHub or ORCID first.", 403);
    case 404:
      return new ApiError("That key no longer exists (it may already be revoked).", 404);
    case 429:
      return new ApiError(quotaMessage(res, body), 429);
    default:
      return new ApiError(detail || "Something went wrong. Please try again.", res.status);
  }
}

async function send(base: string, path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { credentials: "include", ...init });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw await failure(res);
  return res;
}

export async function listApiKeys(base: string = API_BASE_URL): Promise<ApiKeySummary[]> {
  const res = await send(base, "/keys", { method: "GET" });
  return ((await res.json()) as { keys: ApiKeySummary[] }).keys;
}

export async function createApiKey(name: string, base: string = API_BASE_URL): Promise<CreatedApiKey> {
  const res = await send(base, "/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  return (await res.json()) as CreatedApiKey;
}

export async function revokeApiKey(id: string, base: string = API_BASE_URL): Promise<void> {
  await send(base, `/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}
