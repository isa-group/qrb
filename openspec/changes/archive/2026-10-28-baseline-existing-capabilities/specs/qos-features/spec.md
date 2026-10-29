# Spec Delta

## Purpose

Defines the QoS features QRB computes for every candidate resource, how each
is calculated, and how objective features are normalized so user weights are
comparable.

## ADDED Requirements

### Requirement: Feature registry
Every candidate SHALL carry these raw features: `expected_fidelity` (maximize, 0-1), `cost` (minimize, USD), `queue` (minimize, pending jobs), `critical_depth` (minimize, 0-1), `estimated_success_probability` (maximize, 0-1), `num_qubits`, `operational` (0/1), `depth_feasible` (0/1) and `calibration_age_hours` (minimize).

#### Scenario: All features present
- **WHEN** features are computed for any candidate
- **THEN** all nine raw features listed above have a numeric value

### Requirement: Objective features
The system SHALL declare normalized companions only for the five objective features `expected_fidelity`, `cost`, `queue`, `critical_depth` and `estimated_success_probability`.

#### Scenario: Constraint-only feature
- **WHEN** an instance is built for any request
- **THEN** it declares `cost_normalized` but no `num_qubits_normalized`, and `num_qubits` can still be used as a constraint feature

### Requirement: Expected fidelity
Expected fidelity SHALL be the product of (1 - error) over every operation in the compiled circuit except barrier, delay and reset (measurements count), using each operation's calibrated error on its qubits. An operation with no calibrated error SHALL count as error 0 unless the calibration fallback applies. It SHALL be 0 for a resource that could not be compiled.

#### Scenario: Infeasible resource
- **WHEN** the resource has fewer qubits than the circuit
- **THEN** its expected fidelity is 0

#### Scenario: Gate and measurement
- **WHEN** the compiled circuit has one gate with error 0.01, one measurement with error 0.02 and a barrier
- **THEN** expected fidelity is 0.99 x 0.98 = 0.9702

### Requirement: Calibration fallback for missing error data
When a resource's hardware model has no error data at all, expected fidelity SHALL use the provider's calibration data instead: for measurements the readout error, for one-qubit gates the one-qubit error, for two-qubit gates the two-qubit error, each per-qubit or per-pair where reported for those exact qubits, otherwise the device-wide median. Operations on more than two qubits, or with no value at all, SHALL count as error 0.

#### Scenario: IonQ without per-gate errors
- **WHEN** an IonQ resource's hardware model has no error values, its Braket calibration reports only a device-wide two-qubit fidelity of 0.99, and the compiled circuit contains two-qubit gates
- **THEN** each two-qubit gate contributes an error of 0.01 and expected fidelity is below 1.0

### Requirement: Braket cost
Cost for a Braket resource SHALL be its per-task price plus its per-shot price times shots.

#### Scenario: Braket IonQ cost
- **WHEN** a circuit is run with 1000 shots on an IonQ resource
- **THEN** its cost is 0.30 + 0.08 x 1000 = 80.30 USD

### Requirement: IBM cost
Cost for an IBM resource SHALL be the IBM per-second rate times (the per-job overhead + compiled circuit duration x shots). Duration SHALL be unknown only when the resource could not be compiled; then cost SHALL use (overhead + per-shot fallback x shots). A compiled IBM circuit always has a duration, which is 0 when the hardware model has no duration data.

#### Scenario: IBM resource not compiled
- **WHEN** an IBM resource could not be compiled and shots is 1000
- **THEN** its cost is 1.6 x (2 + 0.00035 x 1000) = 1.6 x 2.35 = 3.76 USD

#### Scenario: IBM compiled without duration data
- **WHEN** an IBM resource is compiled but its hardware model has no instruction durations
- **THEN** its duration is 0 and its cost is 1.6 x (2 + 0 x shots) = 3.2 USD for any shot count

### Requirement: IBM rate card
The IBM rate card SHALL be USD 96 per minute (1.6 USD per second), a 2 s per-job overhead, and a fallback of 0.00035 s per shot.

#### Scenario: IBM per-second rate
- **WHEN** the IBM rate is applied
- **THEN** it is 96 / 60 = 1.6 USD per second

### Requirement: Braket rate card
Braket prices SHALL be maintained in code and looked up by hardware vendor: per-task 0.30 USD for every vendor; per-shot AQT 0.0235, IonQ 0.08, IQM 0.0016 (every IQM device, including Garnet), Rigetti 0.000425 and QuEra 0.01 USD. Snapshot replay SHALL keep the prices recorded in the snapshot and SHALL NOT look them up.

#### Scenario: IQM Garnet price
- **WHEN** a circuit is run with 1000 shots on IQM Garnet
- **THEN** its cost is 0.30 + 0.0016 x 1000 = 1.90 USD

#### Scenario: Rigetti price
- **WHEN** a circuit is run with 1000 shots on a Rigetti resource
- **THEN** its cost is 0.30 + 0.000425 x 1000 = 0.725 USD

#### Scenario: Snapshot replay keeps recorded prices
- **WHEN** a snapshot recorded a Braket resource at 0.30 per task and 0.08 per shot and the maintained prices later change
- **THEN** replaying the snapshot with 1000 shots still gives a cost of 80.30 USD

### Requirement: Queue feature
The queue feature SHALL be the resource's queue length, or 0 when the queue length is unknown.

#### Scenario: Unknown queue
- **WHEN** a resource's queue length is unknown
- **THEN** its queue feature is 0

### Requirement: Critical depth
Critical depth SHALL be the share of two-qubit gates that lie on the compiled circuit's longest path. It SHALL be 0 when there are no two-qubit gates and 1 when the resource could not be compiled.

#### Scenario: No two-qubit gates
- **WHEN** the compiled circuit has only single-qubit gates
- **THEN** critical depth is 0

#### Scenario: Infeasible resource
- **WHEN** the resource has fewer qubits than the circuit
- **THEN** its critical depth is 1

### Requirement: Estimated success probability
Estimated success probability SHALL be expected fidelity multiplied, for each qubit the circuit uses, by exp(-idle / min(T1, T2)), where idle is the total duration of explicit delay operations on that qubit in the compiled circuit. Qubits lacking T1 or T2 SHALL be skipped. It SHALL equal expected fidelity when there are no delays, no T1/T2 data or no time step in the hardware model.

#### Scenario: No coherence data
- **WHEN** a resource has no T1/T2 data
- **THEN** estimated success probability equals expected fidelity

#### Scenario: Snapshot replay
- **WHEN** candidates come from snapshot replay, which does not store T1/T2
- **THEN** every replayed resource's estimated success probability equals its expected fidelity

### Requirement: Calibration age
Calibration age SHALL be the hours since the resource's last calibration time (as defined by the resource-catalog capability), measured to the current time. A resource with unknown calibration time SHALL get 1,000,000 hours, so any maximum-age constraint excludes it.

#### Scenario: Braket calibration time
- **WHEN** a Braket device's service was last updated 3 hours ago
- **THEN** its calibration age is 3 hours

#### Scenario: Unknown calibration time
- **WHEN** a resource has no last calibration time and a constraint `calibration_age_hours <= 24` is set
- **THEN** the resource fails that constraint

#### Scenario: Replaying an old snapshot
- **WHEN** a snapshot recorded a last-calibration time of 2026-10-01T00:00Z, it is replayed at 2026-10-28T00:00Z and a constraint `calibration_age_hours <= 24` is set
- **THEN** the resource's age is 27 x 24 = 648 hours and it fails that constraint

### Requirement: Normalized objective features
For each objective feature, the system SHALL add a `<feature>_normalized` value: min-max normalized across every resource evaluated for this request (including ones later dropped because compilation failed), clipped to 0-1, inverted for minimize features so higher is better, and 0 for all when every value is the same.

#### Scenario: Cost normalization
- **WHEN** three candidates have cost 1, 2 and 3
- **THEN** their `cost_normalized` values are 1.0, 0.5 and 0.0

#### Scenario: All equal
- **WHEN** every candidate has queue 0
- **THEN** every `queue_normalized` value is 0.0

### Requirement: Calibration summary
For any resource, the system SHALL report its native gate names (excluding measurement, reset, delay, barrier and control flow) and median T1, median T2 (microseconds), median one-qubit gate error, median two-qubit gate error and median readout error, each unknown when no data exists.

#### Scenario: IonQ one-qubit error
- **WHEN** an IonQ resource has no one-qubit fidelity in standardized calibration but its vendor data reports a mean one-qubit fidelity of 0.9998
- **THEN** its median one-qubit gate error is 0.0002
