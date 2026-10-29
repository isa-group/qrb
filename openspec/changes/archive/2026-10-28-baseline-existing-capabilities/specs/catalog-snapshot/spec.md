# Spec Delta

## Purpose

Lets a live catalog be frozen to a file and replayed later, so selections and
experiments can be reproduced without provider credentials or network access.

## ADDED Requirements

### Requirement: Save a snapshot
The system SHALL write a catalog snapshot as JSON containing the capture time (UTC) and, per resource, its identity, vendor, qubit count, timing unit, queue length, pricing, every per-qubit instruction with its qubits, duration and error (instructions with no qubit assignment are omitted), status, operational flag, last calibration time, and any Braket calibration objects.

#### Scenario: Snapshot written
- **WHEN** a live catalog of 12 resources is saved to `snap.json`
- **THEN** `snap.json` contains a capture time and 12 resource entries with the fields listed above

#### Scenario: Unknown pricing model
- **WHEN** a resource whose pricing is neither IBM nor Braket pricing is saved
- **THEN** saving fails with an error

### Requirement: Snapshot replay is offline
Loading a snapshot SHALL NOT contact any provider or require credentials, and SHALL return resources usable for transpilation and feature computation (transpilation and feature computation work offline). Values that depend on per-qubit coherence times differ from live resources (see the hardware model rebuild requirement).

#### Scenario: Offline selection from snapshot
- **WHEN** a selection is run against a snapshot with no network and no provider credentials
- **THEN** the catalog loads, each resource transpiles against its rebuilt hardware model, and features are computed

### Requirement: Faithful hardware model rebuild
Replaying a snapshot SHALL rebuild each resource's hardware model with the recorded instructions, qubit arguments, durations, errors and timing unit, and SHALL restore Braket calibration objects. Per-qubit T1/T2 coherence times are NOT recorded or restored, so coherence-dependent values differ from the live resource.

#### Scenario: Braket fidelity preserved
- **WHEN** an IonQ resource whose gate errors come only from Braket calibration data is saved and reloaded
- **THEN** its expected fidelity after reload is derived from the restored calibration data, not 1.0

#### Scenario: IBM coherence times lost
- **WHEN** an IBM resource is saved and reloaded
- **THEN** its median T1 and T2 are unknown and its depth-feasible flag is 1 for any circuit

### Requirement: Unsupported gates fail loudly
Replaying a snapshot that contains a gate the rebuild does not support MUST fail with an error naming the gate. Measurement, reset and delay SHALL be rebuilt. Duplicate variants (names starting `measure` or `reset`, such as `measure_2`), barrier, control-flow pseudo-instructions and Rigetti `CCPRx`/`MeasureFF` SHALL be skipped rather than fail.

#### Scenario: Unknown gate
- **WHEN** a snapshot contains an instruction named `foo_gate`
- **THEN** loading fails with an error that names `foo_gate`

#### Scenario: Feed-forward instruction skipped
- **WHEN** a snapshot contains Rigetti `MeasureFF` instructions
- **THEN** loading succeeds and the rebuilt model omits them

#### Scenario: Duplicate measurement variant skipped
- **WHEN** a snapshot contains `measure` and `measure_2` instructions
- **THEN** loading succeeds, the rebuilt model contains `measure` and omits `measure_2`

### Requirement: Legacy snapshot compatibility
The system SHALL load older snapshot files that are a bare JSON list of resources, or that lack status, operational, calibration-time or calibration-object fields. Missing operational SHALL default to true and missing status to `unknown`; the capture time of a bare list SHALL be reported as unknown.

#### Scenario: Bare-list snapshot
- **WHEN** a snapshot file is a JSON array of resource entries without a capture time
- **THEN** it loads successfully and its capture time is reported as unknown

### Requirement: Snapshot provider filter
Reading a snapshot with a provider filter SHALL return only that provider's resources. A provider id other than `ibm` or `braket` MUST be rejected with an error. With no snapshot path, `catalog_snapshot.json` in the working directory is read.

#### Scenario: Filter on snapshot
- **WHEN** a snapshot containing IBM and Braket resources is read with provider filter `["ibm"]`
- **THEN** only IBM resources are returned

#### Scenario: Unknown provider
- **WHEN** a snapshot is read with provider filter `["foo"]`
- **THEN** reading fails with an error listing the known provider ids
