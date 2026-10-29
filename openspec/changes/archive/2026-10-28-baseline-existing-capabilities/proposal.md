# Proposal

## Original request

> write down what already exist

## Why

QRB has no OpenSpec specs, and the documents its code cites as the source of
its rules (`CONTEXT.md`, ADR 0001 and ADR 0002) are not in the repository. The
behavior the ICSOC 2026 artifact depends on (selection-only, offline
reproduction, preset encodings, feasibility rules) is only recorded in code
and docstrings. Future changes need a written baseline to diff against.

## What Changes

- Record the current, observable behavior of QRB as specs, one per capability.
  No code changes: every requirement describes what the code does today.
- Where code and its own comments or docs disagree, the spec records what the
  code does, and design.md lists the disagreement for a later decision.

## Capabilities

### New Capabilities

- `resource-catalog`: read-only, live listing of gate-based QPUs from IBM
  Quantum and Amazon Braket, with a short process-wide cache.
- `catalog-snapshot`: recording the catalog to a file and replaying it without
  credentials or network access.
- `circuit-transpilation`: OpenQASM 3 ingestion and the uniform, seeded
  per-resource compilation that feature values are computed from.
- `qos-features`: the QoS feature registry (fidelity, cost, queue, critical
  depth, success probability, feasibility flags, calibration age), calibration
  summaries, pricing, and objective normalization.
- `preferences-and-presets`: weights, hard constraints, provider filter,
  Pareto mode, built-in presets and user presets.
- `resource-selection`: turning a circuit, a catalog and preferences into a
  BIM instance and solving it through OpenBinding. Selection only; QRB never
  submits jobs.
- `openbinding-client`: a domain-agnostic, typed client for the OpenBinding
  gateway's wire format and endpoints.
- `history-persistence`: optional Postgres recording of bindings and catalog
  telemetry that never breaks selection.
- `telemetry-poller`: the long-running process that samples the live catalog
  on an interval.
- `cli`: the `qrb` command-line interface.
- `http-api`: the HTTP API that mirrors the CLI for the web app and other
  clients.
- `web-playground`: the web frontend (catalog browser and playground).
- `artifact-reproduction`: the commands and checks that reproduce the paper's
  results, and the guarantee that the paper's committed data is not
  overwritten by re-runs.

### Modified Capabilities

None. There are no existing specs.

## Impact

- New files only, under `openspec/changes/baseline-existing-capabilities/`;
  after archive, under `openspec/specs/`.
- No code, API, dependency or data changes.
- Known disagreements between code and its comments (listed in design.md)
  are recorded, not fixed. Each fix would be its own change.
- Out of scope: deployment (docker-compose services, Cloudflare Pages
  deploy), API type generation for the web app, and the web app's landing
  and documentation pages.
