# history-persistence Specification

## Purpose

Optionally records produced bindings and catalog telemetry in Postgres for
later research analysis, without ever making selection depend on a database.

## Requirements

### Requirement: Persistence is optional
When `DATABASE_URL` is not set, recording bindings and telemetry SHALL do nothing and SHALL NOT raise. A warning SHALL be logged once per process, shared by binding and telemetry recording.

#### Scenario: No database configured
- **WHEN** a binding is recorded twice in a process without `DATABASE_URL`
- **THEN** nothing is stored, no error is raised, and one warning is logged

#### Scenario: Warning shared across record kinds
- **WHEN** a binding and then a telemetry sample are recorded in one process without `DATABASE_URL`
- **THEN** only one warning is logged in total

### Requirement: Selection works without a database
The core selection library SHALL NOT depend on the persistence package. Recording SHALL be an explicit step taken by applications after selection.

#### Scenario: Library alone
- **WHEN** the core library performs a selection in a process with no database configured or installed
- **THEN** the selection completes normally

### Requirement: Write failures are swallowed
A failure while writing a binding or telemetry row to a database that was reached (for example an unreachable server or a rejected insert) MUST be logged and MUST NOT propagate to the caller. A database URL that cannot be used at all is excluded and covered by the unusable-URL requirement.

#### Scenario: Database outage
- **WHEN** `DATABASE_URL` is set to a well-formed URL but the database is unreachable while recording a binding
- **THEN** the error is logged and the caller's request still succeeds

### Requirement: Unusable database URL is not swallowed
When `DATABASE_URL` is set but malformed, or its database driver is not installed, recording a binding or telemetry sample MUST raise to the caller instead of being logged and skipped.

#### Scenario: Malformed URL on selection
- **WHEN** `DATABASE_URL` is set to a malformed value and a client calls the API selection endpoint
- **THEN** the solve succeeds but recording raises, so the request fails with HTTP 500 after the solve already completed

### Requirement: Binding log contents
Each recorded binding SHALL store: time of recording, source entrypoint, task id, resolved preferences (weights, constraints, required provider, Pareto flag), feasibility, engine id, engine execution time, all returned solutions, and every candidate in the instance with its features (not just the winner).

#### Scenario: Candidates stored
- **WHEN** a selection with 12 candidates is recorded
- **THEN** its row contains all 12 candidates with their features

### Requirement: Only the API records bindings
The HTTP API selection endpoint SHALL record one binding with source `api` after the response is computed; the instance-building endpoint and the CLI MUST NOT record anything.

#### Scenario: API selection is recorded
- **WHEN** a client calls the API selection endpoint with a database configured
- **THEN** one row is stored with source `api`

#### Scenario: Other entrypoints store nothing
- **WHEN** a client calls the instance-building endpoint or runs the CLI with a database configured
- **THEN** no binding row is stored

### Requirement: Telemetry row contents
Each telemetry sample SHALL store one row per resource with: sample time (shared by all rows of one sample), resource id, provider id, vendor, qubit count, queue length, status, operational flag and last calibration time.

#### Scenario: One sample
- **WHEN** a telemetry sample of 12 resources is recorded
- **THEN** 12 rows are stored with the same sample time

### Requirement: Query indexes
The binding log table SHALL be indexed on recording time and source; the catalog telemetry table SHALL be indexed on sample time, resource id and provider id.

#### Scenario: Indexes exist
- **WHEN** migrations are applied to an empty database
- **THEN** those columns are indexed on the respective tables

### Requirement: Schema managed by migrations
The database schema SHALL be created by migrations that create the binding log and catalog telemetry tables.

#### Scenario: Fresh database
- **WHEN** migrations are applied to an empty database
- **THEN** the binding log and catalog telemetry tables exist

### Requirement: Migrations require a database URL
Running migrations MUST fail when `DATABASE_URL` is not set.

#### Scenario: Migrations without a database URL
- **WHEN** migrations are run without `DATABASE_URL`
- **THEN** they fail with an error stating `DATABASE_URL` must be set
