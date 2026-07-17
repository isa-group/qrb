#!/usr/bin/env bash
# Regenerates lib/api/schema.d.ts from apps/api's live Pydantic/FastAPI models.
#
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$WEB_DIR/../.." && pwd)"

uv run --project "$REPO_ROOT" python -c "
import json
from qrb_api.main import app
print(json.dumps(app.openapi()))
" > "$WEB_DIR/openapi.json"

cd "$WEB_DIR"
bunx --bun openapi-typescript openapi.json -o lib/api/schema.d.ts

echo "Wrote $WEB_DIR/lib/api/schema.d.ts"
