#!/bin/sh
# Exact request body used to produce select-normal.json (frozen snapshot, live=false).
# QRB_API defaults to a local apps/api.
curl -sS -X POST "${QRB_API:-http://localhost:8000}/select" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{
  "circuit_qasm": "OPENQASM 3.0;\ninclude \"stdgates.inc\";\nqubit[3] q;\nbit[3] c;\nh q[0];\ncx q[0], q[1];\ncx q[1], q[2];\nc = measure q;\n",
  "preferences": {
    "weights": {"expected_fidelity": 0.5, "cost": 0.3, "queue": 0.2},
    "constraints": [{"feature": "operational", "op": ">=", "value": 1}]
  },
  "shots": 1024,
  "live": false
}
JSON
