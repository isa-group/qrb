#!/bin/sh
# Offline reproduction of the paper's results from the committed data.
# No credentials and no network access are needed. Takes about a minute.
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python}"
command -v uv >/dev/null 2>&1 && [ -z "$PYTHON" ] && PY="uv run python"

echo "== RQ1: BIM instances of the motivating scenario (Sections 3-4) =="
$PY verify_bim_instances.py
echo
echo "== RQ2: optimality oracle over Experiments 2 and 3 (Sections 5.4-5.5) =="
$PY optimality_check.py
echo
echo "== Figures (Figure 2 and supplementary plots) =="
cd output
for p in plots1 plots2 plots3; do $PY "$p.py" >/dev/null && echo "regenerated via $p.py"; done
ls -1 *.pdf *.png
