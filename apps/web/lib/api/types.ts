import type { components } from "./schema";

export interface CatalogResource {
  candidate_id: string;
  name: string;
  provider_id: string;
  vendor: string;
  num_qubits: number;
  queue_length: number;
  status: string;
  operational: boolean;
  last_calibrated_at: string | null;
}

export interface CatalogResourceDetail extends CatalogResource {
  native_gates: string[];
  median_t1_us: number | null;
  median_t2_us: number | null;
  median_gate_error_1q: number | null;
  median_gate_error_2q: number | null;
  median_readout_error: number | null;
}

export type CatalogTimings = components["schemas"]["CatalogTimingsResponse"];
