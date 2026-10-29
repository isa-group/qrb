# Spec Delta

## MODIFIED Requirements

### Requirement: Snapshot path trust
Public `POST /select` and `POST /instance` requests SHALL NOT accept `snapshot_path`. A request that sets it SHALL return 422 with a `detail` saying the field is not accepted, and no file SHALL be read. `live: false` SHALL read only the snapshot configured on the server.

#### Scenario: Arbitrary file as snapshot
- **WHEN** `POST /instance` is sent with `live: false` and a `snapshot_path` naming an existing file that is not a catalog snapshot
- **THEN** the response is 422, the file is not read, and the `detail` does not reveal whether the file exists

#### Scenario: Server snapshot
- **WHEN** `POST /instance` is sent with `live: false` and no `snapshot_path`
- **THEN** the instance is built from the snapshot configured on the server

### Requirement: Circuit source path trust
`POST /select` and `POST /instance` SHALL always parse `circuit_qasm` as OpenQASM 3 source text and MUST NOT read it from a file, even when its value names an existing server-side file.

#### Scenario: Existing non-QASM path as circuit
- **WHEN** `POST /instance` is sent with `circuit_qasm` set to the path of an existing server-side file
- **THEN** the value is parsed as QASM text, the file is not read, and the response is 422 with a parse error that is the same as for any other invalid text

### Requirement: Cross-origin access
The public API SHALL allow credentialed cross-origin requests (cookies included) only from the comma-separated origins in `WEB_ORIGINS`, defaulting to `http://localhost:3000` and `http://localhost:3002`. Other origins SHALL NOT receive credentialed access.

#### Scenario: Default origin
- **WHEN** a browser at `http://localhost:3000` calls the API with its session cookie and no `WEB_ORIGINS` set
- **THEN** the request is allowed and the cookie is accepted

#### Scenario: Unlisted origin
- **WHEN** a browser at an origin not in `WEB_ORIGINS` calls `POST /select` with a session cookie
- **THEN** the browser is not granted credentialed access to the response

### Requirement: API reference
The public API SHALL publish one OpenAPI schema at `/api/openapi.json`, covering the forwarded QRB routes and the gateway's own auth, API-key and usage routes, and SHALL serve an interactive reference page at `/api/scalar`. Both SHALL be open routes.

#### Scenario: Docs page
- **WHEN** `/api/scalar` is opened in a browser
- **THEN** the API reference is shown

#### Scenario: Schema
- **WHEN** `GET /api/openapi.json` is called without any identity
- **THEN** an OpenAPI 3 document is returned that includes `/select`, `/keys` and `/usage`, and no identity is created
