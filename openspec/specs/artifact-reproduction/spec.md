# artifact-reproduction Specification

## Purpose

Lets reviewers check every result in the ICSOC 2026 paper from committed data,
offline and without credentials, and re-run the experiments without
overwriting the data the paper reports.

## Requirements

### Requirement: Offline reproduction needs no credentials or network
`task reproduce` (equivalently `sh scripts/experiments/reproduce_offline.sh`) SHALL verify the RQ1 BIM instances, run the RQ2 optimality check and regenerate the figures using only committed data, with no credentials and no network access, in about a minute.

#### Scenario: Run offline
- **WHEN** `task reproduce` runs on a machine with no network and no provider credentials
- **THEN** it completes, printing the sections `== RQ1: ... ==`, `== RQ2: ... ==` and `== Figures ... ==` and the RQ1 and RQ2 results

### Requirement: Offline reproduction lists regenerated figures
The offline reproduction SHALL print a `regenerated via plots{1,2,3}.py` line per plot script and then list the `*.pdf` and `*.png` files in `scripts/experiments/output/`.

#### Scenario: Figure listing
- **WHEN** `task reproduce` finishes the figures section
- **THEN** one `regenerated via plots{1,2,3}.py` line per plot script is printed, followed by the list of `*.pdf` and `*.png` files in `output/`

### Requirement: Offline reproduction rewrites tracked outputs in place
The offline reproduction SHALL rewrite `output/optimality_check.csv` and the figure files in `scripts/experiments/output/` in place; the CSV content is unchanged on the paper's data.

#### Scenario: Files rewritten
- **WHEN** `task reproduce` runs on the committed data
- **THEN** `output/optimality_check.csv` and the figures are rewritten, and the CSV content equals the committed content

### Requirement: Docker reproduction
The artifact image built from `docker/artifact.Dockerfile` SHALL run the offline reproduction by default.

#### Scenario: Docker run
- **WHEN** `docker run --rm qrb-artifact` runs
- **THEN** the offline reproduction runs inside the container

### Requirement: Docker re-run of Experiments 2 and 3
The same image SHALL re-execute Experiments 2 and 3 when run as `docker run --rm -v "$PWD/rerun:/app/scripts/experiments/rerun" qrb-artifact sh scripts/experiments/reproduce_experiments.sh [--pilot]`, writing the new CSVs to the mounted folder. It needs network access to OpenBinding.

#### Scenario: Docker pilot re-run
- **WHEN** the command above runs with `--pilot`
- **THEN** the experiments, the optimality check and the paper comparison run in order, and the new CSVs appear in the host's `rerun/` folder

### Requirement: RQ1 instance check
The RQ1 check (`uv run python scripts/experiments/verify_bim_instances.py`) SHALL solve each of the six motivating-scenario BIM instances by exhaustive enumeration and compare with the paper's bindings: single-task cost IQM Garnet, queue Braket Garnet, fidelity Quantinuum H2; two-task cost IQM Garnet for both tasks, queue Braket Garnet for both, and `fms_two_task_fidelity_budget` IQM Garnet + Quantinuum H2. It SHALL exit non-zero on any mismatch.

#### Scenario: All match
- **WHEN** the RQ1 check runs on the committed instances
- **THEN** it prints one `OK` line per instance, then `6/6 instances match the paper.`, and exits 0

#### Scenario: Mismatch
- **WHEN** a committed instance is edited so its optimum changes
- **THEN** the check prints a `FAIL` line for it, reports fewer than `6/6` matches and exits 1

### Requirement: RQ1 instances resolved through OpenBinding
`task reproduce:bim` (equivalently `uv run python scripts/experiments/solve_bim_instances.py`) SHALL send each of the six `fms_*.json` instances, validated by the client's instance model and otherwise unmodified, to the OpenBinding gateway with engine `minizinc-csp`, and compare the returned binding with the offline oracle. It needs network access to OpenBinding but no provider credentials.

#### Scenario: All six resolved
- **WHEN** `task reproduce:bim` runs with network access
- **THEN** it prints one `OK` line per instance with the returned binding and execution time, and exits 0

#### Scenario: Binding differs
- **WHEN** OpenBinding returns a binding that differs from the offline oracle
- **THEN** a `DIFF` line is printed for that instance and the exit code is 1

### Requirement: OpenBinding gateway URL override
`solve_bim_instances.py` SHALL use the OpenBinding client's default gateway (`https://openbinding.score.us.es/api`) unless the `OPENBINDING_URL` environment variable is set, in which case it SHALL use that URL.

#### Scenario: Custom gateway
- **WHEN** `OPENBINDING_URL=http://localhost:8080/api task reproduce:bim` runs
- **THEN** the instances are sent to that URL instead of the default

### Requirement: Test suite checks the RQ1 instances
`task test` (equivalently `uv run pytest`) SHALL check that the committed `fms_*.json` and `experiment3_*.json` BIM instances validate against the OpenBinding schema and that the offline optimum of each of the six RQ1 instances matches the paper's binding. It needs no network.

#### Scenario: Instance validity
- **WHEN** `uv run pytest` collects `scripts/experiments/test_bim_instances.py`
- **THEN** one test per `fms_*.json` and `experiment3_*.json` instance validates it against the OpenBinding `Instance` model

#### Scenario: Offline optimum
- **WHEN** the same suite runs
- **THEN** one test per RQ1 instance asserts the offline optimum equals the expected binding, and fails if an instance is edited so its optimum changes

### Requirement: RQ2 optimality check
The RQ2 check SHALL recompute, from saved feature tables, the weighted argmax over feasible candidates for 66 Experiment 3 and 39 Experiment 2 configurations, compare each with the binding OpenBinding returned, and report `Total: 105/105 matched` on the paper's data. One Experiment 2 repetition per configuration is checked (13 qubit points x 3 families = 39).

#### Scenario: Paper data
- **WHEN** the RQ2 check runs on the committed experiment data
- **THEN** it prints `experiment3: 66/66 matched`, `experiment2: 39/39 matched` and `Total: 105/105 matched`, and writes `output/optimality_check.csv`

### Requirement: RQ2 optimality check reports mismatches without failing
The RQ2 check SHALL report mismatches but not change its exit code.

#### Scenario: Mismatch reported
- **WHEN** a recorded binding differs from the recomputed optimum
- **THEN** a `  MISMATCH <config>: argmax=... actual=...` line is printed, the totals drop, and the exit code stays 0

### Requirement: Re-runs write to the re-run folder by default
Re-running experiments through `task experiment:1/2/3/snapshot` or `task reproduce:experiments` SHALL write new results to `scripts/experiments/rerun/` by default, and MUST NOT overwrite the paper's CSVs or snapshot in `scripts/experiments/output/`. This relies on the tasks setting `QRB_EXPERIMENTS_OUT`.

#### Scenario: Pilot re-run
- **WHEN** `task reproduce:experiments -- --pilot` runs
- **THEN** new CSVs appear in `scripts/experiments/rerun/` and the paper's CSVs in `output/` are unchanged

### Requirement: Scripts run directly default to the paper's output folder
The experiment scripts SHALL default to `scripts/experiments/output/` when `QRB_EXPERIMENTS_OUT` is unset.

#### Scenario: Script run directly
- **WHEN** an experiment script is run directly with `QRB_EXPERIMENTS_OUT` unset
- **THEN** it writes its CSVs to `scripts/experiments/output/`, overwriting the paper's data

### Requirement: Re-runs use the frozen snapshot
Experiments 2 and 3 SHALL read the committed frozen catalog snapshot `scripts/experiments/output/shared_catalog_snapshot.json` by default, wherever `QRB_EXPERIMENTS_OUT` points, so feasible sets and selected bindings match the paper's. `--snapshot PATH` overrides it.

#### Scenario: Snapshot override
- **WHEN** `--snapshot PATH` is passed to Experiment 2 or 3
- **THEN** that snapshot is loaded instead of the frozen one

### Requirement: Re-runs need no provider credentials
Re-running Experiments 2 and 3 SHALL need only network access to OpenBinding, not provider credentials, because the catalog comes from the frozen snapshot.

#### Scenario: No credentials needed
- **WHEN** Experiment 2 is re-run without provider credentials
- **THEN** it reads the frozen snapshot and needs only network access to OpenBinding

### Requirement: Re-run comparison with the paper
After a re-run, the comparison SHALL check each re-run configuration against the paper (Experiment 2: feasible count and binding; Experiment 3: binding per weighting), print `N/N re-run configurations match the paper (feasible sets and selected bindings).` and exit 1 on a mismatch, printing a `DIFF` line for each. Re-run rows with no counterpart in the paper's data are skipped. Timings may differ.

#### Scenario: Matching re-run
- **WHEN** a pilot re-run matches the paper's data
- **THEN** the comparison prints that all re-run configurations match and exits 0

#### Scenario: Differing re-run
- **WHEN** a re-run configuration's feasible count or binding differs from the paper's
- **THEN** a `DIFF` line is printed for it and the exit code is 1

### Requirement: Re-run comparison needs re-run data
The comparison SHALL fail when the re-run directory holds neither re-run CSV.

#### Scenario: No re-run data
- **WHEN** the comparison finds neither re-run CSV in the re-run directory
- **THEN** it prints `No re-run data found in <dir>.` and exits 1

### Requirement: Full grid without pilot mode
Without `--pilot`, the experiment scripts SHALL run the full grid, taking about one hour for Experiments 2 and 3.

#### Scenario: Full Experiment 2
- **WHEN** Experiment 2 runs without `--pilot`
- **THEN** it runs 3 families x 13 qubit points x 10 repetitions

### Requirement: Experiment 1 pilot grid
`experiment1_ingestion.py --pilot` SHALL run three configurations, each of catalog size 2 (mixed, IBM-only and Braket-only), with 2 repetitions each, instead of the full sweep (mixed catalog sizes 2, 4, 6, 8, 10 and 12; single-provider sizes 2, 4 and 6 for each of IBM-only and Braket-only; 10 repetitions).

#### Scenario: Experiment 1 pilot
- **WHEN** `--pilot` is given to Experiment 1
- **THEN** it reports 3 configs x 2 reps = 6 live fetches

### Requirement: Experiment 2 pilot grid
`--pilot` for Experiment 2 SHALL run GHZ circuits at 2, 15, 53 and 156 qubits with 2 repetitions.

#### Scenario: Pilot run
- **WHEN** `--pilot` is given to Experiment 2
- **THEN** it runs 8 configurations (ghz x 4 qubit points x 2 repetitions) instead of 3 families x 13 points x 10 repetitions

### Requirement: Experiment 3 pilot grid
`--pilot` for Experiment 3 SHALL sweep a 10-point weight grid (step 1/3) instead of 66.

#### Scenario: Experiment 3 pilot
- **WHEN** `--pilot` is given to Experiment 3
- **THEN** it sweeps 10 weight combinations (n=3)

### Requirement: Credentialed experiments
Experiment 1 (catalog ingestion) and capturing a fresh snapshot SHALL require IBM Quantum and Amazon Braket credentials.

#### Scenario: Credentials required
- **WHEN** `task experiment:1` or `task experiment:snapshot` runs without provider credentials
- **THEN** it cannot fetch the live catalog

### Requirement: Credentialed experiments keep the paper's data
Through their tasks, Experiment 1 and snapshot capture SHALL write to `scripts/experiments/rerun/` by default; run directly without `QRB_EXPERIMENTS_OUT`, they write to `output/`.

#### Scenario: Fresh snapshot
- **WHEN** `task experiment:snapshot` runs with credentials
- **THEN** a new snapshot is written under `rerun/` and the paper's frozen snapshot is kept

### Requirement: Published-approach encodings
The RQ3 encodings of NISQ Analyzer, Q-Orchestrator and MQT Predictor SHALL be available as committed BIM instances and as the presets `nisq-analyzer`, `q-orchestrator` and `mqt-predictor`.

#### Scenario: RQ3 presets
- **WHEN** `uv run qrb preset list` runs
- **THEN** `nisq-analyzer`, `q-orchestrator` and `mqt-predictor` are listed

### Requirement: NISQ Analyzer depth constraint is vacuous on the frozen snapshot
Snapshots do not store per-qubit T1/T2, so on the frozen snapshot no candidate has a computable maximum depth and `depth_feasible` is 1 for every candidate. The `nisq-analyzer` constraint `depth_feasible >= 1` SHALL therefore exclude no candidate in any run from that snapshot.

#### Scenario: Depth constraint excludes nothing
- **WHEN** an instance is built from the frozen snapshot with the `nisq-analyzer` preset
- **THEN** every candidate that fits the circuit width has `depth_feasible` 1 and none is dropped by the `depth_feasible >= 1` constraint
