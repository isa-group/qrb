/**
 * The gateway's public OpenAPI document (task 5.1).
 *
 * One document for the whole public surface, served at `GET /api/openapi.json`
 * and rendered at `GET /api/scalar`. It is the committed FastAPI schema
 * (`openapi/qrb-api.json`, regenerated offline by `task gateway:openapi`, so the
 * gateway never fetches it at runtime) merged with the gateway's own routes.
 *
 * Paths are relative to the server URL `/api` (`servers: [{url: "/api"}]`), so
 * `/select` here is `POST /api/select`. That keeps the web client (base `/api`,
 * calls like `/select`) and its generated types unchanged.
 *
 * Changes to FastAPI's schema: `/health` is replaced by the gateway's own;
 * `snapshot_path` is removed from request bodies (always rejected with 422);
 * every operation gets the gateway's error responses and quota headers.
 *
 * Better Auth endpoints: a hand-written summary of the ones the web app uses,
 * not Better Auth's OpenAPI plugin. The plugin would add its own route and
 * dependency and document every endpoint (including ones we do not expose to
 * users), while only six are part of our contract.
 */
import qrbApi from "../openapi/qrb-api.json";

type Json = Record<string, any>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema: Json, required = true) => ({ required, content: { "application/json": { schema } } });
const jsonResponse = (description: string, schema: Json, headers?: Json) => ({
  description,
  content: { "application/json": { schema } },
  ...(headers ? { headers } : {}),
});
const errorResponse = (description: string, headers?: Json) => jsonResponse(description, ref("Error"), headers);

const quotaHeaders = {
  "X-Quota-Limit": { description: "Daily units for the caller's tier.", schema: { type: "integer" } },
  "X-Quota-Remaining": { description: "Units left today after this request.", schema: { type: "integer" } },
  "X-Quota-Reset": { description: "Unix time (seconds) of the next 00:00 UTC, when the quota resets.", schema: { type: "integer" } },
};
const retryAfter = { "Retry-After": { description: "Seconds to wait before retrying.", schema: { type: "integer", minimum: 1 } } };

const R401 = errorResponse("Authentication required: sign in, send an API key in `x-api-key`, or use the web app (CAPTCHA token), or the API key is invalid, revoked or expired.");
const R403 = errorResponse("Forbidden: live refresh requires sign-in, or the CAPTCHA token is missing or invalid.");
const R413 = errorResponse("Request body too large (limit 1 MiB).");
const R422 = jsonResponse("Validation error: `snapshot_path` is not accepted, or the body does not match the schema.", { oneOf: [ref("Error"), ref("HTTPValidationError")] });
const R429 = errorResponse("Rate limit or daily quota reached. `detail` names the limit.", retryAfter);
const R503 = errorResponse("Service unavailable: the upstream API or the CAPTCHA verifier could not be reached.");

const identity = [{ sessionCookie: [] }, { apiKey: [] }];
const withCaptcha = [{ sessionCookie: [] }, { apiKey: [] }, { captchaToken: [] }];

function stripSnapshotPath(schema: Json | undefined) {
  if (!schema?.properties) return;
  delete schema.properties.snapshot_path;
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((r: string) => r !== "snapshot_path");
}

function forwarded(): { paths: Json; schemas: Json } {
  const src = structuredClone(qrbApi) as Json;
  const paths: Json = {};
  for (const [path, item] of Object.entries<Json>(src.paths)) {
    if (path === "/health") continue; // gateway-owned
    paths[path] = item;
  }
  const schemas: Json = src.components.schemas;
  stripSnapshotPath(schemas.SelectRequest);
  stripSnapshotPath(schemas.InstanceRequest);

  for (const [path, item] of Object.entries<Json>(paths)) {
    for (const op of Object.values<Json>(item)) {
      const resolve = path === "/select" || path === "/instance";
      const catalog = path.startsWith("/catalog");
      const res = (op.responses ??= {});
      if (resolve) {
        op.security = withCaptcha;
        op.parameters = [{ $ref: "#/components/parameters/CaptchaToken" }, ...(op.parameters ?? [])];
        res["401"] = R401;
        res["403"] = R403;
        res["413"] = R413;
        res["422"] = R422;
        res["429"] = R429;
        res["503"] = R503;
      } else {
        op.security = [...identity, {}]; // open: identity optional
        if (catalog) {
          res["403"] = R403;
          res["429"] = R429;
        } else {
          res["429"] = R429;
        }
        res["503"] = R503;
      }
      if (resolve || catalog) {
        const ok = res["200"];
        if (ok) ok.headers = { ...ok.headers, ...quotaHeaders };
      }
      if (resolve) {
        op.description = `${op.description ?? ""}\n\nCosts quota units. Anonymous callers must send \`X-Captcha-Token\` (web app only); scripts use an API key.`.trim();
      }
      if (path === "/catalog" || path.startsWith("/catalog/")) {
        op.description = `${op.description ?? ""}\n\nCatalog reads are open. A live refresh (\`force_refresh=true\`) requires sign-in and costs units.`.trim();
      }
    }
  }
  return { paths, schemas };
}

const authOps: Json = {
  "/auth/sign-in/social": {
    post: {
      tags: ["auth"],
      summary: "Start sign-in with GitHub or ORCID",
      description: "Better Auth. Returns the provider URL to redirect to; the provider returns to `/auth/callback/{provider}`.",
      operationId: "signInSocial",
      requestBody: jsonBody({
        type: "object",
        required: ["provider"],
        properties: {
          provider: { type: "string", enum: ["github", "orcid"] },
          callbackURL: { type: "string" },
          errorCallbackURL: { type: "string" },
          disableRedirect: { type: "boolean" },
        },
      }),
      responses: {
        "200": jsonResponse("Provider URL.", { type: "object", properties: { url: { type: "string" }, redirect: { type: "boolean" } } }),
        "429": R429,
      },
    },
  },
  "/auth/callback/{provider}": {
    get: {
      tags: ["auth"],
      summary: "OAuth callback",
      description: "Better Auth. Called by the provider; sets the session cookie and redirects.",
      operationId: "authCallback",
      parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string", enum: ["github", "orcid"] } }],
      responses: { "302": { description: "Redirect to the app." } },
    },
  },
  "/auth/sign-out": {
    post: {
      tags: ["auth"],
      summary: "Sign out",
      operationId: "signOut",
      security: [{ sessionCookie: [] }],
      responses: { "200": jsonResponse("Signed out.", { type: "object", properties: { success: { type: "boolean" } } }) },
    },
  },
  "/auth/get-session": {
    get: {
      tags: ["auth"],
      summary: "Current session",
      description: "Returns the session and user, or `null` without a session.",
      operationId: "getSession",
      security: [{ sessionCookie: [] }, {}],
      responses: {
        "200": jsonResponse("Session or null.", {
          oneOf: [
            { type: "null" },
            { type: "object", properties: { session: { type: "object", additionalProperties: true }, user: { type: "object", additionalProperties: true } } },
          ],
        }),
      },
    },
  },
  "/auth/list-accounts": {
    get: {
      tags: ["auth"],
      summary: "Linked sign-in providers",
      operationId: "listAccounts",
      security: [{ sessionCookie: [] }],
      responses: {
        "200": jsonResponse("Linked accounts.", {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" }, providerId: { type: "string" }, accountId: { type: "string" } }, additionalProperties: true },
        }),
        "401": R401,
      },
    },
  },
  "/auth/link-social": {
    post: {
      tags: ["auth"],
      summary: "Link another provider to the signed-in account",
      operationId: "linkSocial",
      security: [{ sessionCookie: [] }],
      requestBody: jsonBody({
        type: "object",
        required: ["provider"],
        properties: { provider: { type: "string", enum: ["github", "orcid"] }, callbackURL: { type: "string" } },
      }),
      responses: {
        "200": jsonResponse("Provider URL.", { type: "object", properties: { url: { type: "string" }, redirect: { type: "boolean" } } }),
        "401": R401,
      },
    },
  },
  "/auth/unlink-account": {
    post: {
      tags: ["auth"],
      summary: "Unlink a provider",
      description: "Fails if it would remove the last sign-in method.",
      operationId: "unlinkAccount",
      security: [{ sessionCookie: [] }],
      requestBody: jsonBody({
        type: "object",
        required: ["providerId"],
        properties: { providerId: { type: "string" }, accountId: { type: "string" } },
      }),
      responses: {
        "200": jsonResponse("Unlinked.", { type: "object", properties: { status: { type: "boolean" } } }),
        "400": errorResponse("Cannot unlink the last account."),
        "401": R401,
      },
    },
  },
};

const apiKeySummary = {
  type: "object",
  required: ["id", "name", "start", "prefix", "createdAt"],
  properties: {
    id: { type: "string" },
    name: { type: ["string", "null"] },
    start: { type: ["string", "null"], description: "First characters of the key, for recognition." },
    prefix: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
  },
};

const ownOps: Json = {
  "/health": {
    get: {
      tags: ["gateway"],
      summary: "Liveness",
      operationId: "health",
      security: [{}],
      responses: { "200": jsonResponse("Alive.", { type: "object", properties: { status: { type: "string", enum: ["ok"] } } }), "429": R429 },
    },
  },
  "/keys": {
    post: {
      tags: ["keys"],
      summary: "Create an API key",
      description: "Signed-in (non-anonymous) session only. The secret `key` is returned once.",
      operationId: "createApiKey",
      security: [{ sessionCookie: [] }],
      requestBody: jsonBody({ type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 32 } } }),
      responses: {
        "201": jsonResponse("Created.", { allOf: [apiKeySummary, { type: "object", required: ["key"], properties: { key: { type: "string" } } }] }),
        "400": errorResponse("Invalid name."),
        "401": R401,
        "403": R403,
      },
    },
    get: {
      tags: ["keys"],
      summary: "List the caller's API keys",
      operationId: "listApiKeys",
      security: [{ sessionCookie: [] }],
      responses: {
        "200": jsonResponse("Keys (never the secret).", { type: "object", required: ["keys"], properties: { keys: { type: "array", items: apiKeySummary } } }),
        "401": R401,
        "403": R403,
      },
    },
  },
  "/keys/{id}": {
    delete: {
      tags: ["keys"],
      summary: "Revoke an API key",
      operationId: "revokeApiKey",
      security: [{ sessionCookie: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": jsonResponse("Revoked.", { type: "object", properties: { success: { type: "boolean" } } }),
        "401": R401,
        "403": R403,
        "404": errorResponse("API key not found."),
      },
    },
  },
  "/usage": {
    get: {
      tags: ["gateway"],
      summary: "The caller's quota",
      description: "For a session (anonymous or signed in) or an API key. Read-only, costs nothing, creates no identity.",
      operationId: "usage",
      security: identity,
      responses: {
        "200": jsonResponse("Usage today.", ref("Usage")),
        "401": R401,
        "429": R429,
      },
    },
  },
};

const usageSchema = {
  type: "object",
  required: ["tier", "quota", "used", "remaining", "resetAt", "secondsUntilReset"],
  properties: {
    tier: { type: "string", enum: ["anonymous", "signed_in"] },
    quota: { type: "integer", description: "Daily units." },
    used: { type: "integer" },
    remaining: { type: "integer" },
    resetAt: { type: "string", format: "date-time", description: "Next 00:00 UTC." },
    secondsUntilReset: { type: "integer" },
    ip: {
      type: "object",
      description: "Anonymous callers only: the cap shared by all anonymous users at their IP.",
      required: ["quota", "used", "remaining"],
      properties: { quota: { type: "integer" }, used: { type: "integer" }, remaining: { type: "integer" } },
    },
  },
};

/** Paths of the docs routes, relative to `/api`. */
export const OPENAPI_PATH = "/api/openapi.json";
export const SCALAR_PATH = "/api/scalar";

export function buildOpenApi(): Json {
  const { paths, schemas } = forwarded();
  return {
    openapi: "3.1.0",
    info: {
      title: "QRB API",
      version: (qrbApi as Json).info?.version ?? "0.1.0",
      description:
        "Public API of the Quantum Resource Broker. Call `POST /select` and `POST /instance` with an API key (`x-api-key`); " +
        "the web app uses a session cookie. Errors are `{\"detail\": string}`. Counted requests carry `X-Quota-*` headers; 429 carries `Retry-After`.",
    },
    servers: [{ url: "/api" }],
    tags: [
      { name: "auth", description: "Sign-in (Better Auth), summary of the endpoints the web app uses." },
      { name: "keys", description: "API keys for signed-in users." },
      { name: "gateway", description: "Gateway-owned routes." },
    ],
    paths: { ...ownOps, ...authOps, ...paths },
    components: {
      schemas: {
        ...schemas,
        Error: { type: "object", required: ["detail"], properties: { detail: { type: "string" } } },
        Usage: usageSchema,
      },
      parameters: {
        CaptchaToken: {
          name: "X-Captcha-Token",
          in: "header",
          required: false,
          description: "Turnstile token; lets an anonymous web-app request through. Scripts use an API key instead.",
          schema: { type: "string" },
        },
      },
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "Session cookie set by sign-in." },
        apiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "API key created at /account." },
        captchaToken: { type: "apiKey", in: "header", name: "X-Captcha-Token", description: "Turnstile token for anonymous web-app resolves." },
      },
    },
  };
}

export function scalarHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>QRB API reference</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="${OPENAPI_PATH}"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;
}
