"use client";

import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface EngineCapabilities {
  qos_features_supported: string[];
  composition_nodes_supported: string[];
  objective_types_supported: string[];
  constraints_supported: string[];
  type: string;
  schema_version: string;
}

export interface EngineInfo {
  id: string;
  capabilities: EngineCapabilities;
  active: boolean;
}

async function fetchEngines(): Promise<EngineInfo[]> {
  const result = await apiClient.GET("/engines").catch(() => null);
  if (!result || result.error) return [];
  return result.data.result as unknown as EngineInfo[];
}

export function useEngines() {
  return useQuery({ queryKey: ["engines"], queryFn: fetchEngines });
}

// "MONO" for a single scalarized winner, "MANY" for Pareto-front engines —
// matches openbinding.models.MonoObjective/ManyObjective's `type` literal.
export function engineSupportsMode(engine: EngineInfo, pareto: boolean): boolean {
  const wanted = pareto ? "MANY" : "MONO";
  return engine.capabilities.objective_types_supported.includes(wanted);
}
