#!/usr/bin/env bash
# Regenerates lib/api/schema.d.ts from the gateway's public OpenAPI document
# (apps/gateway/src/openapi.ts: committed FastAPI snapshot + gateway routes).
# Offline: no server needed. Paths are relative to the /api server URL.
# After changing apps/api models run `task gateway:openapi` first.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$WEB_DIR/../.." && pwd)"

bun run --cwd "$REPO_ROOT/apps/gateway" --silent openapi:print > "$WEB_DIR/openapi.json"

cd "$WEB_DIR"
bunx --bun openapi-typescript openapi.json -o lib/api/schema.d.ts

echo "Wrote $WEB_DIR/lib/api/schema.d.ts"
