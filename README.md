<p align="center">
  <img alt="header" src="https://shieldcn.dev/header/dots.svg?title=QRB&amp;subtitle=Quantum+Resource+Binder&amp;logo=ri%3ATbAtom2Filled&amp;logoColor=743bf6&amp;mode=dark" />
</p>

[![DOI](https://shieldcn.dev/badge/DOI-10.5281/zenodo.21442195-abcde3.svg?theme=gray&logo=false&color=3f5578)](https://doi.org/10.5281/zenodo.21442195)
[![License](https://shieldcn.dev/badge/license-Apache--2.0-blue.svg?variant=secondary)](LICENSE)
[![Python](https://shieldcn.dev/badge/python-3.14-3776AB.svg?variant=secondary&logo=python)](.python-version)
[![Bun](https://shieldcn.dev/badge/bun-%E2%89%A51.3-000000.svg?variant=secondary&logo=bun)](package.json)

**Research artifact**. QRB is a declarative
quantum resource binder: given an OpenQASM 3 circuit and a set of declared
preferences (a weighted objective plus constraints over cost, fidelity, queue
length, and related QoS features), it resolves the optimal live quantum
resource — IBM Quantum or Amazon Braket — to run it on. Resource selection is
modeled as **QoS-Aware Service Composition (QACO)**: QRB compiles a circuit and
its preferences into a Binding Instance Model (BIM) instance and solves it via
[OpenBinding](packages/openbinding), a generic QACO solver gateway. QRB never
submits jobs — selection only.

The full domain vocabulary (Task, Provider, Resource, Candidate, Binding,
Feature, Objective, Constraint, ...) is documented in [CONTEXT.md](CONTEXT.md).

## Artifact evaluation (ICSOC 2026)

This repository is the artifact of _Quantum Resource Selection as a QoS-Aware
Composition Problem_ (ICSOC 2026). Every result in the paper can be checked
**offline, in about a minute, with no credentials**:

```bash
task sync && task reproduce        # or: sh scripts/experiments/reproduce_offline.sh
# or, with Docker only:
docker build -f docker/artifact.Dockerfile -t qrb-artifact . && docker run --rm qrb-artifact
```

| Paper claim                                                                                                                  | Command                                                                                                                     | Expected output                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RQ1: the motivating scenario (Sec. 3, Table 1) and its two-task variant are plain BIM instances (`scripts/experiments/bim/`) | `uv run python scripts/experiments/verify_bim_instances.py`                                                                 | `6/6 instances match the paper` (cost: IQM Garnet; queue: Braket Garnet; fidelity: Quantinuum H2)                                                                         |
| RQ1: OpenBinding resolves those instances unchanged                                                                          | `task reproduce:bim` (network)                                                                                              | `OK` for all six instances                                                                                                                                                |
| RQ2: the returned binding is the optimum in every run (Sec. 5.4-5.5)                                                         | `uv run python scripts/experiments/optimality_check.py`                                                                     | `Total: 105/105 matched`                                                                                                                                                  |
| RQ2: latency breakdown and preference sensitivity (Fig. 2)                                                                   | `task experiment:plots`                                                                                                     | Figures in `scripts/experiments/output/`                                                                                                                                  |
| RQ2: re-running Experiments 2 and 3 from the frozen snapshot                                                                 | `task reproduce:experiments -- --pilot` (network)                                                                           | New CSVs in `scripts/experiments/rerun/` (the paper's data in `output/` is left untouched); optimality checks all matched and `N/N re-run configurations match the paper` |
| RQ3: encodings of NISQ Analyzer, Q-Orchestrator and MQT Predictor (Sec. 5.6)                                                 | `scripts/experiments/bim/rq3_*.json`; presets `nisq-analyzer`, `q-orchestrator`, `mqt-predictor` (`uv run qrb preset list`) | BIM constraints and objective per approach                                                                                                                                |
| Catalog ingestion (Exp. 1) and a fresh snapshot                                                                              | `task experiment:1`, `task experiment:snapshot`                                                                             | Needs IBM Quantum / Amazon Braket credentials                                                                                                                             |

With Docker, the same image re-executes Experiments 2 and 3 (drop `--pilot`
for the full grid, about one hour); the mounted folder receives the new CSVs:

```bash
docker run --rm -v "$PWD/rerun:/app/scripts/experiments/rerun" qrb-artifact \
  sh scripts/experiments/reproduce_experiments.sh --pilot
```

To plot a re-run, point the plotting scripts at `scripts/experiments/rerun/`
(figures are written there, next to the new CSVs):

```bash
R=scripts/experiments/rerun; P=scripts/experiments/output
uv run python $P/plots2.py --summary $R/experiment2_per_run_summary.csv \
  --candidates $R/experiment2_per_candidate.csv --outdir $R   # Fig. 2
uv run python $P/plots3.py --ternary $R/experiment3_ternary.csv --outdir $R
```

In Docker, run the same two commands inside the image with the same `-v` mount,
using `python` instead of `uv run python`. Fig. 2 needs the full re-run: the
`--pilot` grid covers only GHZ circuits at four sizes, which is enough to check
feasible sets and bindings but not to draw the figure.

External dependencies: steps marked _network_ call the public OpenBinding
gateway (`https://openbinding.score.us.es/api`, override with
`OPENBINDING_URL`); only live catalog ingestion needs provider credentials.
Live runs see today's catalog, so their bindings and latencies differ from
the paper's; the frozen snapshot (`output/shared_catalog_snapshot.json`,
captured 2026-07-12) is what makes the reported numbers reproducible.

## Repository layout

This is a `uv` + `bun` monorepo:

```
packages/
  qrb/            core library — catalog fetch, transpilation-driven feature
                  extraction, Preferences -> BIM instance, OpenBinding solve
  qrb-store/      optional Postgres persistence for binding decisions and
                  catalog telemetry history
  openbinding/    typed Python client for the OpenBinding QACO gateway
apps/
  cli/            `qrb` command-line interface
  api/            FastAPI HTTP mirror of the CLI (OpenAPI docs at /scalar)
  poller/         periodic catalog telemetry sampler (writes to qrb-store)
  web/            Next.js catalog / playground / API-docs frontend
scripts/
  experiments/    Experiments 1-3, the reusable evaluation suite they share,
                  and the figures reported in the paper
docker/           Dockerfiles for api/cli/poller
docker-compose.yml
CONTEXT.md        QACO domain model and terminology reference
```

## Requirements

- [uv](https://docs.astral.sh/uv/) with Python 3.14 (pinned in `.python-version`)
- [Bun](https://bun.sh/) ≥1.3 (or Node ≥18) for `apps/web`
- Docker + Docker Compose — optional, for the containerized stack / Postgres
- IBM Quantum and/or Amazon Braket credentials — optional, only needed for
  live catalog fetches. Everything below also works fully offline: the CLI/API
  can read a frozen catalog snapshot (`--snapshot`), and the web app defaults
  to a bundled mock catalog

## Quick start

```bash
git clone https://github.com/isa-group/qrb.git && cd qrb
cp .env.example .env        # optionally fill in IBM/Braket credentials
task sync                   # uv sync --all-packages && bun install
```

([Task](https://taskfile.dev/) is optional — every task in `Taskfile.yml` is a
thin wrapper over a plain `uv`/`bun`/`docker` command shown alongside its
description; run `task --list` to see them all.)

## Using the CLI

```bash
task cli -- select circuit.qasm --preset fidelity-first
# equivalent: uv run qrb select circuit.qasm --preset fidelity-first

uv run qrb catalog                 # fetch and display the live resource catalog
uv run qrb catalog --refresh snap.json   # freeze a reproducible snapshot
uv run qrb select circuit.qasm --snapshot --snapshot-path snap.json --preset fastest
uv run qrb instance circuit.qasm --preset balanced   # emit the BIM instance, unsolved
uv run qrb engines                 # list OpenBinding solver engines
uv run qrb preset list
```

## Running the API and web app

```bash
task api:dev    # http://localhost:8000  (OpenAPI docs at /scalar)
task web:dev    # http://localhost:3000
```

The web app uses a bundled mock catalog by default
(`NEXT_PUBLIC_USE_MOCK_CATALOG=true`), so `task web:dev` alone is enough to
browse the Catalog, Playground, and API reference pages without any
credentials or a running API. Point it at a live `apps/api` by setting that
flag to `false` in `apps/web/.env.local`.

## Docker

```bash
task docker:build        # build the api and cli images
task docker:api          # api + postgres via docker compose (http://localhost:8000)
task docker:cli -- select circuit.qasm --preset fastest
task docker:down
```

## Reproducing the paper's experiments

`scripts/experiments/` holds the three experiments reported in the paper —
Experiment 1/2/3 — built on a small reusable evaluation suite (`common.py`)
they share, plus an independent optimality-oracle check. All of them are
exposed as `task` targets and accept `--pilot` for a fast smoke-test sweep
before a full run.

| Task                           | Measures                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `task experiment:1 -- --pilot` | Catalog ingestion time vs. catalog size and provider mix (needs live credentials)                                                            |
| `task experiment:snapshot`     | Captures a fresh catalog snapshot (needs live credentials); the paper's frozen snapshot stays in `output/`                                   |
| `task experiment:2 -- --pilot` | Transpile / feature / instance-build / resolve time vs. circuit size (reads the frozen snapshot only)                                        |
| `task experiment:3 -- --pilot` | Whether declared preferences change the resolved binding — a ternary sweep over cost/fidelity/queue weights (reads the frozen snapshot only) |
| `task experiment:plots`        | Regenerates all figures from the already-collected CSVs, no live calls                                                                       |

```bash
uv run python scripts/experiments/optimality_check.py
```

independently recomputes the optimum from the recorded feature tables and
cross-checks it against what OpenBinding actually returned, for every
Experiment 2/3 configuration.

`scripts/experiments/output/` holds the data reported in the paper, including
the frozen snapshot (captured 2026-07-11T19:13:19Z). Re-runs write to
`scripts/experiments/rerun/` instead (override with `QRB_EXPERIMENTS_OUT`), so
the paper's data is never overwritten.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Citation

If you use this artifact, please cite:

```bibtex
@inproceedings{romeroflores2026qrb,
  title     = {Quantum Resource Selection as a {QoS}-Aware Composition Problem},
  author    = {Romero-Flores, Adri{\'a}n and M{\'a}rquez-Chamorro, Alfonso E. and
               Parejo, Jos{\'e} Antonio and Ruiz-Cort{\'e}s, Antonio},
  booktitle = {Service-Oriented Computing -- 24th International Conference, ICSOC 2026},
  series    = {Lecture Notes in Computer Science},
  publisher = {Springer},
  year      = {2026},
}
```

Archived artifact: [10.5281/zenodo.21442195](https://doi.org/10.5281/zenodo.21442195)
(concept DOI, always resolves to the latest version).
