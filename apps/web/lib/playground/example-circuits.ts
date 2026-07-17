export interface ExampleCircuit {
  id: string;
  label: string;
  qasm: string;
}

export const EXAMPLE_CIRCUITS: ExampleCircuit[] = [
  {
    id: "bell-pair",
    label: "Bell pair (2q)",
    qasm: `OPENQASM 3;
include "stdgates.inc";
qubit[2] q;
bit[2] c;
h q[0];
cx q[0], q[1];
c = measure q;
`,
  },
  {
    id: "ghz-3",
    label: "GHZ state (3q)",
    qasm: `OPENQASM 3;
include "stdgates.inc";
qubit[3] q;
bit[3] c;
h q[0];
cx q[0], q[1];
cx q[1], q[2];
c = measure q;
`,
  },
  {
    id: "rotation-chain-3",
    label: "Rotation chain (3q)",
    qasm: `OPENQASM 3;
include "stdgates.inc";
qubit[3] q;
bit[3] c;
h q[0];
rz(0.5) q[0];
cx q[0], q[1];
ry(1.2) q[1];
cx q[1], q[2];
x q[2];
c = measure q;
`,
  },
];

export const DEFAULT_EXAMPLE_CIRCUIT = EXAMPLE_CIRCUITS[0];
