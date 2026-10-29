# Tasks

Every task below checks one spec against the code at `bfafc3d`. The repo has no unit tests outside `scripts/experiments/`, so "cited" means a file:line reference for each scenario in the task report. When a
scenario does not match the code, fix the spec file (never the code) and note
the fix in the task report. If the code contradicts its own comments, add the
case to design.md's "Known discrepancies" table instead of choosing a side.

## 1. Catalog and snapshots

- [x] 1.1 [standard] Check every scenario in `specs/resource-catalog/spec.md` against `packages/qrb/src/qrb/catalog.py`, `providers/`; verified when each scenario is cited to a code line
- [x] 1.2 [standard] Check every scenario in `specs/catalog-snapshot/spec.md` against `packages/qrb/src/qrb/snapshot.py`; verified when each scenario is cited to a code line, and `uv run qrb catalog --snapshot --snapshot-path scripts/experiments/output/shared_catalog_snapshot.json` lists resources with no credentials set

## 2. Compilation, features and preferences

- [x] 2.1 [standard] Check every scenario in `specs/circuit-transpilation/spec.md` against `packages/qrb/src/qrb/circuit.py`, `transpile.py`; verified when each scenario is cited to a code line
- [x] 2.2 [heavy] Check every scenario in `specs/qos-features/spec.md` against `features.py`, `calibration.py`, `pricing.py`, recomputing the worked numbers (cost 80.30 and 3.76 USD, normalization 1.0/0.5/0.0); verified when each scenario is cited and every number is confirmed by a calculation. Heavy: performance-critical numeric rules spread across three modules feed every paper result, and a misread silently corrupts the baseline
- [x] 2.3 [standard] Check every scenario in `specs/preferences-and-presets/spec.md` against `preferences.py`, `presets.py`; verified when each scenario is cited and `uv run qrb preset list` shows exactly the seven built-ins with the specified weights

## 3. Selection and solver client

- [x] 3.1 [heavy] Check every scenario in `specs/resource-selection/spec.md` against `instance.py`, `select.py`, `timing.py`; verified when each scenario is cited and `uv run qrb instance <a Bell-state OpenQASM 3 file written to /tmp> --snapshot --snapshot-path scripts/experiments/output/shared_catalog_snapshot.json` shows the `num_qubits` constraint first and nine raw plus five normalized features. Heavy: cross-module (catalog, compilation, features, preferences, client) and the core of the paper's claims
- [x] 3.2 [standard] Check every scenario in `specs/openbinding-client/spec.md` against `packages/openbinding/src/openbinding/`; verified when each scenario is cited to a code line

## 4. Persistence and poller

- [x] 4.1 [standard] Check every scenario in `specs/history-persistence/spec.md` against `packages/qrb-store/` (including migrations); verified when each scenario is cited to a code line
- [x] 4.2 [standard] Check every scenario in `specs/telemetry-poller/spec.md` against `apps/poller/src/qrb_poller/main.py`; verified when each scenario is cited to a code line

## 5. Entry points

- [x] 5.1 [standard] Check every scenario in `specs/cli/spec.md` against `apps/cli/src/qrb_cli/main.py`; verified when each scenario is cited and `uv run qrb --help`, `uv run qrb select --help` and `uv run qrb instance --help` list the specified options
- [x] 5.2 [standard] Check every scenario in `specs/http-api/spec.md` against `apps/api/src/qrb_api/main.py`; verified when each scenario is cited and a FastAPI `TestClient` call to `GET /health` returns `{"status": "ok"}` (run from a script outside the repo, not committed)
- [x] 5.3 [standard] Check every scenario in `specs/web-playground/spec.md` against `apps/web/lib/`, `apps/web/hooks/` and the playground components; verified when each scenario is cited to a code line

## 6. Artifact reproduction

- [x] 6.1 [standard] Check every scenario in `specs/artifact-reproduction/spec.md` against `scripts/experiments/`, `Taskfile.yml`, `docker/artifact.Dockerfile` and the README; verified when each scenario is cited and `task reproduce` prints `6/6 instances match the paper.` and `Total: 105/105 matched`, followed by `git restore scripts/experiments/output` so no committed file is left modified

## 7. Integration

- [x] 7.1 [light] Run `openspec validate baseline-existing-capabilities --strict` and `uv run pytest -q` after all spec fixes; verified when validation reports the change valid and the test suite result is reported as-is. Light: runs two listed commands, no judgment

## Workflow follow-up

- Send the diff, proposal, specs and design to the `reviewer` subagent.
- Archive the change so the specs land in `openspec/specs/`.
