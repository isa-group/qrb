import type { CatalogResource } from "./types";

// Used when NEXT_PUBLIC_USE_MOCK_CATALOG=true (see hooks/use-catalog.ts).
export const MOCK_CATALOG: CatalogResource[] = [
  {
    candidate_id: "ibm:ibm_kyoto",
    name: "ibm_kyoto",
    provider_id: "ibm",
    vendor: "ibm",
    num_qubits: 127,
    queue_length: 8,
    status: "active",
    operational: true,
    last_calibrated_at: null,
  },
  {
    candidate_id: "ibm:ibm_brisbane",
    name: "ibm_brisbane",
    provider_id: "ibm",
    vendor: "ibm",
    num_qubits: 127,
    queue_length: 23,
    status: "active",
    operational: true,
    last_calibrated_at: null,
  },
  {
    candidate_id: "ibm:ibm_sherbrooke",
    name: "ibm_sherbrooke",
    provider_id: "ibm",
    vendor: "ibm",
    num_qubits: 127,
    queue_length: 4,
    status: "active",
    operational: true,
    last_calibrated_at: null,
  },
  {
    candidate_id: "braket:aria-1",
    name: "Aria 1",
    provider_id: "braket",
    vendor: "IonQ",
    num_qubits: 25,
    queue_length: 2,
    status: "ONLINE",
    operational: true,
    last_calibrated_at: null,
  },
  {
    candidate_id: "braket:aria-2",
    name: "Aria 2",
    provider_id: "braket",
    vendor: "IonQ",
    num_qubits: 25,
    queue_length: 6,
    status: "ONLINE",
    operational: true,
    last_calibrated_at: null,
  },
  {
    candidate_id: "braket:ankaa-3",
    name: "Ankaa 3",
    provider_id: "braket",
    vendor: "Rigetti",
    num_qubits: 84,
    queue_length: 15,
    status: "ONLINE",
    operational: true,
    last_calibrated_at: null,
  },
  {
    candidate_id: "braket:garnet",
    name: "Garnet",
    provider_id: "braket",
    vendor: "IQM",
    num_qubits: 20,
    queue_length: 1,
    status: "ONLINE",
    operational: true,
    last_calibrated_at: null,
  },
];

// Small bounded random walk so polling produces a visibly moving sparkline
// in mock mode, instead of a flat repeated value.
export function jitterCatalog(resources: CatalogResource[]): CatalogResource[] {
  return resources.map((r) => {
    const delta = Math.round((Math.random() - 0.5) * 6);
    return {
      ...r,
      queue_length: Math.max(0, r.queue_length + delta),
    };
  });
}

export interface MockCalibrationDetail {
  native_gates: string[];
  median_t1_us: number | null;
  median_t2_us: number | null;
  median_gate_error_1q: number | null;
  median_gate_error_2q: number | null;
  median_readout_error: number | null;
}

// Same shape as the real GET /catalog/{candidate_id} response (see
// packages/qrb/src/qrb/calibration.py) — mock-only illustrative
// numbers, not invented fields.
export const MOCK_CALIBRATION_DETAILS: Record<string, MockCalibrationDetail> = {
  "ibm:ibm_kyoto": {
    native_gates: ["ecr", "id", "rz", "sx", "x"],
    median_t1_us: 187,
    median_t2_us: 142,
    median_gate_error_1q: 0.0003,
    median_gate_error_2q: 0.0012,
    median_readout_error: 0.018,
  },
  "ibm:ibm_brisbane": {
    native_gates: ["ecr", "id", "rz", "sx", "x"],
    median_t1_us: 156,
    median_t2_us: 118,
    median_gate_error_1q: 0.0004,
    median_gate_error_2q: 0.0021,
    median_readout_error: 0.024,
  },
  "ibm:ibm_sherbrooke": {
    native_gates: ["ecr", "id", "rz", "sx", "x"],
    median_t1_us: 203,
    median_t2_us: 167,
    median_gate_error_1q: 0.0002,
    median_gate_error_2q: 0.0009,
    median_readout_error: 0.014,
  },
  "braket:aria-1": {
    native_gates: ["gpi", "gpi2", "ms"],
    median_t1_us: 10_000_000,
    median_t2_us: 1_000_000,
    median_gate_error_1q: null,
    median_gate_error_2q: 0.0004,
    median_readout_error: 0.004,
  },
  "braket:aria-2": {
    native_gates: ["gpi", "gpi2", "ms"],
    median_t1_us: 10_000_000,
    median_t2_us: 1_000_000,
    median_gate_error_1q: null,
    median_gate_error_2q: 0.0005,
    median_readout_error: 0.005,
  },
  "braket:ankaa-3": {
    native_gates: ["rx", "rz", "cz"],
    median_t1_us: 28,
    median_t2_us: 19,
    median_gate_error_1q: 0.0009,
    median_gate_error_2q: 0.0031,
    median_readout_error: 0.021,
  },
  "braket:garnet": {
    native_gates: ["r", "cz"],
    median_t1_us: 41,
    median_t2_us: 33,
    median_gate_error_1q: 0.0006,
    median_gate_error_2q: 0.0018,
    median_readout_error: 0.016,
  },
};
