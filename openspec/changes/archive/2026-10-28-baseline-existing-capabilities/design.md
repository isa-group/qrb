# Design

## Context

See proposal.md (Why). The specs were derived by reading the code at commit
`bfafc3d`: `packages/qrb`, `packages/openbinding`, `packages/qrb-store`,
`apps/cli`, `apps/api`, `apps/poller`, `apps/web/lib`, `apps/web/hooks`, `apps/web/app/playground`, `apps/web/components`, `scripts/experiments`,
`Taskfile.yml` and the README. `CONTEXT.md` and ADRs 0001/0002, cited
throughout the code, are not in the repository, so they were not used.

## Goals / Non-Goals

**Goals:**
- Describe the behavior that exists today, precisely enough that each scenario
  can be checked against the code or tests.
- Record where the code disagrees with its own comments or docs, without
  choosing a fix.

**Non-Goals:**
- Changing any behavior, fixing any discrepancy, or adding tests.
- Specifying internal structure (module names, classes, threading), except
  where it is observable (for example, the cache TTL).
- Detailed UI specs for the web app's landing and docs pages.

## Decisions

- **Code wins over comments.** Where a comment or doc disagrees with what the
  code does, the spec states what the code does. The disagreement is listed
  below. Alternative: spec the documented intent. Rejected, because a baseline
  that the code already fails would make the first verification pass meaningless.
- **One capability per durable behavior, not per package.** For example,
  `circuit-transpilation` and `qos-features` both live in `packages/qrb`, but
  they change for different reasons. Snapshots are split from the live catalog
  because their guarantee (offline, credential-free) is what the artifact
  rests on.
- **Exact numbers are part of the contract where users rely on them**:
  preset weights, default shots, seed, optimization level, cache TTL,
  pricing formulas and paper check outputs (`6/6`, `105/105`). Changing any
  of them should be a visible spec change.
- **Web specs stay thin.** Only behavior with a contract to the API or to the
  user's declared preferences is specified (mock mode, form rules, eligibility
  preview, resolve flow).
- **Verification is done by reading code and running existing checks,** not
  by writing new tests. New tests would be implementation work, outside this
  change.

## Known discrepancies (recorded, not fixed)

| # | Where | Comment or doc says | Code does | Spec follows |
|---|---|---|---|---|
| 1 | `qrb/transpile.py` seed docstring | Seed needed because of optimization level 3's randomness | Default level is 0 | Code (level 0) |
| 2 | `qrb/presets.py` `nisq-analyzer` comment | `depth_feasible` is "always enforced globally" | Only `num_qubits` is enforced automatically (`instance.py`) | Code |
| 3 | `qrb_store/models.py` `BindingLog.source` | Source is `cli` or `api` | Only the API records bindings; the CLI never does | Code (API only) |
| 4 | `qrb_store/models.py` `BindingLog.preferences` | Lists `max_cost`, `min_fidelity`, ... | Stores `weights`, `constraints`, `require_provider`, `pareto` | Code |
| 5 | `scripts/experiments/common.py` | "Re-runs never overwrite [output/] unless QRB_EXPERIMENTS_OUT points here" | Without `QRB_EXPERIMENTS_OUT`, output defaults to `output/`. Running an experiment script directly (not via `task`) overwrites the paper's CSVs | Code: tasks and `reproduce_experiments.sh` default to `rerun/`; direct script runs write to `output/` (artifact-reproduction specifies both) |
| 6 | `reproduce_offline.sh` vs README | README: "the paper's data in `output/` is left untouched" (said of re-runs) | Offline reproduce rewrites `output/optimality_check.csv` (content unchanged) and the six committed figures in `output/` (binary diff, so the working tree is dirty afterwards) | Spec records this; it only protects the CSVs and snapshot |
| 7 | `apps/web/lib/playground/api.ts` comment | Catalog cache window is 20 s | Cache TTL is 90 s | Code (90 s) |
| 8 | README, several docstrings | Point to `CONTEXT.md` and ADR 0001/0002 | Files absent | These specs replace them |
| 9 | `qrb/transpile.py` `_max_executable_depth` docstring | The depth bound is None for "any non-IBM target" | No provider check; the bound is None whenever the hardware model lacks T1 or gate durations: every Braket resource, and every resource loaded from a snapshot, IBM included (see #20) | Code |
| 10 | `qrb/features.py` estimated-success-probability docstring | Reuses the ALAP-scheduled circuit computed for IBM cost | No scheduling is done (`transpile.py` computes duration without inserting delays), so estimated success probability equals expected fidelity for every resource unless the user's circuit has explicit delays | Code |
| 11 | `qrb_store` docstrings (`__init__.py`, `repository.py`, `db.py`) | Recording never raises | A malformed `DATABASE_URL` raises from engine creation outside the `try`; the API's `/select` would then fail after the selection already succeeded. An unreachable database is swallowed | Code (only write failures are swallowed) |
| 12 | `openbinding/client.py` `solve` | Returns a `SolveResponse` | A completed job with no result triggers a bare `assert` (returns `None` under `python -O`) | Code |
| 13 | `qrb_store/models.py` `BindingLog` docstring | One row per `qrb.select()` call | One row per API `/select` call only (see #3) | Code |
| 14 | `apps/web/lib/playground/eligibility.ts`, `task-specification-panel.tsx` comments | A live "Constraint Inspector" previews constraint eligibility from catalog data | The page uses only the qubit-count and provider checks; live constraint checks are computed but never shown, and no Constraint Inspector exists | Code |
| 15 | `apps/web` mock mode | Mock catalog is for environments without provider credentials | Resolve always calls the real API even in mock mode, so the listed catalog (mock) and the resolved binding (API's catalog) can come from different sources | Code |
| 16 | `qrb/instance.py` "no resource could transpile" error | Building fails with a message listing each candidate's reason | With an empty (filtered) catalog, normalization fails first with `min() iterable argument is empty`; the API reports this local error as HTTP 502 (gateway error) | Code (spec says only "fails with an error") |
| 17 | README RQ2 row and `reproduce_experiments.sh` | "Optimality checks all matched" is a pass condition | `optimality_check.py` always exits 0, even on mismatches; only `compare_with_paper.py` affects the exit code | Code |
| 18 | `apps/api` error mapping | `/select` and `/catalog` map failures to 502 | An unknown preset returns 500 (resolved outside the `try`), and `/engines` has no error handling (500 when OpenBinding is down) | Code |
| 19 | `docker-compose.yml` vs `apps/api` | Compose default `WEB_ORIGINS` is `http://localhost:3069` | Code default is `http://localhost:3000,http://localhost:3002` | Code default |
| 20 | `qrb/snapshot.py` module docstring and `raw_calibration_json` field doc | Replay transpiles "exactly as in live mode"; IBM needs no extra calibration data because the Target "carries everything" | Snapshots do not store per-qubit T1/T2, so replayed resources have none. Offline, depth feasibility is always 1 (the `nisq-analyzer` depth constraint excludes nothing), estimated success probability equals expected fidelity, and IBM median T1/T2 are unknown. All 4,680 rows of the paper's `experiment2_per_candidate.csv` have `depth_feasible = 1.0` | Code |
| 21 | `qrb/providers/base.py` `last_calibrated_at` doc | Most recent calibration timestamp | For Braket it is the device service's last-update time (`properties.service.updatedAt`), not a calibration time | Code |
| 22 | `qrb/pricing.py` IQM comment | Garnet is $0.00145/shot | Every IQM device, Garnet included, is priced at $0.00160/shot (the Emerald rate) | Code |
| 23 | `apps/web/lib/playground/api.ts` comment | `/instance` lands within the cache window and returns quickly | `/instance` is sent with the same `force_refresh` as `/select` (default true), so it fetches live again and may show an instance built from a different catalog than the one solved | Code |
| 24 | `scripts/experiments/experiment3_preferences.py` pilot names | Pilot configurations are compared with the paper's | Pilot weights in thirds are named with one decimal (`0.3,...`), which can collide with the paper's 0.3/0.7 configurations of different weights | Code |
| 25 | `apps/api` `snapshot_path` request field | — (undocumented) | `POST /select` and `/instance` read any server-side path given as `snapshot_path`, and parse errors are echoed in the 502 `detail` (security-relevant) | Code |
| 26 | `qrb/circuit.py` `load_qasm3` via `apps/api` `circuit_qasm` | Field carries OpenQASM 3 source text | Any string naming an existing server-side file is read from that file; a non-QASM file returns 422, revealing that the path exists (security-relevant) | Code |
| 27 | `qrb/presets.py` user preset loading | User presets are layered on top of built-ins | A user preset file with a weight on a non-objective feature makes loading fail, so every named preset lookup fails (built-ins included), `qrb preset list` fails and `GET /presets` returns 500 | Code |

Items 20, 3, 5 and 6 may matter (20 most) for the artifact evaluation; fixing any of them
is a separate change.

## Risks / Trade-offs

- [A spec misreads the code] → Each capability gets a verification task that
  checks every scenario against the code and existing tests, and corrects the
  spec, not the code.
- [Specs encode accidental behavior (for example, unknown queue scored as 0)]
  → Acceptable for a baseline. Changing it later is an explicit, reviewable
  spec change.
- [Numbers such as pricing go stale] → Pricing is specified as a formula plus
  examples. Updating the rate card should update this spec in the same change.
