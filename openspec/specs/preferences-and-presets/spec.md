# preferences-and-presets Specification

## Purpose

Defines how a user declares what they want from a selection (weights, hard
constraints, provider filter, Pareto mode) and the named presets that package
common declarations, including encodings of published selection approaches.

## Requirements

### Requirement: Preference contents
A preference declaration SHALL consist of objective weights keyed by objective feature, a list of hard constraints, an optional required provider, and a Pareto flag.

#### Scenario: Full declaration
- **WHEN** a user gives weights `{cost: 0.5, queue: 0.5}`, constraint `operational >= 1`, provider `ibm` and Pareto off
- **THEN** the resolved preferences contain exactly those values

### Requirement: Default preset
When no preset is named, preferences SHALL start from the `balanced` preset.

#### Scenario: Nothing specified
- **WHEN** preferences are resolved with no preset, weights or constraints
- **THEN** the weights are `expected_fidelity 0.34, cost 0.33, queue 0.33` and the constraint is `operational >= 1`

### Requirement: Explicit values replace preset values wholesale
Explicitly given weights SHALL replace the preset's weights entirely, and explicitly given constraints SHALL replace the preset's constraints entirely. They MUST NOT be merged field by field.

#### Scenario: Override weights only
- **WHEN** preset `fastest` is used with explicit weights `{cost: 1.0}`
- **THEN** the weights are exactly `{cost: 1.0}` and the constraints are still `fastest`'s

#### Scenario: Empty constraint list
- **WHEN** preset `balanced` is used with an explicit empty constraint list
- **THEN** the resolved preferences have no user constraints

#### Scenario: Empty weights count as given
- **WHEN** preset `fastest` is used with an explicit empty weights mapping
- **THEN** the preset's weights are discarded, the resolved weights are empty, and building the objective fails because an objective needs at least one weight

### Requirement: Constraints are hard bounds on raw features
Each constraint SHALL name a feature, an operator (`<=`, `>=`, `==`, `<`, `>`) and a number, and SHALL be applied as a hard bound on the raw (not normalized) feature value. Soft constraints are not offered. The HTTP API and the user preset file also accept `IN_RANGE`, which is passed through to the solver unchanged; the CLI and the web form offer only the five operators above.

#### Scenario: Cost limit in dollars
- **WHEN** a constraint `cost <= 0.5` is declared
- **THEN** candidates whose raw cost exceeds 0.5 USD are excluded

### Requirement: Constraint feature names are not validated on declaration
A constraint's feature name MUST NOT be checked when the constraint is declared or saved into a user preset.

#### Scenario: Unknown constraint feature is not rejected on declaration
- **WHEN** a constraint naming a feature that does not exist is declared, or saved into a user preset
- **THEN** the declaration is accepted without an error naming the feature

### Requirement: Objective targets normalized features
The objective SHALL weight the normalized companion of each weighted feature (`<feature>_normalized`). Without the Pareto flag it SHALL be a single weighted objective.

#### Scenario: Single weighted objective
- **WHEN** weights are given for `cost` and `queue` and Pareto is off
- **THEN** the objective is a single weighted objective over `cost_normalized` and `queue_normalized`

### Requirement: Pareto objective
When the Pareto flag is set, the objective SHALL be a many-objective (Pareto) objective over the `_normalized` companions of the weighted features. It requires at least three weighted features; with fewer, building the objective MUST fail.

#### Scenario: Pareto objective
- **WHEN** weights are given for three features and Pareto is on
- **THEN** the objective is a many-objective over the three `_normalized` features

#### Scenario: Pareto with fewer than three weights: building the objective fails
- **WHEN** Pareto is on with preset `q-orchestrator` (one weight) or `mqt-predictor` (two weights)
- **THEN** building the objective fails with a validation error saying the target list needs at least 3 items

### Requirement: Weights are passed through unchanged
QRB SHALL NOT normalize or rescale weights. The objective SHALL carry the weights exactly as resolved and SHALL declare that they sum to one, whether or not they do.

#### Scenario: Weights not summing to one
- **WHEN** weights `{cost: 0.5, queue: 0.2}` are resolved and the objective is built
- **THEN** the objective weights are `cost_normalized 0.5, queue_normalized 0.2`, unscaled, and it declares that weights sum to one

### Requirement: Provider filter
A required provider SHALL remove all other providers' resources from the candidate set before the instance is built, and the instance's provider list SHALL be taken from the resources remaining after filtering. This is the single owner of the provider-filter rule.

#### Scenario: Require Braket
- **WHEN** the required provider is `braket`
- **THEN** no IBM resource appears as a candidate

#### Scenario: Provider list reflects the filter
- **WHEN** the required provider is `braket` and the catalog also holds IBM resources
- **THEN** the instance lists only `braket` among its providers

### Requirement: Built-in presets
The system SHALL ship presets `balanced`, `fidelity-first`, `cheapest`, `fastest`, `mqt-predictor`, `nisq-analyzer` and `q-orchestrator`, each including the constraint `operational >= 1`.

#### Scenario: Preset list
- **WHEN** the presets are listed with no user preset file
- **THEN** exactly these seven names are listed, each with its weights
- **AND** each resolved preset includes the constraint `operational >= 1`

### Requirement: Preset weights
Built-in preset weights SHALL be: `balanced` 0.34/0.33/0.33 and `fidelity-first`, `cheapest`, `fastest` 0.70 on fidelity, cost or queue respectively with 0.15 on the other two (all over expected_fidelity/cost/queue).

#### Scenario: Cheapest weights
- **WHEN** preset `cheapest` is resolved
- **THEN** the weights are `expected_fidelity 0.15, cost 0.70, queue 0.15`

### Requirement: Published-approach presets
`mqt-predictor` SHALL weight `expected_fidelity` and `critical_depth` 0.5 each. `nisq-analyzer` SHALL use the balanced weights plus constraint `depth_feasible >= 1`. `q-orchestrator` SHALL weight only `queue`, at 1.0.

#### Scenario: NISQ Analyzer encoding
- **WHEN** preset `nisq-analyzer` is resolved
- **THEN** its constraints are `operational >= 1` and `depth_feasible >= 1`

### Requirement: Preset weights must reference objective features
Creating a preset whose weights name a feature outside the objective features (`expected_fidelity`, `cost`, `queue`, `critical_depth`, `estimated_success_probability`) MUST fail with an error naming the unknown feature.

#### Scenario: Bad weight key
- **WHEN** a preset is created with weights `{num_qubits: 1.0}`
- **THEN** creation fails naming `num_qubits`

### Requirement: Explicit request weights are not validated
Weights given directly in a request SHALL NOT be checked against the objective features. A weight on a non-objective feature produces an objective target that the instance does not declare.

#### Scenario: Explicit request weights are not checked
- **WHEN** preferences are resolved with explicit weights `{num_qubits: 1.0}` and no preset is created
- **THEN** resolution succeeds, no error names `num_qubits`, and the objective targets `num_qubits_normalized`

### Requirement: User presets
User presets SHALL be stored in TOML at `~/.config/qrb/presets.toml` by default, one `[presets.<name>]` table per preset holding its weights and, when it has any, its constraints (feature, operator, value). Saving SHALL add or replace one preset and keep the others.

#### Scenario: Save keeps constraints
- **WHEN** a preset is saved with weights `{cost: 1.0}` and constraint `num_qubits >= 2`
- **THEN** the file contains `[presets.<name>]` with that constraint and resolving the preset returns it; a preset saved with no constraints resolves with none (the default `operational` bound is not added)

#### Scenario: User preset with a non-objective weight breaks all lookups
- **WHEN** the user preset file contains a preset whose weights name a non-objective feature such as `num_qubits`
- **THEN** loading presets fails with an error naming the unknown feature, so every named-preset lookup fails, built-in presets included

#### Scenario: No user file
- **WHEN** the user preset file does not exist
- **THEN** only the built-in presets are available and no error is raised

### Requirement: User presets override built-ins
User presets SHALL be listed with the built-ins, and a user preset with a built-in's name SHALL replace it.

#### Scenario: Override a built-in
- **WHEN** a user saves a preset named `balanced` with weights `{cost: 1.0}`
- **THEN** resolving `balanced` returns weights `{cost: 1.0}`

### Requirement: Unknown preset
Resolving a preset name that is neither built-in nor user-defined MUST fail with an error that lists the available names.

#### Scenario: Typo
- **WHEN** preset `balancd` is requested
- **THEN** resolution fails and the error lists the available preset names
