"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Info, X } from "lucide-react";

import { BackendStatus } from "@/components/backend-status";
import { CircuitEditor } from "@/components/circuit-editor";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CONSTRAINABLE_FEATURE_BY_ID,
  CONSTRAINABLE_FEATURES,
  labelForConstrainableFeature,
} from "@/lib/playground/constrainable-features";
import { CONSTRAINT_OPS } from "@/lib/playground/constraint-ops";
import { addConstraint, removeConstraint } from "@/lib/playground/constraints";
import { useEngines, engineSupportsMode } from "@/lib/playground/engines";
import {
  OBJECTIVE_FEATURES,
  labelForFeature,
} from "@/lib/playground/objective-features";
import { usePresets, type Preset } from "@/lib/playground/presets";
import {
  DEFAULT_TASK_SPEC_FORM,
  taskSpecFormSchema,
  type ConstraintsFormValue,
  type TaskSpecFormInput,
  type TaskSpecFormValues,
} from "@/lib/playground/schema";
import {
  addCriterion,
  redistributeWeights,
  removeCriterion,
} from "@/lib/playground/weights";

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-body text-ink-secondary">
        {label}
      </Label>
      {children}
      {error && <p className="text-caption text-violation">{error}</p>}
    </div>
  );
}

function constraintsToArray(constraints: ConstraintsFormValue): Preset["constraints"] {
  return Object.entries(constraints).map(([feature, { op, value }]) => ({
    feature,
    op,
    value,
  }));
}

function constraintsFromArray(constraints: Preset["constraints"]): ConstraintsFormValue {
  return Object.fromEntries(
    constraints.map((c) => [c.feature, { op: c.op, value: c.value }])
  );
}

function presetFromValues(values: TaskSpecFormValues): Preset {
  return {
    weights: values.weights,
    constraints: constraintsToArray(values.constraints),
  };
}

function weightsMatch(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((k) => a[k] === b[k]);
}

function constraintsMatch(a: ConstraintsFormValue, b: ConstraintsFormValue): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => b[k] && a[k].op === b[k].op && a[k].value === b[k].value)
  );
}

// §14, §10: the declarative problem definition. Ends in a single primary
// action — Resolve Binding — per §10's Primary Action rule (exactly one per
// surface).
export function TaskSpecificationPanel({
  onChange,
  onResolve,
  resolving,
  circuitError,
}: {
  onChange: (values: TaskSpecFormValues | null) => void;
  onResolve: (values: TaskSpecFormValues) => void;
  resolving: boolean;
  circuitError?: string;
}) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    control,
    formState: { errors },
  } = useForm<TaskSpecFormInput, unknown, TaskSpecFormValues>({
    resolver: zodResolver(taskSpecFormSchema),
    defaultValues: DEFAULT_TASK_SPEC_FORM,
    mode: "onChange",
  });

  const provider = watch("providerConstraint");
  const weights = watch("weights") ?? {};
  const constraints = watch("constraints") ?? {};
  const pareto = watch("pareto");
  const engine = watch("engine");
  const forceRefresh = watch("forceRefresh");

  const { presets, saveUserPreset } = usePresets();
  const enginesQuery = useEngines();
  const [savePresetName, setSavePresetName] = useState("");
  // What "Load preset…" last applied, so the panel can show which preset
  // (if any) the current criteria/constraints actually match — the Select
  // itself is reset to "" right after firing (see below) so it can't serve
  // as that indicator on its own.
  const [appliedPreset, setAppliedPreset] = useState<{
    name: string;
    weights: Record<string, number>;
    constraints: ConstraintsFormValue;
  } | null>(null);
  // These selects are one-shot actions ("load this preset", "add this
  // criterion/constraint"), not persistent settings — kept controlled and
  // reset to "" after firing so the trigger always shows its placeholder
  // again, rather than getting stuck showing the last thing picked (which
  // would misleadingly imply it's still "active" after further edits).
  const [presetPickerValue, setPresetPickerValue] = useState("");
  const [addCriterionValue, setAddCriterionValue] = useState("");
  const [addConstraintValue, setAddConstraintValue] = useState("");

  // Re-validate on every change so the Constraint Inspector stays live (§10)
  // without waiting for a submit. Uses RHF's subscription API rather than
  // calling onChange during render, which would be a render-phase side effect.
  useEffect(() => {
    const subscription = watch((values) => {
      const parsed = taskSpecFormSchema.safeParse(values);
      onChange(parsed.success ? parsed.data : null);
    });
    return () => subscription.unsubscribe();
  }, [watch, onChange]);

  useEffect(() => {
    const parsed = taskSpecFormSchema.safeParse(DEFAULT_TASK_SPEC_FORM);
    if (parsed.success) onChange(parsed.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the currently selected engine no longer supports the active MONO/
  // Multi mode, fall back to "auto" rather than submitting an incompatible
  // engine_id.
  useEffect(() => {
    if (!engine || !enginesQuery.data) return;
    const current = enginesQuery.data.find((e) => e.id === engine);
    if (current && !engineSupportsMode(current, pareto)) {
      setValue("engine", null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pareto, enginesQuery.data]);

  const activeFeatureIds = Object.keys(weights);
  const availableFeatures = OBJECTIVE_FEATURES.filter(
    (f) => !activeFeatureIds.includes(f.id)
  );
  const activeConstraintFeatures = Object.keys(constraints);
  const availableConstraintFeatures = CONSTRAINABLE_FEATURES.filter(
    (f) => !activeConstraintFeatures.includes(f.id)
  );
  const compatibleEngines = (enginesQuery.data ?? []).filter((e) =>
    engineSupportsMode(e, pareto)
  );

  const isDirty =
    appliedPreset !== null &&
    (!weightsMatch(weights, appliedPreset.weights) ||
      !constraintsMatch(constraints, appliedPreset.constraints));

  const presetStatusLabel = appliedPreset
    ? isDirty
      ? `Modified from "${appliedPreset.name}" — save it as a new preset below`
      : `Using "${appliedPreset.name}"`
    : "Custom — no preset loaded";

  function applyPreset(name: string, preset: Preset) {
    setValue("weights", preset.weights, { shouldValidate: true });
    setValue("constraints", constraintsFromArray(preset.constraints), {
      shouldValidate: true,
    });
    setAppliedPreset({ name, weights: preset.weights, constraints: constraintsFromArray(preset.constraints) });
  }

  return (
    <form
      onSubmit={handleSubmit(onResolve)}
      className="rounded-md border border-hairline bg-panel p-4"
    >
      <div className="flex flex-col gap-1.5">
        <Controller
          name="circuitQasm"
          control={control}
          render={({ field }) => (
            <CircuitEditor value={field.value} onChange={field.onChange} />
          )}
        />
        {errors.circuitQasm && (
          <p className="text-caption text-violation">
            {errors.circuitQasm.message}
          </p>
        )}
        {!errors.circuitQasm && circuitError && (
          <p className="text-caption text-violation">{circuitError}</p>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label="Shots" htmlFor="shots" error={errors.shots?.message}>
          <Input
            id="shots"
            type="number"
            className="font-geist-mono"
            {...register("shots")}
          />
        </Field>

        <Field label="Provider" htmlFor="providerConstraint">
          <Select
            value={provider}
            onValueChange={(v) =>
              setValue(
                "providerConstraint",
                v as TaskSpecFormInput["providerConstraint"]
              )
            }
          >
            <SelectTrigger id="providerConstraint" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any</SelectItem>
              <SelectItem value="ibm">IBM</SelectItem>
              <SelectItem value="braket">Braket</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="mt-6 border-t border-hairline pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-subheading font-medium text-ink-primary">
            Preset
          </h3>
          <Select
            value={presetPickerValue}
            onValueChange={(name) => {
              const preset = presets[name];
              if (preset) applyPreset(name, preset);
              setPresetPickerValue("");
            }}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Load preset…" />
            </SelectTrigger>
            <SelectContent>
              {Object.keys(presets).map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p
          className={`mt-2 text-caption ${isDirty ? "text-primary" : "text-ink-tertiary"}`}
        >
          {presetStatusLabel}
        </p>
        <p className="mt-1 text-caption text-ink-tertiary">
          A preset sets both the constraints and the weighted criteria below —
          picking one replaces both.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <Input
            type="text"
            placeholder="Save current constraints & criteria as…"
            className="flex-1"
            value={savePresetName}
            onChange={(e) => setSavePresetName(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!savePresetName.trim()}
            onClick={() => {
              const values = watch();
              const parsed = taskSpecFormSchema.safeParse(values);
              if (!parsed.success) return;
              const name = savePresetName.trim();
              saveUserPreset(name, presetFromValues(parsed.data));
              setAppliedPreset({ name, weights: parsed.data.weights, constraints: parsed.data.constraints });
              setSavePresetName("");
            }}
          >
            Save
          </Button>
        </div>
      </div>

      <div className="mt-6 border-t border-hairline pt-4">
        <h3 className="text-subheading font-medium text-ink-primary">
          Constraints
        </h3>

        <div className="mt-3 flex flex-col gap-3">
          {activeConstraintFeatures.map((id) => {
            const feature = CONSTRAINABLE_FEATURE_BY_ID.get(id);
            return (
              <div key={id} className="flex items-center gap-3">
                <span className="flex w-52 shrink-0 items-center gap-1.5 text-body text-ink-secondary">
                  {labelForConstrainableFeature(id)}
                  {feature && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="size-3.5 text-ink-tertiary" />
                      </TooltipTrigger>
                      <TooltipContent>
                        {feature.description} Unit: {feature.unit}.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </span>
                <Select
                  value={constraints[id].op}
                  onValueChange={(op) =>
                    setValue(
                      "constraints",
                      {
                        ...constraints,
                        [id]: { ...constraints[id], op: op as (typeof CONSTRAINT_OPS)[number]["value"] },
                      },
                      { shouldValidate: true }
                    )
                  }
                >
                  <SelectTrigger className="w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONSTRAINT_OPS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  step="any"
                  className="w-32 font-geist-mono"
                  value={constraints[id].value}
                  onChange={(e) =>
                    setValue(
                      "constraints",
                      {
                        ...constraints,
                        [id]: { ...constraints[id], value: Number(e.target.value) },
                      },
                      { shouldValidate: true }
                    )
                  }
                />
                {feature && (
                  <span className="w-24 shrink-0 text-caption text-ink-tertiary">
                    {feature.unit}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${labelForConstrainableFeature(id)} constraint`}
                  onClick={() =>
                    setValue("constraints", removeConstraint(constraints, id), {
                      shouldValidate: true,
                    })
                  }
                  className="text-ink-tertiary hover:text-violation"
                >
                  <X className="size-4" />
                </button>
              </div>
            );
          })}
        </div>

        {availableConstraintFeatures.length > 0 && (
          <div className="mt-3">
            <Select
              value={addConstraintValue}
              onValueChange={(id) => {
                setValue("constraints", addConstraint(constraints, id), {
                  shouldValidate: true,
                });
                setAddConstraintValue("");
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="+ Add constraint" />
              </SelectTrigger>
              <SelectContent>
                {availableConstraintFeatures.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="mt-6 border-t border-hairline pt-4">
        <h3 className="text-subheading font-medium text-ink-primary">
          Criteria
        </h3>

        <div className="mt-3 flex flex-col gap-3">
          {activeFeatureIds.map((id) => (
            <div key={id} className="flex items-center gap-3">
              <span className="w-44 shrink-0 text-body text-ink-secondary">
                {labelForFeature(id)}
              </span>
              <Slider
                value={[weights[id]]}
                min={0}
                max={1}
                step={0.01}
                onValueChange={([v]) =>
                  setValue("weights", redistributeWeights(weights, id, v), {
                    shouldValidate: true,
                  })
                }
                className="flex-1"
              />
              <span className="w-12 shrink-0 text-right font-geist-mono text-mono-body text-ink-primary">
                {Math.round(weights[id] * 100)}%
              </span>
              <button
                type="button"
                aria-label={`Remove ${labelForFeature(id)}`}
                onClick={() =>
                  setValue("weights", removeCriterion(weights, id), {
                    shouldValidate: true,
                  })
                }
                className="text-ink-tertiary hover:text-violation"
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
          {errors.weights?.message && (
            <p className="text-caption text-violation">
              {String(errors.weights.message)}
            </p>
          )}
        </div>

        {availableFeatures.length > 0 && (
          <div className="mt-3">
            <Select
              value={addCriterionValue}
              onValueChange={(id) => {
                setValue("weights", addCriterion(weights, id), {
                  shouldValidate: true,
                });
                setAddCriterionValue("");
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="+ Add criterion" />
              </SelectTrigger>
              <SelectContent>
                {availableFeatures.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="mt-6 border-t border-hairline pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-subheading font-medium text-ink-primary">
            Solver
          </h3>
          <BackendStatus />
        </div>
        <div className="mt-3 flex items-center gap-4">
          <div className="flex overflow-hidden rounded-lg border border-hairline">
            <button
              type="button"
              onClick={() => setValue("pareto", false)}
              className={`px-3 py-1.5 text-body ${!pareto ? "bg-primary text-primary-foreground" : "text-ink-secondary"}`}
            >
              Mono
            </button>
            <button
              type="button"
              onClick={() => setValue("pareto", true)}
              className={`px-3 py-1.5 text-body ${pareto ? "bg-primary text-primary-foreground" : "text-ink-secondary"}`}
            >
              Multi (Pareto)
            </button>
          </div>

          <Select
            value={engine ?? "auto"}
            onValueChange={(v) => setValue("engine", v === "auto" ? null : v)}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              {compatibleEngines.map((e) => (
                <SelectItem key={e.id} value={e.id} disabled={!e.active}>
                  {e.id}
                  {!e.active ? " (inactive)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <label className="mt-3 flex items-center gap-2 text-body text-ink-secondary">
          <Checkbox
            checked={forceRefresh}
            onCheckedChange={(checked) => setValue("forceRefresh", checked === true)}
          />
          Fetch live catalog
          <span className="text-mono-caption text-ink-tertiary">
            (off reuses the 90s cache — faster, may be stale)
          </span>
        </label>
      </div>

      <Button type="submit" className="mt-6 w-full" disabled={resolving}>
        {resolving ? "Resolving…" : "Resolve Binding"}
      </Button>
    </form>
  );
}
