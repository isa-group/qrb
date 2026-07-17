"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ConstraintOp } from "./constraint-ops";

export interface PresetConstraint {
  feature: string;
  op: ConstraintOp;
  value: number;
}

export interface Preset {
  weights: Record<string, number>;
  constraints: PresetConstraint[];
}

export type PresetMap = Record<string, Preset>;

const USER_PRESETS_STORAGE_KEY = "qrb:playground:user-presets";

// User-created presets never reach the backend (per design: only built-ins
// are server-side) — they live entirely in localStorage, same mental model
// as the CLI's user presets.toml but scoped to this browser.
export function loadUserPresets(): PresetMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(USER_PRESETS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PresetMap) : {};
  } catch {
    return {};
  }
}

function persistUserPresets(presets: PresetMap): void {
  window.localStorage.setItem(USER_PRESETS_STORAGE_KEY, JSON.stringify(presets));
}

async function fetchBuiltinPresets(): Promise<PresetMap> {
  const result = await apiClient.GET("/presets").catch(() => null);
  if (!result || result.error) return {};
  return result.data.result as unknown as PresetMap;
}

export function usePresets() {
  const builtinsQuery = useQuery({
    queryKey: ["presets"],
    queryFn: fetchBuiltinPresets,
  });
  const [userPresets, setUserPresets] = useState<PresetMap>({});

  useEffect(() => {
    // localStorage isn't available during SSR — deferring the read to an
    // effect (post-mount) avoids a hydration mismatch, same pattern as
    // use-catalog.ts's queueHistory accumulation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUserPresets(loadUserPresets());
  }, []);

  const builtinNames = useMemo(
    () => new Set(Object.keys(builtinsQuery.data ?? {})),
    [builtinsQuery.data]
  );

  // User presets of the same name override a built-in, mirroring the CLI's
  // all_presets() merge order.
  const presets = useMemo(
    () => ({ ...(builtinsQuery.data ?? {}), ...userPresets }),
    [builtinsQuery.data, userPresets]
  );

  const saveUserPreset = useCallback((name: string, preset: Preset) => {
    setUserPresets((prev) => {
      const next = { ...prev, [name]: preset };
      persistUserPresets(next);
      return next;
    });
  }, []);

  const deleteUserPreset = useCallback((name: string) => {
    setUserPresets((prev) => {
      const next = { ...prev };
      delete next[name];
      persistUserPresets(next);
      return next;
    });
  }, []);

  return {
    presets,
    builtinNames,
    saveUserPreset,
    deleteUserPreset,
    isLoading: builtinsQuery.isLoading,
  };
}
