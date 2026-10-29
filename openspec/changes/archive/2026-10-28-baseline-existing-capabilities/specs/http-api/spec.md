# Spec Delta

## Purpose

An HTTP API that exposes the same selection, instance, catalog, engine and
preset operations as the CLI, as JSON, for the web app and other clients.

## ADDED Requirements

### Requirement: Response envelope
The JSON data endpoints (`/select`, `/instance`, `/catalog`, `/catalog/{candidate_id}`, `/engines`, `/presets`) SHALL respond on success with `{result, timings_ms}`, where `timings_ms` always includes `request_total_ms`, the full request duration in milliseconds. Errors SHALL be a JSON body with a `detail` field.

#### Scenario: Presets envelope
- **WHEN** `GET /presets` is called
- **THEN** the response has `result` and `timings_ms.request_total_ms`

### Requirement: Health
`GET /health` SHALL return `{"status": "ok"}`.

#### Scenario: Health check
- **WHEN** `GET /health` is called
- **THEN** the response is `{"status": "ok"}` with status 200

### Requirement: Select endpoint
`POST /select` SHALL take `circuit_qasm`, optional `preferences` (preset, weights, constraints, require_provider, pareto), `shots` (1024), `live` (true), `snapshot_path`, `providers`, `engine_id` and `force_refresh` (true), and return the solve response plus phase timings. Preferences SHALL be resolved as defined by the preferences-and-presets capability.

#### Scenario: Successful select
- **WHEN** `POST /select` is called with a valid circuit and preset `balanced`
- **THEN** the result is the solve response and `timings_ms` contains the phase timings and request duration

### Requirement: Select records the binding
After a successful `POST /select`, the API SHALL record the binding with source `api`, subject to history-persistence rules.

#### Scenario: Recording without database
- **WHEN** `POST /select` succeeds and no database is configured
- **THEN** the response is returned normally and nothing is stored

#### Scenario: Recording insert fails
- **WHEN** `POST /select` succeeds and the database insert raises
- **THEN** the error is logged and the select response is still returned with status 200

### Requirement: Instance endpoint
`POST /instance` SHALL take the same body as `/select` minus `engine_id`, and return the BIM instance plus phase timings without solving.

#### Scenario: Instance only
- **WHEN** `POST /instance` is called with a valid circuit
- **THEN** the BIM instance is returned and the solver is not contacted

### Requirement: Unparseable circuit error
An unparseable circuit on `POST /select` or `POST /instance` SHALL return 422 with a non-empty `detail`.

#### Scenario: Syntax error in circuit
- **WHEN** `POST /select` is sent with invalid OpenQASM 3
- **THEN** the response is 422 with a non-empty `detail`

### Requirement: Request validation error
A request body that fails validation SHALL return 422.

#### Scenario: Missing circuit
- **WHEN** `POST /select` is sent without `circuit_qasm`
- **THEN** the response is 422

### Requirement: Instance-build and solve failure error
Any failure while building the instance (including local ones such as an unknown provider id or a missing or unreadable snapshot file) or while solving SHALL return 502 with the error message in `detail`.

#### Scenario: Solver down
- **WHEN** OpenBinding cannot be reached during `POST /select`
- **THEN** the response is 502 with the error message

#### Scenario: Local build error
- **WHEN** `POST /instance` is sent with `providers: ["zzz"]` or a `snapshot_path` that does not exist
- **THEN** the response is 502 with the underlying error message

### Requirement: Unknown preset error
A `preferences.preset` that names no built-in or user preset SHALL return 500, not a 4xx.

#### Scenario: Unknown preset
- **WHEN** `POST /select` is sent with `preferences.preset` naming no built-in or user preset
- **THEN** the response is 500

### Requirement: Snapshot path trust
`POST /select` and `POST /instance` SHALL accept any server-side file path in `snapshot_path` with no restriction, and SHALL echo the underlying parse or read error message in the 502 `detail`. This records current behavior.

#### Scenario: Arbitrary file as snapshot
- **WHEN** `POST /instance` is sent with `live: false` and a `snapshot_path` naming an existing file that is not a catalog snapshot
- **THEN** the file is read and the response is 502 with the parse error in `detail`

### Requirement: Circuit source path trust
`POST /select` and `POST /instance` SHALL read `circuit_qasm` from the server-side file when its value names an existing file, instead of treating it as QASM text. A file that is not valid QASM SHALL yield 422, which reveals that the file exists. This records current behavior.

#### Scenario: Existing non-QASM path as circuit
- **WHEN** `POST /instance` is sent with `circuit_qasm` set to the path of an existing server-side file that is not QASM
- **THEN** the file is read and the response is 422 with the parse error in `detail`

### Requirement: Catalog endpoints
`GET /catalog` SHALL return each resource's candidate id, name, provider, vendor, qubits, queue, status, operational flag and last calibration time, filterable by repeatable `provider`. It SHALL accept `live` (default true), use the cache unless `force_refresh=true`, report cache hit and fetch time, and return 502 if the fetch fails.

#### Scenario: Cached catalog
- **WHEN** `GET /catalog` is called twice within the cache window
- **THEN** the second response reports `catalog_cache_hit: true`

#### Scenario: Snapshot catalog
- **WHEN** `GET /catalog?live=false` is called
- **THEN** records are read from the file `catalog_snapshot.json` in the server's working directory, `catalog_cache_hit` and `catalog_fetched_at` are null, and a missing file yields 502

### Requirement: Catalog detail endpoint
`GET /catalog/{candidate_id}` SHALL return the catalog fields plus the calibration summary (native gates, median T1, T2, one- and two-qubit gate error, readout error), or 404 for an unknown candidate id. It SHALL accept `live` and `force_refresh` like `/catalog`, but no `provider` filter or snapshot path.

#### Scenario: Unknown resource
- **WHEN** `GET /catalog/ibm.nope` is called
- **THEN** the response is 404 with detail `Unknown candidate_id 'ibm.nope'`

### Requirement: Engines endpoint
`GET /engines` SHALL return OpenBinding's engines in the envelope. It SHALL NOT map OpenBinding failures to 502; they yield 500.

#### Scenario: Engines unreachable
- **WHEN** `GET /engines` is called and OpenBinding cannot be reached
- **THEN** the response is 500, not 502

### Requirement: Presets endpoint
`GET /presets` SHALL return a map from name to every built-in and user preset's weights and constraints (feature, op string, value).

#### Scenario: Presets listed
- **WHEN** `GET /presets` is called
- **THEN** `result` contains at least the seven built-in presets

### Requirement: Constraint operators
Request constraints SHALL be `{feature, op, value}` where `op` is one of `<=`, `>=`, `==`, `<`, `>` or `IN_RANGE`; any other op fails validation with 422.

#### Scenario: Unknown operator
- **WHEN** `POST /select` is sent with a constraint op of `~`
- **THEN** the response is 422

#### Scenario: IN_RANGE accepted
- **WHEN** `POST /select` is sent with a constraint op of `IN_RANGE`
- **THEN** request validation accepts it and forwards it to the solver, which may reject it (surfacing as 502)

### Requirement: Startup warm-up
On startup, the API SHALL fetch the live catalog before accepting requests. If this fails, it SHALL log the error and start anyway.

#### Scenario: Warm-up fails
- **WHEN** providers are unreachable at startup
- **THEN** the error is logged and the API still starts serving

### Requirement: Cross-origin access
The API SHALL allow cross-origin requests from the comma-separated origins in `WEB_ORIGINS`, defaulting to `http://localhost:3000` and `http://localhost:3002`.

#### Scenario: Default origin
- **WHEN** a browser at `http://localhost:3000` calls the API with no `WEB_ORIGINS` set
- **THEN** the request is allowed

### Requirement: API reference
The API SHALL publish its OpenAPI schema and serve an interactive reference page at `/scalar`.

#### Scenario: Docs page
- **WHEN** `/scalar` is opened in a browser
- **THEN** the API reference is shown

### Requirement: Environment file loading
The API SHALL load settings from a `.env` file found by searching upward from the installed API package (the repo root in a workspace install), not from the working directory. Variables already set in the environment SHALL take precedence over the file.

#### Scenario: Variable set in both
- **WHEN** `WEB_ORIGINS` is set in the process environment and also in the `.env` file
- **THEN** the environment value is used
