# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:python3.14-trixie-slim

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:${PATH}"

WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=packages/openbinding/pyproject.toml,target=packages/openbinding/pyproject.toml \
    --mount=type=bind,source=packages/qrb/pyproject.toml,target=packages/qrb/pyproject.toml \
    --mount=type=bind,source=apps/api/pyproject.toml,target=apps/api/pyproject.toml \
    --mount=type=bind,source=apps/cli/pyproject.toml,target=apps/cli/pyproject.toml \
    uv sync --frozen --no-install-workspace --package qrb-cli

COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --package qrb-cli

WORKDIR /workspace
ENTRYPOINT ["qrb"]
CMD ["--help"]
