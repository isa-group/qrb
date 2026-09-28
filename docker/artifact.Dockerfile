# syntax=docker/dockerfile:1
# Artifact-evaluation image: everything needed to reproduce the paper's
# results. Default command runs the offline reproduction (no credentials,
# no network): `docker run --rm qrb-artifact`.
FROM ghcr.io/astral-sh/uv:python3.14-trixie-slim

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    MPLBACKEND=Agg \
    PATH="/app/.venv/bin:${PATH}"

WORKDIR /app
COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --all-packages

CMD ["sh", "scripts/experiments/reproduce_offline.sh"]
