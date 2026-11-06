#!/bin/sh
# Save apps/api's OpenAPI spec to data/openapi.json, for the /docs page and the typed client.
# Imports the FastAPI app and calls app.openapi(); no server is started and no provider or
# network call is made (the startup hook only runs under a server). The API's own content
# (Quickstart, tags, summaries, errors) comes from qrb_api/docs.py; this script adds:
#   - real request and response examples from fixtures/ (values exactly as the API returned them);
#   - `servers`, from NEXT_PUBLIC_QRB_API (default http://localhost:8000), so every code sample
#     points at the API this site talks to.
# Needs `uv sync --all-packages` at the repo root.
set -eu
cd "$(dirname "$0")/.."
QRB_API_URL="${NEXT_PUBLIC_QRB_API:-http://localhost:8000}" uv run --project ../.. python -c '
import json, os, sys
from pathlib import Path
from qrb_api.main import app

spec = app.openapi()
fx = Path("fixtures")
load = lambda name: json.loads((fx / name).read_text())

spec["servers"] = [{"url": os.environ["QRB_API_URL"].rstrip("/"), "description": "QRB API"}]

def examples(op, status, items):
    content = op["responses"].setdefault(status, {"description": "Successful Response"}).setdefault("content", {}).setdefault("application/json", {})
    content["examples"] = {key: {"summary": summary, "value": load(name)} for key, summary, name in items}

def request_examples(op, items):
    content = op["requestBody"]["content"]["application/json"]
    content["examples"] = {key: {"summary": summary, "value": load(name)} for key, summary, name in items}

paths = spec["paths"]
SNAP = " (frozen snapshot)"
request_examples(paths["/select"]["post"], [
    ("weights", "Weights and a constraint", "requests/select-normal.json"),
    ("preset", "A named preset", "requests/select-preset.json"),
    ("infeasible", "No QPU meets the constraints", "requests/select-infeasible.json"),
    ("pareto", "Pareto mode", "requests/select-pareto.json"),
])
examples(paths["/select"]["post"], "200", [
    ("weights", "Binding" + SNAP, "select-normal.json"),
    ("preset", "Binding with a preset" + SNAP, "select-preset.json"),
    ("infeasible", "Infeasible: every candidate breaks a constraint" + SNAP, "select-infeasible.json"),
    ("pareto", "Pareto: every non-dominated binding" + SNAP, "select-pareto.json"),
])
request_examples(paths["/instance"]["post"], [("weights", "Weights and a constraint", "requests/select-normal.json")])
examples(paths["/instance"]["post"], "200", [("weights", "BIM instance" + SNAP, "instance-normal.json")])
examples(paths["/catalog"]["get"], "200", [("snapshot", "The catalog" + SNAP, "catalog.json")])
examples(paths["/catalog/{candidate_id}"]["get"], "200", [("garnet", "IQM Garnet" + SNAP, "catalog-detail-braket.Garnet.json")])
examples(paths["/catalog/{candidate_id}/topology"]["get"], "200", [
    ("garnet", "IQM Garnet: per-qubit and per-coupler data" + SNAP, "catalog-topology-braket.Garnet.json"),
    ("forte", "IonQ Forte 1: all-to-all, device-wide figures" + SNAP, "catalog-topology-braket.Forte_1.json"),
])
examples(paths["/presets"]["get"], "200", [("presets", "All presets", "presets.json")])

json.dump(spec, sys.stdout, indent=2, ensure_ascii=False)
sys.stdout.write("\n")
' > data/openapi.json.tmp
mv data/openapi.json.tmp data/openapi.json
# Also published at /openapi.json: the /docs page loads it from there, and developers can fetch it.
cp data/openapi.json public/openapi.json
echo "Wrote apps/web/data/openapi.json and public/openapi.json"
