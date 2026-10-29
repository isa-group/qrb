import logging

import pytest
from fastapi.testclient import TestClient
from qrb_api import main

SECRET = "test-gateway-secret"

BELL = """OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
bit[2] c;
h q[0];
cx q[0], q[1];
c = measure q;
"""

# No `with` block: the lifespan's startup live catalog fetch must not run.
client = TestClient(main.app)

PROTECTED = [
    ("post", "/select", {"json": {"circuit_qasm": BELL}}),
    ("post", "/instance", {"json": {"circuit_qasm": BELL}}),
    ("get", "/catalog", {}),
    ("get", "/catalog/some-id", {}),
    ("get", "/engines", {}),
    ("get", "/presets", {}),
    ("get", "/scalar", {}),
    ("get", "/openapi.json", {}),
    ("get", "/no-such-route", {}),
]


@pytest.fixture
def no_backend(monkeypatch):
    """Fail the test if any catalog fetch, build or solve is attempted."""

    def fail(*args, **kwargs):
        raise AssertionError("backend must not be called")

    for name in (
        "build_selection_instance",
        "select_from_instance",
        "fetch_catalog",
        "fetch_catalog_timed",
        "OpenBindingClient",
    ):
        monkeypatch.setattr(main, name, fail)


@pytest.fixture
def secret_set(monkeypatch):
    monkeypatch.setenv("QRB_GATEWAY_SECRET", SECRET)
    monkeypatch.delenv("QRB_ALLOW_UNAUTHENTICATED", raising=False)


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {main.GATEWAY_SECRET_HEADER: "wrong"},
        {main.GATEWAY_SECRET_HEADER: ""},
        {main.GATEWAY_SECRET_HEADER: SECRET + "x"},
    ],
)
@pytest.mark.parametrize(("method", "path", "kwargs"), PROTECTED)
def test_missing_or_wrong_secret_rejected(secret_set, no_backend, headers, method, path, kwargs):
    response = getattr(client, method)(path, headers=headers, **kwargs)
    assert response.status_code == 401
    assert response.json() == {"detail": "Missing or invalid gateway secret"}


def test_correct_secret_proceeds(secret_set, monkeypatch):
    calls = []

    def fake_build(*args, **kwargs):
        calls.append(1)
        raise RuntimeError("stub reached")

    monkeypatch.setattr(main, "build_selection_instance", fake_build)
    response = client.post(
        "/select",
        json={"circuit_qasm": BELL},
        headers={main.GATEWAY_SECRET_HEADER: SECRET},
    )
    # The handler ran and reached the (stubbed) build step.
    assert response.status_code == 502
    assert calls == [1]
    presets = client.get("/presets", headers={main.GATEWAY_SECRET_HEADER: SECRET})
    assert presets.status_code == 200


def test_select_logs_forwarded_user_id(secret_set, monkeypatch, caplog):
    monkeypatch.setattr(main, "build_selection_instance", lambda *a, **k: 1 / 0)
    with caplog.at_level(logging.INFO, logger="qrb_api"):
        client.post(
            "/select",
            json={"circuit_qasm": BELL},
            headers={main.GATEWAY_SECRET_HEADER: SECRET, main.USER_ID_HEADER: "user-123"},
        )
    assert "user-123" in caplog.text


@pytest.mark.parametrize("env", [{}, {"QRB_GATEWAY_SECRET": SECRET}])
def test_health_open(monkeypatch, env):
    monkeypatch.delenv("QRB_GATEWAY_SECRET", raising=False)
    monkeypatch.delenv("QRB_ALLOW_UNAUTHENTICATED", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize("opt_out", [None, "0", "true"])
def test_unset_secret_without_opt_out_refused(monkeypatch, no_backend, opt_out):
    monkeypatch.delenv("QRB_GATEWAY_SECRET", raising=False)
    if opt_out is None:
        monkeypatch.delenv("QRB_ALLOW_UNAUTHENTICATED", raising=False)
    else:
        monkeypatch.setenv("QRB_ALLOW_UNAUTHENTICATED", opt_out)
    for headers in ({}, {main.GATEWAY_SECRET_HEADER: ""}, {main.GATEWAY_SECRET_HEADER: "x"}):
        response = client.post("/select", json={"circuit_qasm": BELL}, headers=headers)
        assert response.status_code == 401


def test_unset_secret_with_opt_out_allowed(monkeypatch):
    monkeypatch.delenv("QRB_GATEWAY_SECRET", raising=False)
    monkeypatch.setenv("QRB_ALLOW_UNAUTHENTICATED", "1")
    assert client.get("/presets").status_code == 200


def test_opt_out_does_not_bypass_a_configured_secret(secret_set, monkeypatch, no_backend):
    monkeypatch.setenv("QRB_ALLOW_UNAUTHENTICATED", "1")
    assert client.post("/select", json={"circuit_qasm": BELL}).status_code == 401


def test_no_cors_without_opt_out(secret_set):
    # The app under test was imported without the dev opt-out, so no CORS
    # middleware is installed and no origin is granted access.
    response = client.get(
        "/presets",
        headers={main.GATEWAY_SECRET_HEADER: SECRET, "Origin": "http://localhost:3000"},
    )
    assert "access-control-allow-origin" not in response.headers
