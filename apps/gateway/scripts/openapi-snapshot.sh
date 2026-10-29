#!/usr/bin/env bash
# Regenerates openapi/qrb-api.json, the FastAPI schema the gateway merges into
# its public OpenAPI document. Offline: imports the app, no server, no secret.
# Run after changing apps/api models or routes (task gateway:openapi).
set -euo pipefail

GATEWAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$GATEWAY_DIR/../.." && pwd)"

uv run --project "$REPO_ROOT" python -c "
import json
from qrb_api.main import app
print(json.dumps(app.openapi(), indent=2))
" > "$GATEWAY_DIR/openapi/qrb-api.json"

echo "Wrote $GATEWAY_DIR/openapi/qrb-api.json"
