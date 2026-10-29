# circuit-transpilation Specification

## Purpose

Defines how a user's circuit is read and compiled for each candidate resource,
so every resource is judged on the same, reproducible compiled circuit.

## Requirements

### Requirement: OpenQASM 3 input
The system SHALL accept circuits as OpenQASM 3, either as source text or as a path to a file containing it. Source that cannot be parsed MUST be rejected with an error.

#### Scenario: Path input
- **WHEN** the input is the path of an existing `.qasm` file
- **THEN** the file's contents are parsed as OpenQASM 3

#### Scenario: Source text input
- **WHEN** the input is OpenQASM 3 text that does not name an existing path
- **THEN** the text is parsed as OpenQASM 3

#### Scenario: Invalid source
- **WHEN** the input is text that is not valid OpenQASM 3
- **THEN** circuit loading fails with an error

### Requirement: Circuit width
The circuit's width SHALL be its number of qubits. Width is the only circuit property used for automatic feasibility.

#### Scenario: Width of a 5-qubit circuit
- **WHEN** a circuit declares 5 qubits
- **THEN** its width is 5

### Requirement: Too-wide circuits are not compiled
For a resource with fewer qubits than the circuit's width, the system SHALL NOT compile the circuit, and SHALL mark that resource infeasible with reason `insufficient_qubits`.

#### Scenario: 20-qubit circuit on a 5-qubit device
- **WHEN** a 20-qubit circuit is prepared for a 5-qubit resource
- **THEN** no compilation is attempted and the resource is infeasible with reason `insufficient_qubits`

### Requirement: Uniform, seeded compilation
Every resource SHALL be compiled with the same optimization level (default 0) and the same fixed seed (default 1234), so compiled depth, two-qubit gate count and fidelity are reproducible run to run.

#### Scenario: Repeated run is identical
- **WHEN** the same circuit is compiled twice for the same resource with default settings
- **THEN** both runs produce the same depth and two-qubit gate count

### Requirement: Trapped-ion native gates use level 0
For a resource whose native gates include `gpi`, `gpi2`, `rzz` or `ms`, compilation SHALL use optimization level 0 regardless of the requested level.

#### Scenario: IonQ with requested level 3
- **WHEN** level 3 is requested for a resource offering `gpi2`
- **THEN** the circuit is compiled at level 0

### Requirement: Compilation failure isolates one resource
If compilation fails for one resource, that resource SHALL be marked infeasible with reason `transpile_error`, and compilation for other resources MUST continue.

#### Scenario: One resource fails
- **WHEN** compilation raises an error for resource A but succeeds for B and C
- **THEN** A is infeasible with reason `transpile_error`, and B and C have compiled results

#### Scenario: Failed resource leaves the instance
- **WHEN** an instance is built and resource A fails with `transpile_error`
- **THEN** A is reported as infeasible but is not a candidate, and building fails with an error only if every resource fails

### Requirement: Compiled metrics
For each successfully compiled resource, the system SHALL report compiled depth and the number of compiled instructions that act on exactly two qubits (including two-qubit barriers, if any). For every compiled IBM resource it SHALL also report the circuit's execution duration as the critical-path makespan of calibrated instruction durations (0 when no durations are available); for other resources the duration is unknown.

#### Scenario: IBM duration reported
- **WHEN** a circuit is compiled for an IBM resource with calibrated gate durations
- **THEN** depth, two-qubit count and execution duration are reported

#### Scenario: Two-qubit count
- **WHEN** a compiled circuit contains 3 two-qubit gates and one barrier across 2 qubits
- **THEN** the two-qubit count is 4

#### Scenario: IBM without duration data
- **WHEN** a circuit is compiled for an IBM resource whose hardware model has no instruction durations
- **THEN** the execution duration is reported as 0, not unknown

#### Scenario: Braket duration absent
- **WHEN** a circuit is compiled for a Braket resource
- **THEN** depth and two-qubit count are reported, and execution duration is unknown

### Requirement: Depth feasibility flag
Each compiled resource SHALL get a depth-feasible flag: false when compiled depth exceeds mean T1 divided by the longest gate duration, true otherwise, including when the bound cannot be computed. The bound needs per-qubit T1 and gate durations, so in practice only live IBM resources get one. This flag MUST NOT be enforced automatically.

#### Scenario: No T1 data
- **WHEN** a resource has no T1 or gate duration data
- **THEN** its depth-feasible flag is true

#### Scenario: Braket resource
- **WHEN** a deep circuit is compiled for a Braket resource
- **THEN** its depth-feasible flag is 1 for any circuit, because no T1 data exists

#### Scenario: Resource loaded from a snapshot
- **WHEN** a resource is loaded from a catalog snapshot (see catalog-snapshot capability, "Faithful hardware model rebuild") and a deep circuit is compiled for it
- **THEN** its depth-feasible flag is 1 for any circuit, because snapshots do not store T1

#### Scenario: Depth equals bound
- **WHEN** compiled depth equals mean T1 divided by the longest gate duration
- **THEN** the depth-feasible flag is true

#### Scenario: Depth exceeds bound
- **WHEN** compiled depth is 500 and mean T1 divided by the longest gate duration is 300
- **THEN** the depth-feasible flag is false, and the resource is still a candidate unless a user constraint excludes it
