"use client";

import {
  ArrowCounterClockwise,
  Lock,
  Plus,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { highlight } from "@/components/highlight";
import { RequestError, getBind } from "@/lib/auth";
import {
  API_BASE_URL,
  api,
  type SelectRequest,
  type SelectResponse,
} from "@/lib/api/client";

import styles from "./bind.module.css";
import {
  OPS,
  OP_WORDS,
  booleanSentence,
  booleans,
  constrainable,
  defaultOp,
  featureColor,
  grouped,
  higherIsBetter,
  label,
  step,
  unitLabel,
  weightable,
  type Feature,
  type Op,
} from "./features";
import { Results, type Outcome } from "./results";

// ---------- setup model ----------

const SAMPLE_CIRCUIT = `OPENQASM 3.0;
include "stdgates.inc";
qubit[3] q;
bit[3] c;
h q[0];
cx q[0], q[1];
cx q[1], q[2];
c = measure q;
`;

const PRESET_NAMES: Record<string, string> = {
  balanced: "Balanced",
  "fidelity-first": "Fidelity first",
  cheapest: "Cheapest",
  fastest: "Fastest",
  "nisq-analyzer": "NISQ Analyzer",
  "q-orchestrator": "Q-Orchestrator",
  "mqt-predictor": "MQT Predictor",
};
const LITERATURE = new Set([
  "nisq-analyzer",
  "q-orchestrator",
  "mqt-predictor",
]);
const presetName = (id: string) => PRESET_NAMES[id] ?? id;

type Weight = { feature: string; value: number };
type Bound = { key: number; feature: string; op: Op; value: string };
type Setup = { weights: Weight[]; bounds: Bound[]; required: string[] };
type Preset = {
  weights: Record<string, number>;
  constraints: { feature: string; op: string; value: number }[];
};
type Provider = "any" | "ibm" | "braket";

const PROVIDERS: { id: Provider; name: string }[] = [
  { id: "any", name: "Any" },
  { id: "ibm", name: "IBM Quantum" },
  { id: "braket", name: "Amazon Braket" },
];

let nextKey = 1;

function setupFromPreset(p: Preset, boolIds: Set<string>): Setup {
  const required: string[] = [];
  const bounds: Bound[] = [];
  for (const c of p.constraints) {
    if (boolIds.has(c.feature) && c.op === ">=" && c.value === 1)
      required.push(c.feature);
    else
      bounds.push({
        key: nextKey++,
        feature: c.feature,
        op: c.op as Op,
        value: String(c.value),
      });
  }
  return {
    // Importance in points (0-100): a preset's weights sum to 1, so its points are its percentages.
    weights: Object.entries(p.weights).map(([feature, value]) => ({
      feature,
      value: Math.round(value * 100),
    })),
    bounds,
    required,
  };
}

/** Same weights and constraints as the preset, ignoring order and row identity. */
function sameAsPreset(s: Setup, p: Preset, boolIds: Set<string>): boolean {
  const ref = setupFromPreset(p, boolIds);
  const w = (x: Weight[]) =>
    JSON.stringify([...x].sort((a, b) => a.feature.localeCompare(b.feature)));
  const b = (x: Bound[]) =>
    JSON.stringify(x.map((c) => [c.feature, c.op, Number(c.value)]).sort());
  return (
    w(s.weights) === w(ref.weights) &&
    b(s.bounds) === b(ref.bounds) &&
    JSON.stringify([...s.required].sort()) ===
      JSON.stringify([...ref.required].sort())
  );
}

// Each weight is an independent importance (0-100 points); moving one never moves another. What is
// sent is each one's share of the total, in hundredths with largest-remainder rounding, so the
// request's weights always add up to exactly 1.
function spread(total: number, parts: number[]): number[] {
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum <= 0) return parts.map(() => 0);
  const raw = parts.map((p) => (p * total) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => [x - Math.floor(x), i] as const)
    .sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--)
    out[order[k][1]]++;
  return out;
}
/** Shares in hundredths (sum 100), aligned with `ws`. */
const sharesOf = (ws: Weight[]) =>
  spread(
    100,
    ws.map((w) => w.value),
  );

function curlFor(body: SelectRequest): string {
  return `curl -sS -X POST "${API_BASE_URL}/select" \\
  -H "Content-Type: application/json" \\
  --data-binary @- <<'JSON'
${JSON.stringify(body, null, 2)}
JSON`;
}

// ---------- validation ----------

type Errors = {
  circuit?: string;
  weights?: string;
  shots?: string;
  bounds: Record<number, string>;
};

function validate(
  circuit: string,
  setup: Setup,
  shots: string,
  byId: Map<string, Feature>,
): Errors {
  const e: Errors = { bounds: {} };
  if (!circuit.trim())
    e.circuit = "Paste an OpenQASM 3 circuit, or open a .qasm file.";
  if (!setup.weights.length) e.weights = "Add at least one weight.";
  else if (!setup.weights.some((w) => w.value > 0))
    e.weights = "Give at least one feature some importance.";
  const n = Number(shots);
  if (!Number.isInteger(n) || n < 1)
    e.shots = "Shots must be a whole number of at least 1.";
  for (const b of setup.bounds) {
    const f = byId.get(b.feature);
    if (b.value.trim() === "" || Number.isNaN(Number(b.value)))
      e.bounds[b.key] = "Enter a number.";
    else if (
      f &&
      (Number(b.value) < f.valid_range.min ||
        Number(b.value) > f.valid_range.max)
    )
      e.bounds[b.key] =
        `Must be between ${f.valid_range.min} and ${f.valid_range.max}.`;
  }
  return e;
}
const hasErrors = (e: Errors) =>
  Boolean(e.circuit || e.weights || e.shots || Object.keys(e.bounds).length);

// ---------- component ----------

type Meta = { features: Feature[]; presets: Record<string, Preset> };

export function BindWorkspace({
  initialPreset,
  initialWeights,
  initialProvider,
  initialBind,
}: {
  initialPreset?: string;
  initialWeights?: Record<string, number>;
  initialProvider?: "ibm" | "braket";
  /** Id of a bind stored on the signed-in account, to reopen (unsolved). */
  initialBind?: string;
}) {
  const [meta, setMeta] = useState<Meta | null>(null);
  // Loading features and presets failed: the HTTP status (0: unreachable) and, for 429, the wait.
  const [metaError, setMetaError] = useState<{ status: number; retryAfter?: number } | null>(null);
  const [metaAttempt, setMetaAttempt] = useState(0);

  const [circuit, setCircuit] = useState(SAMPLE_CIRCUIT);
  const [basePreset, setBasePreset] = useState("balanced");
  const [setup, setSetup] = useState<Setup>({
    weights: [],
    bounds: [],
    required: [],
  });
  const [provider, setProvider] = useState<Provider>(initialProvider ?? "any");
  const [shots, setShots] = useState("1024");
  const [pareto, setPareto] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
  // Reopening a stored bind (?bind=): what happened, shown above the inputs.
  const [reopened, setReopened] = useState<
    { state: "loading" } | { state: "done"; at: string } | { state: "failed"; message: string } | null
  >(initialBind ? { state: "loading" } : null);
  // Off: the stored catalog, queues refreshed every 2 minutes (1 unit). On: ask the providers now (5 units).
  const [freshData, setFreshData] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hl = useRef<HTMLElement>(null);
  const ids = useId();

  // Feature metadata and presets: fetched once, from the free GET /features and GET /presets.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [feat, pre] = await Promise.all([api.GET("/features"), api.GET("/presets")]);
        if (!feat.data || !pre.data) {
          const failed = !feat.data ? feat.response : pre.response;
          if (live)
            setMetaError({
              status: failed.status,
              retryAfter: Number(failed.headers.get("retry-after")) || undefined,
            });
          return;
        }
        if (!live) return;
        const presets = pre.data.result as unknown as Record<string, Preset>;
        const features = feat.data.result;
        const boolIds = new Set(booleans(features).map((f) => f.id));
        const start =
          initialPreset && presets[initialPreset] ? initialPreset : "balanced";
        setMeta({ features, presets });
        setBasePreset(start);
        const base = setupFromPreset(presets[start], boolIds);
        // ?weights= overrides the preset's weights (unknown or unweightable features are dropped).
        const known = new Set(weightable(features).map((f) => f.id));
        const custom = Object.entries(initialWeights ?? {}).filter(([k]) =>
          known.has(k),
        );
        setSetup(
          custom.length
            ? {
                ...base,
                weights: custom.map(([feature, v]) => ({
                  feature,
                  value: Math.round(Math.min(1, v) * 100),
                })),
              }
            : base,
        );
        if (initialBind) {
          try {
            const stored = await getBind(initialBind);
            if (!live) return;
            const p = stored.request.preferences;
            const fromPreset = p.preset && presets[p.preset] ? presets[p.preset] : null;
            // A stored bind carries the weights and constraints it was solved with; a preset bind
            // (from the API) carries only the preset's name.
            const restored = fromPreset ?? {
              weights: Object.fromEntries(Object.entries(p.weights ?? {}).filter(([k]) => known.has(k))),
              constraints: p.constraints ?? [],
            };
            const next = setupFromPreset(restored, boolIds);
            const matching = Object.keys(presets).find((id) => sameAsPreset(next, presets[id], boolIds));
            setBasePreset(p.preset && presets[p.preset] ? p.preset : (matching ?? start));
            setSetup(next);
            setCircuit(stored.request.circuit_qasm);
            setShots(String(stored.request.shots));
            setProvider(p.require_provider === "ibm" || p.require_provider === "braket" ? p.require_provider : "any");
            setPareto(Boolean(p.pareto));
            setReopened({ state: "done", at: stored.at });
          } catch (e) {
            if (!live) return;
            const message =
              e instanceof RequestError && e.status === 404
                ? "This bind is no longer stored (binds are kept 30 days)."
                : e instanceof RequestError && e.status === 401
                  ? "Sign in to reopen your stored binds."
                  : `The stored bind could not be loaded. ${(e as Error).message}`;
            setReopened({ state: "failed", message });
          }
        }
      } catch {
        if (live) setMetaError({ status: 0 });
      }
    })();
    return () => {
      live = false;
    };
  }, [initialPreset, initialWeights, initialBind, metaAttempt]);

  const byId = useMemo(
    () => new Map((meta?.features ?? []).map((f) => [f.id, f])),
    [meta],
  );
  const boolFeatures = useMemo(() => booleans(meta?.features ?? []), [meta]);
  const boolIds = useMemo(
    () => new Set(boolFeatures.map((f) => f.id)),
    [boolFeatures],
  );
  const weightFeatures = useMemo(
    () => weightable(meta?.features ?? []),
    [meta],
  );
  const boundFeatures = useMemo(
    () => constrainable(meta?.features ?? []),
    [meta],
  );

  const errors = validate(circuit, setup, shots, byId);
  const custom = meta
    ? !sameAsPreset(setup, meta.presets[basePreset], boolIds)
    : false;

  const shares = sharesOf(setup.weights);
  const request: SelectRequest = {
    circuit_qasm: circuit,
    preferences: {
      // Zero-importance features are left out rather than sent as 0.
      weights: Object.fromEntries(
        setup.weights.flatMap((w, i) =>
          shares[i] > 0 ? [[w.feature, shares[i] / 100]] : [],
        ),
      ),
      constraints: [
        ...setup.required.map((feature) => ({
          feature,
          op: ">=" as const,
          value: 1,
        })),
        ...setup.bounds.map((b) => ({
          feature: b.feature,
          op: b.op,
          value: Number(b.value),
        })),
      ],
      require_provider: provider === "any" ? null : provider,
      pareto,
    },
    shots: Number(shots),
    live: true,
    // Default: the stored catalog (queues refreshed every 2 minutes). The switch asks the providers now.
    ...(freshData ? { force_refresh: true } : {}),
  };

  const applyPreset = (id: string) => {
    if (!meta) return;
    setBasePreset(id);
    setSetup(setupFromPreset(meta.presets[id], boolIds));
  };

  const solve = async () => {
    if (!meta || outcome.state === "solving") return;
    if (hasErrors(errors)) {
      setShowErrors(true);
      return;
    }
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const sent = request;
    const startedAt = Date.now();
    setOutcome({ state: "solving", startedAt, pareto });
    const stacked = window.matchMedia("(max-width: 1024px)").matches;
    if (stacked) {
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      requestAnimationFrame(() =>
        resultsRef.current?.scrollIntoView({
          behavior: reduced ? "auto" : "smooth",
          block: "start",
        }),
      );
    }
    try {
      const { data, error, response } = await api.POST("/select", {
        body: sent,
        signal: ctrl.signal,
      });
      if (data) {
        setOutcome({
          state: "done",
          response: data as SelectResponse,
          curl: curlFor(sent),
          sent,
        });
      } else {
        const raw = (error as { detail?: unknown } | undefined)?.detail;
        // FastAPI sends a string for handled errors and a list of field errors for schema failures.
        const detail =
          typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? raw
                  .map((d) => (d as { msg?: string }).msg ?? "")
                  .filter(Boolean)
                  .join("; ")
              : "";
        const retryAfter = Number(response.headers.get("retry-after")) || undefined;
        setOutcome({ state: "failed", status: response.status, detail, retryAfter });
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") setOutcome({ state: "idle" });
      else {
        setOutcome({ state: "failed", status: 0, detail: "" });
      }
    }
  };

  const cancel = () => abort.current?.abort();
  const updateSetup = (fn: (s: Setup) => Setup) => setSetup((s) => fn(s));

  const circuitError =
    (showErrors && errors.circuit) ||
    (outcome.state === "failed" && outcome.status === 422 && outcome.detail
      ? `The circuit did not parse: ${outcome.detail.replace(/^"|"$/g, "")}`
      : "");

  const openFile = (file: File | undefined) => {
    if (!file) return;
    file.text().then(setCircuit);
  };

  if (metaError) {
    return (
      <div className={styles.page}>
        <div className={styles.blocked} role="alert">
          <WarningCircle size={24} aria-hidden />
          {metaError.status === 429 ? (
            <>
              <h1 className="heading-5">Too many requests from your address</h1>
              <p className="body-3 soft">
                QRB limits how often one IP address may call it.{" "}
                {metaError.retryAfter
                  ? `Try again in ${metaError.retryAfter < 90 ? `${metaError.retryAfter} s` : `${Math.ceil(metaError.retryAfter / 60)} min`}.`
                  : "Try again in a moment."}
              </p>
            </>
          ) : (
            <>
              <h1 className="heading-5">
                {metaError.status === 0 ? "The QRB API could not be reached" : "Bind could not load its features and presets"}
              </h1>
              <p className="body-3 soft">
                Bind needs the QRB API to list features and presets and to solve.
                {metaError.status > 0 && ` It answered ${metaError.status}.`} Try again in a moment.
              </p>
            </>
          )}
          <button
            type="button"
            className="btn btn-secondary button-md"
            onClick={() => {
              setMetaError(null);
              setMetaAttempt((n) => n + 1);
            }}
          >
            <ArrowCounterClockwise size={16} aria-hidden /> Try again
          </button>
        </div>
      </div>
    );
  }

  const solving = outcome.state === "solving";
  const usedWeights = new Set(setup.weights.map((w) => w.feature));
  const addableWeights = weightFeatures.filter((f) => !usedWeights.has(f.id));

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className="heading-5">Bind a circuit</h1>
        <p className="caption-2 muted">
          QRB selects a QPU for your circuit. It never submits or runs it.
        </p>
        {reopened && reopened.state !== "loading" && (
          <p
            className={`${styles.reopened} caption-2`}
            data-failed={reopened.state === "failed" || undefined}
            role={reopened.state === "failed" ? "alert" : "status"}
          >
            {reopened.state === "done" ? (
              <>
                Reopened your bind of{" "}
                {new Date(reopened.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Solve to bind it
                again on current data.
              </>
            ) : (
              <>
                <WarningCircle size={16} aria-hidden /> {reopened.message}
              </>
            )}
          </p>
        )}
      </header>

      <div className={styles.grid}>
        <form
          className={styles.inputs}
          aria-label="Circuit and preferences"
          onSubmit={(e) => {
            e.preventDefault();
            void solve();
          }}
        >
          {/* Circuit */}
          <section className={styles.block} aria-labelledby={`${ids}-circuit`}>
            <div className={styles.blockHead}>
              <h2 id={`${ids}-circuit`} className="title-3">
                Circuit
              </h2>
              <div className={styles.tools}>
                <button
                  type="button"
                  className="btn btn-secondary button-sm"
                  onClick={() => fileRef.current?.click()}
                >
                  <UploadSimple size={16} aria-hidden /> Open .qasm
                </button>
                <button
                  type="button"
                  className="btn btn-secondary button-sm"
                  onClick={() => setCircuit(SAMPLE_CIRCUIT)}
                  aria-disabled={circuit === SAMPLE_CIRCUIT}
                  title={
                    circuit === SAMPLE_CIRCUIT
                      ? "The sample circuit is already loaded"
                      : undefined
                  }
                >
                  Load sample
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".qasm,.txt,text/plain"
                  hidden
                  onChange={(e) => {
                    openFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
            <label htmlFor={`${ids}-qasm`} className="caption-2 muted">
              OpenQASM 3
              {circuit === SAMPLE_CIRCUIT ? ", sample: 3 qubit GHZ state" : ""}
            </label>
            <div className={styles.editor}>
              <pre className={`${styles.code} ${styles.codeLayer}`} aria-hidden>
                <code ref={hl}>{highlight(circuit + "\n", "qasm")}</code>
              </pre>
              <textarea
                id={`${ids}-qasm`}
                className={`${styles.code} ${styles.codeInput}`}
                wrap="off"
                value={circuit}
                onChange={(e) => {
                  setCircuit(e.target.value);
                  // A parse error describes the old text; drop it once the circuit changes.
                  if (outcome.state === "failed" && outcome.status === 422)
                    setOutcome({ state: "idle" });
                }}
                onScroll={(e) => {
                  // The highlighted copy follows the textarea's scroll.
                  if (hl.current)
                    hl.current.style.transform = `translate(${-e.currentTarget.scrollLeft}px, ${-e.currentTarget.scrollTop}px)`;
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                rows={Math.min(18, Math.max(9, circuit.split("\n").length + 1))}
                aria-invalid={Boolean(circuitError)}
                aria-describedby={circuitError ? `${ids}-qasm-err` : undefined}
              />
            </div>
            {circuitError && (
              <FieldError id={`${ids}-qasm-err`}>{circuitError}</FieldError>
            )}
          </section>

          {/* Preset */}
          <section className={styles.block} aria-labelledby={`${ids}-pref`}>
            <h2 id={`${ids}-pref`} className="title-3">
              Preferences
            </h2>
            <div className={styles.field}>
              <label htmlFor={`${ids}-preset`} className="caption-2 muted">
                Start from a preset
              </label>
              <select
                id={`${ids}-preset`}
                className={styles.control}
                value={custom ? "__custom" : basePreset}
                disabled={!meta}
                onChange={(e) =>
                  e.target.value !== "__custom" && applyPreset(e.target.value)
                }
              >
                {custom && (
                  <option value="__custom">
                    Custom (from {presetName(basePreset)})
                  </option>
                )}
                {meta && (
                  <>
                    <optgroup label="General">
                      {Object.keys(meta.presets)
                        .filter((id) => !LITERATURE.has(id))
                        .map((id) => (
                          <option key={id} value={id}>
                            {presetName(id)}
                          </option>
                        ))}
                    </optgroup>
                    <optgroup label="Approaches from the literature">
                      {Object.keys(meta.presets)
                        .filter((id) => LITERATURE.has(id))
                        .map((id) => (
                          <option key={id} value={id}>
                            {presetName(id)}
                          </option>
                        ))}
                    </optgroup>
                  </>
                )}
              </select>
            </div>
          </section>

          {/* Weights */}
          <section className={styles.block} aria-labelledby={`${ids}-weights`}>
            <div className={styles.blockHead}>
              <h2 id={`${ids}-weights`} className="title-3">
                Objective weights
              </h2>
            </div>
            <p className="caption-2 muted">
              How much each feature counts when ranking feasible QPUs.
            </p>
            {!meta && <SkeletonRows n={3} />}
            <ul className={styles.rows}>
              {setup.weights.map((w, i) => {
                const f = byId.get(w.feature);
                const id = `${ids}-w-${w.feature}`;
                const name = f ? label(f) : w.feature;
                return (
                  <li
                    key={w.feature}
                    className={styles.weight}
                    style={{ ["--w" as string]: featureColor(w.feature) }}
                  >
                    <label htmlFor={id} className={styles.rowLabel}>
                      <span className="title-4">{name}</span>
                      <span className="caption-2 muted">
                        {f &&
                          (higherIsBetter(f)
                            ? "higher is better"
                            : "lower is better")}
                        {f && unitLabel(f) ? ` · ${unitLabel(f)}` : ""}
                      </span>
                    </label>
                    <input
                      id={id}
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={w.value}
                      aria-valuetext={`${shares[i]}% of the objective`}
                      className={styles.range}
                      onChange={(e) =>
                        updateSetup((s) => ({
                          ...s,
                          weights: s.weights.map((x) =>
                            x.feature === w.feature
                              ? { ...x, value: Number(e.target.value) }
                              : x,
                          ),
                        }))
                      }
                    />
                    <output htmlFor={id} className={`${styles.share} title-4`}>
                      {shares[i]}%
                    </output>
                    <RemoveButton
                      name={`${name} weight`}
                      onClick={() =>
                        updateSetup((s) => ({
                          ...s,
                          weights: s.weights.filter(
                            (x) => x.feature !== w.feature,
                          ),
                        }))
                      }
                    />
                  </li>
                );
              })}
            </ul>
            {setup.weights.length > 0 && shares.some((x) => x > 0) && (
              <div className={styles.split} aria-hidden>
                {setup.weights.map((w, i) =>
                  shares[i] > 0 ? (
                    <span
                      key={w.feature}
                      style={{
                        flexGrow: shares[i],
                        background: featureColor(w.feature),
                      }}
                      title={`${byId.get(w.feature) ? label(byId.get(w.feature)!) : w.feature}: ${shares[i]}%`}
                    ></span>
                  ) : null,
                )}
              </div>
            )}
            {setup.weights.length > 0 && (
              <p className="caption-2 muted">
                Set how much each feature matters. Shares always add up to 100%,
                and that split is what Solve sends.
              </p>
            )}
            {showErrors && errors.weights && (
              <FieldError>{errors.weights}</FieldError>
            )}
            {addableWeights.length > 0 && (
              <AddPicker
                label="Add a weight"
                features={addableWeights}
                onPick={(id) =>
                  updateSetup((s) => ({
                    ...s,
                    weights: [...s.weights, { feature: id, value: 50 }],
                  }))
                }
              />
            )}
          </section>

          {/* Constraints */}
          <section className={styles.block} aria-labelledby={`${ids}-cons`}>
            <h2 id={`${ids}-cons`} className="title-3">
              Constraints
            </h2>
            <p className="caption-2 muted">
              Hard limits. A QPU that breaks one is excluded, and the result
              says which.
            </p>
            {!meta && <SkeletonRows n={2} />}
            <ul className={styles.rows}>
              <li className={styles.locked}>
                <Lock size={16} aria-hidden />
                <span className="body-6">Enough qubits for your circuit</span>
                <span className="caption-2 muted">Added automatically</span>
              </li>
              {boolFeatures.map((f) => {
                const on = setup.required.includes(f.id);
                return (
                  <li key={f.id} className={styles.switchRow}>
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={on}
                        onChange={() =>
                          updateSetup((s) => ({
                            ...s,
                            required: on
                              ? s.required.filter((x) => x !== f.id)
                              : [...s.required, f.id],
                          }))
                        }
                      />
                      <span className="body-6">{booleanSentence(f)}</span>
                    </label>
                  </li>
                );
              })}
              {setup.bounds.map((b) => {
                const f = byId.get(b.feature);
                const err = showErrors ? errors.bounds[b.key] : undefined;
                const name = f ? label(f) : b.feature;
                return (
                  <li key={b.key} className={styles.bound}>
                    <span className="title-4">{name}</span>
                    <select
                      className={styles.control}
                      value={b.op}
                      aria-label={`${name} comparison`}
                      onChange={(e) =>
                        updateSetup((s) => ({
                          ...s,
                          bounds: s.bounds.map((x) =>
                            x.key === b.key
                              ? { ...x, op: e.target.value as Op }
                              : x,
                          ),
                        }))
                      }
                    >
                      {OPS.map((op) => (
                        <option key={op} value={op}>
                          {OP_WORDS[op]}
                        </option>
                      ))}
                    </select>
                    <span className={styles.valueWrap}>
                      <input
                        type="number"
                        inputMode="decimal"
                        className={`${styles.control} ${styles.num}`}
                        value={b.value}
                        step={f ? step(f) : "any"}
                        min={f?.valid_range.min}
                        max={f?.valid_range.max}
                        aria-label={`${name} value${f && unitLabel(f) ? ` in ${unitLabel(f)}` : ""}`}
                        aria-invalid={Boolean(err)}
                        onChange={(e) =>
                          updateSetup((s) => ({
                            ...s,
                            bounds: s.bounds.map((x) =>
                              x.key === b.key
                                ? { ...x, value: e.target.value }
                                : x,
                            ),
                          }))
                        }
                      />
                      {f && unitLabel(f) && (
                        <span className="caption-2 muted">{unitLabel(f)}</span>
                      )}
                    </span>
                    <RemoveButton
                      name={`${name} constraint`}
                      onClick={() =>
                        updateSetup((s) => ({
                          ...s,
                          bounds: s.bounds.filter((x) => x.key !== b.key),
                        }))
                      }
                    />
                    {err && (
                      <FieldError className={styles.boundError}>
                        {err}
                      </FieldError>
                    )}
                  </li>
                );
              })}
            </ul>
            {boundFeatures.length > 0 && (
              <AddPicker
                label="Add a constraint"
                features={boundFeatures}
                onPick={(id) => {
                  const f = byId.get(id)!;
                  updateSetup((s) => ({
                    ...s,
                    bounds: [
                      ...s.bounds,
                      {
                        key: nextKey++,
                        feature: id,
                        op: defaultOp(f),
                        value: "",
                      },
                    ],
                  }));
                }}
              />
            )}
          </section>

          {/* Options */}
          <section className={styles.block} aria-labelledby={`${ids}-opts`}>
            <h2 id={`${ids}-opts`} className="title-3">
              Options
            </h2>
            <fieldset className={styles.field}>
              <legend className="caption-2 muted">Provider</legend>
              <div className={styles.segmented}>
                {PROVIDERS.map((p) => (
                  <label key={p.id}>
                    <input
                      type="radio"
                      name={`${ids}-provider`}
                      value={p.id}
                      checked={provider === p.id}
                      onChange={() => setProvider(p.id)}
                    />
                    <span className="body-5">{p.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={styles.optionRow}>
              <div className={styles.field}>
                <label htmlFor={`${ids}-shots`} className="caption-2 muted">
                  Shots
                </label>
                <input
                  id={`${ids}-shots`}
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  className={`${styles.control} ${styles.num}`}
                  value={shots}
                  onChange={(e) => setShots(e.target.value)}
                  aria-invalid={Boolean(showErrors && errors.shots)}
                  aria-describedby={`${ids}-shots-help`}
                />
                <span id={`${ids}-shots-help`} className="caption-2 muted">
                  Used to estimate cost. Nothing is run.
                </span>
                {showErrors && errors.shots && (
                  <FieldError>{errors.shots}</FieldError>
                )}
              </div>
              <div className={styles.switches}>
                <label className={`${styles.switch} ${styles.paretoSwitch}`}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={pareto}
                    onChange={(e) => setPareto(e.target.checked)}
                  />
                  <span>
                    <span className="body-6">Pareto mode</span>
                    <span className="caption-2 muted">
                      Return every non dominated binding instead of one optimum.
                    </span>
                  </span>
                </label>
                <label className={`${styles.switch} ${styles.paretoSwitch}`}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={freshData}
                    onChange={(e) => setFreshData(e.target.checked)}
                  />
                  <span>
                    <span className="body-6">Fetch fresh provider data</span>
                    <span className="caption-2 muted">
                      Asks IBM and Braket now: 5 units and tens of seconds.
                      Otherwise QRB uses queues it refreshes every 2 minutes.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </section>

          <div className={styles.actions}>
            <button
              type="submit"
              className="btn btn-primary button-md"
              aria-disabled={solving || !meta}
            >
              {solving ? "Solving…" : "Solve"}
            </button>
            {solving && (
              <button
                type="button"
                className="btn btn-secondary button-md"
                onClick={cancel}
              >
                Cancel
              </button>
            )}
            {showErrors && hasErrors(errors) && (
              <p className="caption-2" role="alert">
                Fix the highlighted fields to solve.
              </p>
            )}
          </div>
        </form>

        <Results
          ref={resultsRef}
          outcome={outcome}
          features={meta?.features ?? []}
          request={request}
          curl={curlFor(request)}
          onRetry={() => void solve()}
        />
      </div>
    </div>
  );
}

// ---------- small parts ----------

function FieldError({
  id,
  className = "",
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p id={id} className={`${styles.error} ${className} caption-2`}>
      <WarningCircle size={16} aria-hidden />
      {children}
    </p>
  );
}

function RemoveButton({
  name,
  onClick,
}: {
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.remove}
      onClick={onClick}
      aria-label={`Remove ${name}`}
    >
      <X size={16} aria-hidden />
    </button>
  );
}

/** A native select that adds the picked feature, grouped by meaning. Resets after each pick. */
function AddPicker({
  label: text,
  features,
  onPick,
}: {
  label: string;
  features: Feature[];
  onPick: (id: string) => void;
}) {
  return (
    <label className={styles.add}>
      <Plus size={16} aria-hidden />
      <span className="button-sm">{text}</span>
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value);
        }}
        aria-label={text}
      >
        <option value="" disabled>
          {text}
        </option>
        {grouped(features).map((g) => (
          <optgroup key={g.name} label={g.name}>
            {g.features.map((f) => (
              <option key={f.id} value={f.id}>
                {label(f)}
                {unitLabel(f) ? ` (${unitLabel(f)})` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function SkeletonRows({ n }: { n: number }) {
  return (
    <div className={styles.skRows} aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={styles.sk} />
      ))}
    </div>
  );
}
