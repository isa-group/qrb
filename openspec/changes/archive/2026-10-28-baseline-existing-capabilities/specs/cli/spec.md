# Spec Delta

## Purpose

The `qrb` command-line interface: runs selections, emits BIM instances,
inspects and snapshots the catalog, lists solver engines and manages presets.

## ADDED Requirements

### Requirement: Select command
`qrb select <circuit file>` SHALL resolve preferences, run a selection and print `feasibility: <value>`, then per solution its binding, objective value and aggregated features. With `-o <path>` it SHALL instead write the full solve response as JSON there and print `Wrote solve response to <path>`.

#### Scenario: Print result
- **WHEN** `qrb select bell.qasm --preset fastest` succeeds
- **THEN** feasibility and each binding with its objective value and features are printed

#### Scenario: Write to file
- **WHEN** `qrb select bell.qasm -o out.json` succeeds
- **THEN** `out.json` contains the solve response and a confirmation line is printed

### Requirement: Instance command
`qrb instance <circuit file>` SHALL build the BIM instance without solving and print it as JSON (by-alias field names), or write it to the `-o` path and print `Wrote instance to <path>`.

#### Scenario: Instance to stdout
- **WHEN** `qrb instance bell.qasm --snapshot --snapshot-path snap.json` runs
- **THEN** the BIM instance JSON is printed and the solver is not contacted

### Requirement: Shared selection options
`select` and `instance` SHALL accept `--preset`, `--weight`, `--constraint`, `--require-provider`, `--pareto`, `--live/--snapshot` (default live), `--snapshot-path`, `--shots` (default 1024), repeatable `--provider`, `-o/--output` and `--timings`. `select` SHALL also accept `--engine`.

#### Scenario: Snapshot mode
- **WHEN** `--snapshot --snapshot-path snap.json` is given
- **THEN** the catalog is read from `snap.json` and no provider is contacted

### Requirement: Weight and constraint syntax
`--weight` SHALL take `feature=value` pairs separated by commas. `--constraint` SHALL take `feature:op:value` triples separated by commas, with op one of `le`, `ge`, `eq`, `lt`, `gt` (any case). An unknown op MUST be rejected with a usage error listing the valid ops. A non-numeric or missing value MUST make the command fail with an error naming the unparseable value; it is not reported as a usage error.

#### Scenario: Valid constraint
- **WHEN** `--constraint cost:le:0.5,operational:eq:1` is given
- **THEN** the constraints are `cost <= 0.5` and `operational == 1`

#### Scenario: Bad operator
- **WHEN** `--constraint cost:lte:0.5` is given
- **THEN** the command fails with a usage error: `Unknown constraint operator 'lte' — expected one of ['eq', 'ge', 'gt', 'le', 'lt']`

#### Scenario: Malformed value
- **WHEN** `--weight cost` (no `=`) or `--constraint cost:le` (no value) is given
- **THEN** the command fails with an error naming the unparseable value (the empty string), not a usage error

### Requirement: Timings output
With `--timings`, `select` and `instance` SHALL print the phase timing breakdown, per-resource times and any infeasibility reasons to standard error, keeping standard output unchanged.

#### Scenario: Timings to stderr
- **WHEN** `qrb instance bell.qasm --timings` runs
- **THEN** the instance JSON is on stdout and the timings are on stderr

### Requirement: Catalog listing
`qrb catalog` SHALL print one tab-separated line per resource with candidate id, name, `<n>q` qubit count and `queue=<n>`, from the live catalog or a snapshot, filtered by `--provider`. A resource with unknown queue length prints `queue=None`.

#### Scenario: List resources
- **WHEN** `qrb catalog --snapshot --snapshot-path snap.json` runs
- **THEN** each resource in the snapshot is printed as `id`, `name`, `<n>q`, `queue=<n>`, tab-separated
- **AND** a resource with unknown queue length shows `queue=None`

### Requirement: Catalog refresh
`qrb catalog --refresh <path>` SHALL always fetch the live catalog (ignoring `--snapshot`), honour `--provider`, save a snapshot to `<path>` and print `Wrote <n> resources to <path>` instead of listing.

#### Scenario: Refresh snapshot
- **WHEN** `qrb catalog --refresh snap.json` runs with credentials
- **THEN** the live catalog is saved to `snap.json` and the resource count is printed

### Requirement: Engines command
`qrb engines` SHALL list each OpenBinding engine with its id, type and whether it is active.

#### Scenario: List engines
- **WHEN** `qrb engines` runs with network access
- **THEN** one line per engine shows id, type and `active` or `inactive`

### Requirement: Preset list
`qrb preset list` SHALL print one tab-separated line per available preset with its name and weights.

#### Scenario: List presets
- **WHEN** `qrb preset list` runs
- **THEN** each preset is printed as its name and its weights

### Requirement: Preset show
`qrb preset show <name>` SHALL print the named preset's name, weights and constraints. An unknown name MUST make the command fail.

#### Scenario: Show built-in preset
- **WHEN** `qrb preset show balanced` runs
- **THEN** the output is `Preset(name='balanced', weights={'expected_fidelity': 0.34, 'cost': 0.33, 'queue': 0.33}, constraints=[ConstraintSpec(feature='operational', op=<ConstraintOp.GE: '>='>, value=1.0)])`

### Requirement: Preset save
`qrb preset save <name> --weight ... [--constraint ...]` SHALL save a user preset to `~/.config/qrb/presets.toml` and print `Saved preset '<name>'`. Weight feature names MUST be known objective features, otherwise the command fails naming the unknown features and saves nothing; constraint features are not checked.

#### Scenario: Unknown weight feature
- **WHEN** `qrb preset save x --weight nonfeature=1` runs
- **THEN** it fails naming the unknown features and nothing is saved

#### Scenario: Save and show
- **WHEN** `qrb preset save mine --weight cost=1.0` is followed by `qrb preset show mine`
- **THEN** the shown preset has weights `{'cost': 1.0}`

### Requirement: Environment file
The CLI SHALL read provider credentials and other settings from a `.env` file found by searching upward from the installed package (the repo root in a workspace install), not from the working directory. Variables already set in the environment MUST take precedence over `.env` values.

#### Scenario: Credentials from .env
- **WHEN** IBM credentials are set only in `.env`
- **THEN** a live `qrb catalog` can reach IBM
