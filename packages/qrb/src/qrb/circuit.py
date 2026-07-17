"""Circuit ingestion. OpenQASM 3 is the canonical wire format at the CLI/API
boundary; a live QuantumCircuit is accepted directly in-process.
"""

from __future__ import annotations

from pathlib import Path

from qiskit import qasm3
from qiskit.circuit import QuantumCircuit


def load_qasm3(source: str | Path) -> QuantumCircuit:
    """Load a circuit from an OpenQASM 3 string, or from a file if `source`
    points to an existing path.
    """
    path = Path(source) if not isinstance(source, Path) else source
    if isinstance(source, str) and not path.exists():
        return qasm3.loads(source)
    return qasm3.loads(path.read_text())


def width(circuit: QuantumCircuit) -> int:
    """Number of qubits the circuit requires — the sole driver of the
    mandatory feasibility constraint (num_qubits >= width).
    """
    return circuit.num_qubits
