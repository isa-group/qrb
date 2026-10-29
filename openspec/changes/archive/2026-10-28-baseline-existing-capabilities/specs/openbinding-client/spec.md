# Spec Delta

## Purpose

Provides a typed, domain-agnostic client for the OpenBinding QACO solver
gateway, so QRB can send BIM instances and receive bindings without knowing
how the solver works.

## ADDED Requirements

### Requirement: Domain-agnostic models
The client SHALL model the BIM instance (metadata, providers, tasks, candidates, features, composition, aggregation policies, constraints, objective) and the gateway's request and response envelopes, with no quantum-specific concepts.

#### Scenario: Non-quantum instance
- **WHEN** a valid BIM instance about any service domain is built with the client's models
- **THEN** it validates and can be submitted unchanged

### Requirement: Instance validation
The client SHALL reject, before sending, an instance with an empty identifier or one outside `A-Z a-z 0-9 _ . -`, or with no providers, tasks, candidates, features or aggregation policies, or a candidate with no feature values.

#### Scenario: Identifier with a space
- **WHEN** a candidate id `ibm.my device` is used
- **THEN** model validation fails before any request is sent

#### Scenario: Empty provider list
- **WHEN** an instance is built with zero providers
- **THEN** model validation fails before any request is sent

### Requirement: Objective shape rules
A single-weighted (MONO) objective SHALL need at least one target (no upper limit), a multi-objective (MULTI) two or three targets, and a many-objective (MANY) at least three targets. Each also needs a non-empty weights map.

#### Scenario: Pareto with two targets
- **WHEN** a many-objective is built with two targets
- **THEN** validation fails

#### Scenario: Multi-objective with four targets
- **WHEN** a multi-objective is built with four targets
- **THEN** validation fails

### Requirement: Default gateway
The client SHALL default to the gateway at `https://openbinding.score.us.es/api`, with a 30 s HTTP timeout, and SHALL accept another base URL.

#### Scenario: Default base URL
- **WHEN** a client is created without a base URL
- **THEN** its requests go to `https://openbinding.score.us.es/api`

### Requirement: Blocking solve
Solving SHALL submit the instance to the chosen engine and return the result, whether the gateway answers immediately or queues the job. A queued or running job SHALL be polled, by default every 0.5 s, until it completes or fails or a deadline (default 60 s) passes; both values are caller-configurable.

#### Scenario: Queued job completes
- **WHEN** the gateway queues the job and it completes after 3 s
- **THEN** solve returns the completed result

#### Scenario: Timeout
- **WHEN** the job has not finished after 60 s
- **THEN** solve fails with a timeout error naming the job id

#### Scenario: Completed without result
- **WHEN** the gateway reports a job completed but with no result
- **THEN** solve does not return a result; it fails with an error that does not describe the problem

### Requirement: Failed solves raise
A job that finishes with status failed MUST cause solve to fail with the gateway's error message, or a message naming the job id if none is given. HTTP error responses MUST cause the call to fail.

#### Scenario: Failed job
- **WHEN** the gateway reports the job failed with message `bad instance`
- **THEN** solve fails with `bad instance`

#### Scenario: Failed job without message
- **WHEN** the gateway reports the job failed with no or empty message
- **THEN** solve fails with a message naming the job id

#### Scenario: HTTP error
- **WHEN** the gateway answers any call, including a poll, with a 4xx or 5xx status
- **THEN** the call fails with an error that reports the HTTP status

### Requirement: Gateway health
The client SHALL report whether the gateway is healthy, returning true only when the gateway reports status `ok`.

#### Scenario: Healthy gateway
- **WHEN** health is requested and the gateway reports status `ok`
- **THEN** the client returns true

#### Scenario: Unhealthy gateway
- **WHEN** health is requested and the gateway reports any other status
- **THEN** the client returns false

### Requirement: Engine listing
The client SHALL list the gateway's engines, each with its id, capabilities and whether it is active.

#### Scenario: Engine list
- **WHEN** engines are requested
- **THEN** each engine is returned with its id, capabilities and whether it is active

### Requirement: Instance analysis
The client SHALL submit an instance and an engine id for analysis and return the gateway's analysis result.

#### Scenario: Analyze an instance
- **WHEN** an instance is analyzed with a chosen engine
- **THEN** the gateway's analysis result is returned

### Requirement: Binding-space listing
The client SHALL list an instance's binding space page by page, with offset default 0 and limit default 100. Offset and limit SHALL be sent as given, without client-side range checks; the gateway is expected to enforce limit 1-1000 and offset >= 0.

#### Scenario: Default page
- **WHEN** a binding-space page is requested without offset or limit
- **THEN** the request asks for offset 0 and limit 100

#### Scenario: Out-of-range limit
- **WHEN** a binding-space page is requested with limit 5000
- **THEN** the client sends it unchanged and any rejection comes from the gateway as an HTTP error

### Requirement: Job lookup
The client SHALL fetch the current state of a job by its id.

#### Scenario: Look up a job
- **WHEN** a job is requested by id
- **THEN** its current status and, if available, result or error are returned
