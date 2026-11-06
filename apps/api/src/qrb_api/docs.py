"""Human-written OpenAPI content: the Quickstart (info.description), tags, and each operation's
summary, description and documented errors. Rendered by Scalar on the API's /scalar page and on
the website's /docs. Request and response examples are attached by the website's export script,
from its saved fixtures (apps/web/scripts/export-openapi.sh)."""

DESCRIPTION = """
QRB binds a quantum circuit to the IBM Quantum or Amazon Braket QPU that is optimal for the
preferences you declare. You send an OpenQASM 3 circuit, weights over QoS features and hard
constraints; QRB builds a Binding Instance Model (BIM) instance from live provider data and the
OpenBinding solver returns the optimal binding, with every candidate and why each one was excluded.

**QRB only selects.** It never submits, queues or runs a circuit on any QPU, and it incurs no
provider charges.

## Quickstart

No sign-in is needed. Set `QRB_API` to the API's base URL and bind the 3 qubit GHZ circuit:

```sh
curl -sS -X POST "${QRB_API:-http://localhost:8000}/select" \\
  -H "Content-Type: application/json" \\
  --data-binary @- <<'JSON'
{
  "circuit_qasm": "OPENQASM 3.0;\\ninclude \\"stdgates.inc\\";\\nqubit[3] q;\\nbit[3] c;\\nh q[0];\\ncx q[0], q[1];\\ncx q[1], q[2];\\nc = measure q;\\n",
  "preferences": {
    "weights": {"expected_fidelity": 0.5, "cost": 0.3, "queue": 0.2},
    "constraints": [{"feature": "operational", "op": ">=", "value": 1}]
  },
  "shots": 1024
}
JSON
```

## Reading the answer

- `result.solutions[0].binding.task` is the chosen QPU (its candidate id, e.g. `ibm.ibm_aachen`).
  With `"pareto": true` there is one solution per non-dominated binding.
- `candidates` lists every QPU considered, with its features for your circuit. `selected` marks the
  binding; `violated_constraints` says which hard constraint excluded a QPU and the value it had.
- `source` says which data answered: `mode` is `live` or `snapshot`, `as_of` is when that data was
  fetched (or captured), and `cache_hit` is true when the request used stored data instead of asking
  the providers itself.
- `result.feasibility` is `INFEASIBLE` when no QPU meets every constraint; `candidates` still says
  what each one broke.

## Access and limits

Every endpoint works without an account. Requests without a key share a daily budget per IP
address. For a budget of your own, [sign in](/signin) with GitHub or ORCID and create your API key
on the [Account page](/account) (one key per account; revoke it to replace it), then send it in the
`x-api-key` header. The Account page also shows your last 30 days of requests and binds.

- **Cost.** `POST /select` and `POST /instance` cost 1 unit on the stored catalog (the default), or 5
  with `"force_refresh": true`, which asks the providers now. Catalog reads are free, and cost 5 with
  `force_refresh=true`. Presets, engines and health are free.
- **Daily budget.** 50 units per IP address without a key, 200 per account with a key (shared by
  all of its keys). Budgets reset at 00:00 UTC.
- **Headers.** Every counted response carries `X-Quota-Limit`, `X-Quota-Remaining` and
  `X-Quota-Reset` (Unix seconds). `GET /usage` reports the same figures and costs nothing.
- **Errors.** `429` when a budget or a rate limit is reached: `detail` names the limit and
  `Retry-After` says how many seconds to wait. `401` for an unknown, revoked or expired key; `413`
  for a body over 1 MiB.

### Async binds

A bind with `"force_refresh": true` waits tens of seconds on the providers. If your HTTP client or a
proxy would not hold the call open that long, send the same body to `POST /api/binds` with your API
key instead. It answers `202` at once with `{"id": ..., "status": "pending"}` and a `Location`
header. Poll `GET /api/binds/{id}` (free, honour `Retry-After`) until `status` is `done`, when
`result` holds exactly what `POST /select` would have returned, or `failed`, with an `error`.

```sh
curl -sS -X POST "$QRB_API/binds" -H "x-api-key: $QRB_KEY" \\
  -H "Content-Type: application/json" --data-binary @bind.json   # {"id": "…", "status": "pending"}
curl -sS "$QRB_API/binds/<id>" -H "x-api-key: $QRB_KEY"
```

- Served by the public gateway (`/api/binds`); a local API without the gateway has only `/select`.
- Accounts only (an API key or a signed-in session). Without a key, use `POST /select`.
- Charged like `POST /select` when accepted. A bind that fails because the API or a provider failed
  is refunded; an invalid request (for example QASM that does not parse) keeps its charge.
- At most 5 binds pending per account (`429` beyond that). Async binds appear on the Account page
  with the others and are kept 30 days.

## Data

Every request uses live provider data by default (`live: true`), kept current by QRB at two speeds:
every QPU's queue length and status every 2 minutes, IBM's calibration (the Target and its error
rates) every 10 minutes, and every other QPU's every 30 minutes, or as soon as a Braket device
reports a recalibration. Binds and
catalog reads use the newest of both, so they answer in about a second; `source.as_of` says when
the queue data was fetched. Send `"force_refresh": true` (or `?force_refresh=true`) to ask the
providers now instead, which takes tens of seconds and refreshes the stored data for everyone. If
the stored queues are ever more than 15 minutes old, the next request fetches them live; if no QPU's
calibration has been confirmed for 2 hours, it fetches everything. `live: false` answers from the frozen catalog
snapshot of 12 QPUs captured on 2026-07-11, the data behind the ICSOC 2026 paper.

Weights are proportional: QRB normalises each feature to 0..1 across the candidates before applying
them. Features: `expected_fidelity`, `estimated_success_probability`, `cost` (USD), `queue`
(pending jobs), `critical_depth`, `num_qubits`, `calibration_age_hours`, and the yes/no
`operational` and `depth_feasible`. Constraint operators: `<=`, `>=`, `==`, `<`, `>`.
"""

TAGS = [
    {"name": "Selection", "description": "Bind a circuit to a QPU, or build the instance the solver would receive."},
    {"name": "Catalog", "description": "The QPUs QRB can bind to, with their calibration and qubit topology."},
    {"name": "Service", "description": "Health of the API itself."},
]

_PROVIDER_502 = {"description": "Provider data is unavailable (no credentials, or a provider is down). Live requests never fall back to the snapshot."}
_422 = {"description": "The request is invalid: the circuit does not parse, or a field has the wrong shape. `detail` says what failed."}
_404 = {"description": "No QPU with that candidate id is in the catalog. `detail` names it."}
_401 = {"description": "The `x-api-key` header holds an unknown, revoked or expired key. Requests without the header are not refused."}
_429 = {
    "description": "A daily budget or a rate limit is reached. `detail` names the limit; `Retry-After` gives the seconds to wait.",
    "headers": {"Retry-After": {"description": "Seconds to wait before retrying.", "schema": {"type": "integer"}}},
}
_413 = {"description": "The request body is over 1 MiB."}

ROUTES = {
    "health": dict(
        tags=["Service"],
        summary="Check the API",
        description="Returns `{\"status\": \"ok\"}` when the API process is up. It does not contact any provider.",
    ),
    "select": dict(
        tags=["Selection"],
        summary="Bind a circuit",
        description=(
            "Transpiles the circuit for every candidate QPU, computes its features, builds the BIM instance from your "
            "preferences and solves it with OpenBinding. Returns the binding, every candidate with its features and the "
            "constraint that excluded it, the data source and phase timings.\n\n"
            "Use `preferences.preset` for a named preset (see `GET /presets`), or `weights` and `constraints` directly. "
            "`require_provider` limits candidates to `ibm` or `braket`; `pareto: true` returns every non-dominated binding "
            "(the `many-heuristic` engine) instead of one optimum (`minizinc-csp`). `shots` only feeds the cost estimate.\n\n"
            "Latency: about a second by default, on stored data, queues refreshed every 2 minutes (plus transpilation on "
            "large circuits). `\"force_refresh\": true` asks the providers now: tens of seconds."
        ),
        responses={401: _401, 413: _413, 422: _422, 429: _429, 502: _PROVIDER_502},
    ),
    "instance": dict(
        tags=["Selection"],
        summary="Build the BIM instance",
        description=(
            "Everything `POST /select` does before solving: returns the Binding Instance Model the solver would receive, "
            "with the providers, candidates and their features, the constraints and the objective. Useful to inspect "
            "features or to send the instance to OpenBinding yourself."
        ),
        responses={401: _401, 413: _413, 422: _422, 429: _429, 502: _PROVIDER_502},
    ),
    "catalog": dict(
        tags=["Catalog"],
        summary="List the catalog",
        description=(
            "Every QPU QRB can bind to, with its provider, vendor, qubits, queue, status, calibration time and the device "
            "medians of two-qubit and readout error. From the stored catalog by default (queues every 2 minutes) (`force_refresh=true` fetches now); `live=false` lists the "
            "frozen snapshot; `provider` filters (`ibm`, `braket`)."
        ),
        responses={401: _401, 429: _429, 502: _PROVIDER_502},
    ),
    "catalog_detail": dict(
        tags=["Catalog"],
        summary="Get one QPU",
        description=(
            "One catalog entry plus its calibration summary: native gates and the device medians of T1, T2, one- and "
            "two-qubit gate error and readout error. A median is `null` where the provider reports none (IBM reports no "
            "T1/T2 in the snapshot)."
        ),
        responses={401: _401, 404: _404, 429: _429, 502: _PROVIDER_502},
    ),
    "catalog_topology": dict(
        tags=["Catalog"],
        summary="Get a QPU's topology and calibration",
        description=(
            "The coupling map with every per-qubit and per-coupler calibration value the provider reports (described by "
            "`qubit_fields` and `coupler_fields`: id, label, unit, which direction is better), their device medians, "
            "device-wide figures for providers without per-qubit data (IonQ, AQT), and 2D coordinates to draw the map. "
            "IBM's extra qubit fields (anharmonicity, readout length, assignment errors) are live only. The layout is "
            "computed once per device and coupling map, then cached."
        ),
        responses={401: _401, 404: _404, 429: _429, 502: _PROVIDER_502},
    ),
    "engines": dict(
        tags=["Selection"],
        summary="List solver engines",
        description="The OpenBinding engines available to `POST /select`'s `engine_id`. By default QRB uses `minizinc-csp`, and `many-heuristic` in Pareto mode.",
        responses={502: {"description": "The OpenBinding gateway could not be reached."}},
    ),
    "features": dict(
        tags=["Selection"],
        summary="List features",
        description=(
            "Every feature QRB computes for a candidate, with its unit, direction (whether higher or lower is better), "
            "scale and valid range: the same declarations as the `features` of `POST /instance`, without building one. "
            "The `*_normalized` companions are what the objective weights act on."
        ),
    ),
    "presets": dict(
        tags=["Selection"],
        summary="List preference presets",
        description=(
            "The named presets `preferences.preset` accepts, each with its weights and constraints: `balanced`, "
            "`fidelity-first`, `cheapest`, `fastest`, and the encodings of three approaches from the literature, "
            "`nisq-analyzer`, `q-orchestrator` and `mqt-predictor`."
        ),
    ),
}
