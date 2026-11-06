from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from qrb_api import main

SECRET = "test-gateway-secret"

# No `with` block: the lifespan's startup live catalog fetch must not run.
client = TestClient(main.app, headers={main.GATEWAY_SECRET_HEADER: SECRET})


@pytest.fixture(autouse=True)
def _gateway_secret(monkeypatch):
    monkeypatch.setenv("QRB_GATEWAY_SECRET", SECRET)

BELL = """OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
bit[2] c;
h q[0];
cx q[0], q[1];
c = measure q;
"""

SNAPSHOT = Path(__file__).resolve().parents[3] / (
    "scripts/experiments/output/shared_catalog_snapshot.json"
)


@pytest.mark.parametrize("endpoint", ["/instance", "/select"])
def test_snapshot_path_is_not_a_field(endpoint, tmp_path, monkeypatch):
    monkeypatch.delenv("QRB_SNAPSHOT_PATH", raising=False)
    """Clients never choose which file the server reads: a `snapshot_path` in
    the body is ignored and never reaches the catalog."""
    seen = []

    def capture(*args, **kwargs):
        seen.append(kwargs)
        raise RuntimeError("stop here")

    monkeypatch.setattr(main, "get_catalog", capture)
    existing = tmp_path / "secret.txt"
    existing.write_text("not a snapshot")
    response = client.post(endpoint, json={"circuit_qasm": BELL, "live": False, "snapshot_path": str(existing)})
    assert response.status_code == 502
    assert seen and seen[0]["snapshot_path"] is None  # the server default, not the client value
    assert "snapshot_path" not in main.app.openapi()["components"]["schemas"]["SelectRequest"]["properties"]


def test_live_false_uses_server_snapshot(monkeypatch):
    monkeypatch.setenv("QRB_SNAPSHOT_PATH", str(SNAPSHOT))
    response = client.post("/instance", json={"circuit_qasm": BELL, "live": False})
    assert response.status_code == 200, response.text
    assert response.json()["result"]["candidates"]
    assert response.json()["source"]["mode"] == "snapshot"


def test_circuit_qasm_path_is_not_read(monkeypatch):
    monkeypatch.setattr(main, "build_selection_instance", lambda *a, **k: 1 / 0)
    readme = Path(__file__).resolve().parents[3] / "README.md"
    assert readme.exists()
    original = Path.read_text

    def guard(self, *args, **kwargs):
        assert self != readme, "circuit_qasm must not be read as a file"
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", guard)
    details = []
    for value in (str(readme), "/nonexistent/definitely/missing.qasm"):
        response = client.post("/instance", json={"circuit_qasm": value, "live": False})
        assert response.status_code == 422
        details.append(response.json()["detail"])
    assert details[0].strip()
    assert "README" not in details[0]


def test_features_lists_every_declared_feature_without_a_circuit(monkeypatch):
    monkeypatch.setenv("QRB_SNAPSHOT_PATH", str(SNAPSHOT))
    response = client.get("/features")
    assert response.status_code == 200
    ids = [f["id"] for f in response.json()["result"]]
    assert {"expected_fidelity", "cost", "queue", "num_qubits", "operational", "cost_normalized"} <= set(ids)
    instance = client.post("/instance", json={"circuit_qasm": BELL, "live": False})
    assert ids == [f["id"] for f in instance.json()["result"]["features"]]
