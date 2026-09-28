#!/bin/sh
# Re-execute Experiments 2 and 3 against the frozen snapshot and compare the
# results with the paper's. Needs network access to the OpenBinding gateway.
# Usage: sh scripts/experiments/reproduce_experiments.sh [--pilot]
set -e
cd "$(dirname "$0")/../.."
PY="${PYTHON:-python}"
command -v uv >/dev/null 2>&1 && [ -z "$PYTHON" ] && PY="uv run python"
export QRB_EXPERIMENTS_OUT="${QRB_EXPERIMENTS_OUT:-scripts/experiments/rerun}"

echo "== Experiment 2: feasibility filtering and scaling =="
$PY scripts/experiments/experiment2_circuit_scaling.py "$@"
echo
echo "== Experiment 3: optimality and preference sensitivity =="
$PY scripts/experiments/experiment3_preferences.py "$@"
echo
echo "== Optimality oracle on the re-run data =="
$PY scripts/experiments/optimality_check.py
echo
echo "== Comparison with the paper's data =="
$PY scripts/experiments/compare_with_paper.py
