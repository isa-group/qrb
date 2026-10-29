# Spec Delta

## Purpose

A web frontend for browsing the resource catalog and interactively declaring
preferences, resolving a binding through the HTTP API, and inspecting the
result.

## ADDED Requirements

### Requirement: Mock catalog by default
The catalog views SHALL use built-in mock data unless `NEXT_PUBLIC_USE_MOCK_CATALOG` is `false`, in which case they SHALL read from the HTTP API at `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:8000`).

#### Scenario: Default build
- **WHEN** the web app runs with no catalog environment settings
- **THEN** the catalog shows mock resources and makes no API calls for the catalog

### Requirement: Catalog polling
The catalog SHALL refresh in the background every `NEXT_PUBLIC_CATALOG_POLL_INTERVAL_MS` milliseconds (default 10 minutes).

#### Scenario: Default interval
- **WHEN** the poll interval setting is not set
- **THEN** the catalog is re-requested every 10 minutes

### Requirement: Queue history
The catalog SHALL keep, per resource, the 20 most recent queue lengths observed during the session and show them as a sparkline.

#### Scenario: Queue history
- **WHEN** 25 queue-length observations have been recorded for a resource in one session
- **THEN** its sparkline shows the last 20, and with fewer than two it shows a "gathering telemetry" note instead

### Requirement: Manual live refresh
The catalog and playground pages SHALL offer a "Fetch live" action that requests the catalog with `force_refresh` set, bypassing the server cache.

#### Scenario: Manual live refresh
- **WHEN** the user presses "Fetch live" and the API catalog is in use
- **THEN** the catalog is requested with `force_refresh` set and the new data replaces what is shown

### Requirement: Resource detail
The catalog SHALL offer a detail view per resource showing its catalog fields and calibration summary.

#### Scenario: Open detail
- **WHEN** a user opens a resource from the catalog
- **THEN** its native gates and median T1, T2 and error rates are shown, or marked unknown

### Requirement: Playground form validation
The playground SHALL NOT submit unless it has a non-empty circuit, shots between 1 and 1,000,000, at least one weighted criterion, weights summing to 1 (within 0.0001), and, in Pareto mode, at least three criteria.

#### Scenario: Empty circuit
- **WHEN** the circuit is empty
- **THEN** the form shows "Circuit is required" and does not submit

#### Scenario: Shots out of range
- **WHEN** shots is 0 or above 1,000,000
- **THEN** the form does not submit

#### Scenario: No criteria or weights off
- **WHEN** no criterion is weighted, or the weights do not sum to 1 within 0.0001
- **THEN** the form shows "Pick at least one criterion" or "Weights must sum to 1" and does not submit

#### Scenario: Pareto with two criteria
- **WHEN** Pareto mode is on with two weighted criteria
- **THEN** the form shows that Pareto mode needs at least 3 criteria and does not submit

### Requirement: Weight sliders stay normalized
Moving one weight slider SHALL rescale the other weights proportionally so the total stays 1.

#### Scenario: Move a slider
- **WHEN** weights are 0.5/0.25/0.25 and the first slider moves to 0.8
- **THEN** the other two become 0.1 each

### Requirement: Fetch live catalog toggle
The playground SHALL offer a "Fetch live catalog" toggle, on by default, whose value is sent as `force_refresh` with the resolve request.

#### Scenario: Default on
- **WHEN** the playground loads
- **THEN** the toggle is on and a resolve sends `force_refresh: true`

### Requirement: Engine picker follows objective type
The playground SHALL offer, besides automatic selection, only engines that support the current objective type (MONO, or MANY in Pareto mode), and SHALL send the chosen engine as `engine_id` (null for automatic).

#### Scenario: Switch to Pareto
- **WHEN** an engine supporting only MONO is selected and Pareto mode is turned on
- **THEN** the engine is reset to automatic and only MANY-capable engines are listed

### Requirement: Presets
Presets returned by `GET /presets` (built-ins plus any user presets on the API host) SHALL be treated as built-in and loaded regardless of the mock-catalog setting. User presets SHALL be stored only in the browser's local storage, never sent to the server and separate from the CLI's presets file; a user preset with a built-in's name overrides it.

#### Scenario: Save a preset
- **WHEN** the user saves a preset
- **THEN** it is kept in local storage and no request carries it to the API

#### Scenario: Built-in presets in mock mode
- **WHEN** the mock catalog is on
- **THEN** presets are still requested from the API, and the list is empty if the API is unreachable

#### Scenario: Name clash
- **WHEN** a user preset has the same name as a built-in
- **THEN** the user preset is the one listed and applied

### Requirement: Reference catalog feasibility filter
The playground's reference catalog SHALL list only resources with at least as many qubits as the circuit declares (all resources if no width is found) and that match the selected provider. Declared constraints SHALL NOT filter it; they are evaluated by the API on resolve.

#### Scenario: Circuit too wide
- **WHEN** the circuit declares 20 qubits
- **THEN** resources with fewer than 20 qubits are not listed

#### Scenario: Queue constraint does not filter
- **WHEN** a constraint `queue <= 10` is added
- **THEN** resources with more than 10 queued jobs remain listed until the binding is resolved

### Requirement: Resolve through the API
Resolving SHALL always call `POST /select` with the form values, even when the mock catalog is enabled, then `POST /instance` for an optional instance viewer. The result SHALL be shown as success (one solution as a winner card, several as a comparison table), infeasible, a validation error (HTTP 422, shown beside the circuit editor), or unavailable (API unreachable or other error).

#### Scenario: Mock catalog enabled
- **WHEN** the mock catalog is on and the user resolves
- **THEN** the request still goes to the API and the result reflects the API's catalog

#### Scenario: API not running
- **WHEN** the user resolves and the API cannot be reached
- **THEN** the playground says a running QRB API is required

#### Scenario: Instance may use a different catalog
- **WHEN** the "Fetch live catalog" toggle is on and the user resolves
- **THEN** `/instance` is sent with the same `force_refresh` as `/select`, so it fetches the catalog live again and the instance shown may be built from a different catalog than the one solved

#### Scenario: Instance request fails
- **WHEN** `/select` succeeds but `/instance` fails
- **THEN** the binding result is still shown, without the instance viewer
