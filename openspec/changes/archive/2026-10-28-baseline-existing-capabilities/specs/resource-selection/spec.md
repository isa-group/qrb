# Spec Delta

## Purpose

Turns a circuit, a resource catalog and declared preferences into a Binding
Instance Model (BIM) instance and resolves it through OpenBinding, returning
the optimal resource binding. This is QRB's core QACO mapping.

## ADDED Requirements

### Requirement: Selection only
Selection SHALL return a binding (the chosen resource or resources) and MUST NOT submit the circuit for execution on any provider.

#### Scenario: Selection result
- **WHEN** a selection completes successfully
- **THEN** the caller receives the chosen candidate(s) and their feature values, and no job exists on IBM or Braket

### Requirement: Single-task instance
Each instance SHALL contain exactly one task, and its composition SHALL be that single task.

#### Scenario: One task
- **WHEN** an instance is built from any catalog
- **THEN** it has exactly one task and a composition consisting of that task

### Requirement: One candidate per resource
The instance SHALL contain one candidate per resource left after the provider filter (defined by the preferences-and-presets capability), except resources dropped because compilation failed.

#### Scenario: Three resources
- **WHEN** an instance is built from a catalog of three resources that all compile
- **THEN** it has three candidates, one per resource

### Requirement: Provider list
The instance SHALL list every provider that has a resource left after the provider filter (defined by the preferences-and-presets capability), sorted by id, and SHALL keep a provider listed even if all its resources were dropped because compilation failed.

#### Scenario: Two providers
- **WHEN** an instance is built from a catalog of IBM and Braket resources with no required provider
- **THEN** its providers are `braket` then `ibm`

#### Scenario: Provider whose resources all failed
- **WHEN** every Braket resource fails to compile but an IBM resource compiles
- **THEN** `braket` is still listed among the providers although it has no candidates

### Requirement: Declared features and identity aggregation
The instance SHALL declare every raw feature and every normalized objective feature, each with a sum aggregation policy and neutral value 0, so a candidate's value passes through unchanged.

#### Scenario: Feature declaration
- **WHEN** an instance is built
- **THEN** it declares nine raw features and five `_normalized` features (14 in total), each with sum aggregation

### Requirement: Automatic feasibility constraint
The instance SHALL always include a hard constraint `num_qubits >= <circuit width>` as its first constraint. This SHALL be the only feasibility constraint added automatically (depth feasibility is not enforced unless the user adds a constraint for it); the user's constraints, including those from a preset, follow it in their given order.

#### Scenario: Width constraint
- **WHEN** an instance is built for a 7-qubit circuit with one user constraint
- **THEN** its constraints are `num_qubits >= 7` followed by the user constraint

### Requirement: Too-small resources stay as candidates
Resources too small for the circuit SHALL remain candidates without being compiled, so the solver excludes them through the feasibility constraint. They SHALL get placeholder values for compilation-dependent features (expected fidelity 0, estimated success probability 0, critical depth 1, depth feasible 1); cost, queue, qubit count, operational and calibration age keep their normal values.

#### Scenario: Small device included
- **WHEN** a 5-qubit resource is in the catalog for a 7-qubit circuit
- **THEN** it is a candidate in the instance with expected fidelity 0 and critical depth 1, and is never the returned binding

### Requirement: Uncompilable resources are dropped
Resources whose compilation failed SHALL be left out of the instance and reported with reason `transpile_error`. Their raw feature values still take part in normalization, as defined by the qos-features capability.

#### Scenario: One resource fails
- **WHEN** compilation fails for one of three resources
- **THEN** the instance has two candidates and the failed resource is reported with reason `transpile_error`

### Requirement: No usable candidate
If resources were evaluated but none remains as a candidate, building MUST fail with an error listing every resource's reason and no instance is produced.

#### Scenario: All fail
- **WHEN** compilation fails for every resource
- **THEN** instance building fails with an error listing each candidate and its reason

### Requirement: Empty catalog
If no resource is left after the provider filter, building MUST fail with an error and no instance is produced.

#### Scenario: Empty catalog
- **WHEN** an instance is built from a catalog of only IBM resources with required provider `braket`
- **THEN** building fails with an error and no instance is returned

### Requirement: Default solver engines
The default engine SHALL be `minizinc-csp` (exact, returns the provably optimal feasible binding) for a single weighted objective, and `many-heuristic` when Pareto mode is on. A caller-specified engine SHALL override the default.

#### Scenario: Pareto
- **WHEN** a selection runs with Pareto on and no engine given
- **THEN** it is solved with `many-heuristic`

### Requirement: Fresh catalog by default
Building a selection instance from a live catalog SHALL bypass the catalog cache and fetch live by default. API callers MAY opt into the cached catalog; the CLI offers no opt-out and always refreshes. Snapshot mode never uses the cache.

#### Scenario: Default selection
- **WHEN** a live selection runs without specifying refresh behavior
- **THEN** the catalog is fetched live, not served from the cache

#### Scenario: CLI selection
- **WHEN** `qrb select` or `qrb instance` runs with the live catalog
- **THEN** the catalog is fetched live even if the cache is warm

### Requirement: Defaults
Unless overridden, selection SHALL use 1024 shots, the live catalog, both providers, optimization level 0 and seed 1234. The CLI and API let callers override shots, catalog source and providers, but not optimization level or seed.

#### Scenario: No options
- **WHEN** a selection runs with only a circuit and preferences
- **THEN** it uses 1024 shots, the live catalog from both providers, level 0 and seed 1234

### Requirement: Build without solving
The system SHALL be able to build and return the instance without solving it, using the same rules as a full selection.

#### Scenario: Inspect instance
- **WHEN** an instance-only request is made
- **THEN** the BIM instance is returned and the solver is not contacted

### Requirement: Phase timings
Every build or selection SHALL produce timings: catalog fetch time, cache hit, catalog fetched-at timestamp, preprocessing, summed compile and feature time, assembly time, total, per-resource compile/feature time with depth before and after compilation and two-qubit gate count, and per-resource infeasibility reasons. The API returns them all; the CLI prints a subset to stderr on request.

#### Scenario: Timings returned
- **WHEN** a selection completes
- **THEN** its timings include every field listed above, with depth after compilation and two-qubit gate count unknown for resources that did not compile

#### Scenario: Snapshot timings
- **WHEN** an instance is built from a snapshot
- **THEN** cache hit and catalog fetched-at timestamp are unknown

#### Scenario: CLI timings
- **WHEN** `qrb instance` runs with `--timings`
- **THEN** a timing breakdown is printed to stderr and stdout holds only the instance JSON
