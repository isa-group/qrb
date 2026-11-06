"use client";

import { CaretDown, CaretUp, DownloadSimple } from "@phosphor-icons/react";
import { useId, useMemo, useState } from "react";

import type { Schemas } from "@/lib/api/client";

import styles from "./catalog.module.css";
import { DASH } from "./format";

type Topology = Schemas["Topology"];
type Field = Schemas["CalibrationField"];
type Values = Record<string, number | null | undefined>;
type View = "map" | "graph" | "table";

// ---------- values ----------

/** A calibration value in its field's unit: errors as percentages, times and frequencies with units. */
export function fmt(
  field: Field | undefined,
  v: number | null | undefined,
): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  switch (field?.unit) {
    case "error": {
      const p = v * 100;
      return p === 0 ? "0%" : `${p >= 10 ? p.toFixed(0) : p.toPrecision(2)}%`;
    }
    case "us":
      return `${v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toPrecision(3)} µs`;
    case "ns":
      return `${Math.round(v).toLocaleString("en-US")} ns`;
    case "ghz":
      return `${v.toFixed(3)} GHz`;
    case "s":
      return `${v >= 10 ? Math.round(v) : v.toPrecision(3)} s`;
    default:
      return v.toPrecision(3);
  }
}

const GOOD = "#77d5a3",
  MID = "#ffd395",
  BAD = "#fd8da3",
  NEUTRAL_LO = "#24435c",
  NEUTRAL_HI = "#85cdf1";
function mix(a: string, b: string, t: number) {
  const p = (h: string) =>
    [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(" ")})`;
}
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A colour scale for one field over the device: green at the best value, pink at the worst; errors
 *  on a log axis; fields with no better direction (frequency) on a neutral sky ramp. */
function scaleFor(
  field: Field | undefined,
  values: (number | null | undefined)[],
) {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  const lo = v.length ? Math.min(...v) : 0,
    hi = v.length ? Math.max(...v) : 0;
  const log = field?.unit === "error" && lo > 0;
  const pos = (x: number) => {
    if (!(hi > lo)) return 0;
    const t = log
      ? (Math.log(Math.max(x, lo)) - Math.log(lo)) /
        (Math.log(hi) - Math.log(lo))
      : (x - lo) / (hi - lo);
    return Math.min(1, Math.max(0, t));
  };
  const color = (x: number | null | undefined) => {
    if (x == null || !Number.isFinite(x)) return "var(--line-strong)";
    let t = pos(x);
    if (!field?.better) return mix(NEUTRAL_LO, NEUTRAL_HI, t);
    if (field.better === "higher") t = 1 - t;
    return t < 0.5 ? mix(GOOD, MID, t * 2) : mix(MID, BAD, (t - 0.5) * 2);
  };
  const at = (t: number) =>
    log
      ? Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)))
      : lo + t * (hi - lo);
  return { lo, hi, med: median(v), color, at, any: v.length > 0 };
}

/** The headline medians, in the order a researcher scans them. */
const HEADLINE = [
  "t1_us",
  "t2_us",
  "readout_error",
  "sx_error",
  "error_1q_simultaneous_rb",
  "error_1q_rb",
  "cz_error",
  "ecr_error",
  "two_qubit_clifford_error",
];

// ---------- component ----------

export function CalibrationData({ topo }: { topo: Topology }) {
  const qf = topo.qubit_fields ?? [];
  const cf = topo.coupler_fields ?? [];
  const byId = useMemo(
    () => new Map([...qf, ...cf].map((f) => [f.id, f])),
    [qf, cf],
  );
  const firstQ = qf.find((f) => f.id === "readout_error") ?? qf[0];
  const [view, setView] = useState<View>("map");
  const [qField, setQField] = useState<string | undefined>(firstQ?.id);
  const [cField, setCField] = useState<string | undefined>(cf[0]?.id);
  const [hover, setHover] = useState<number | null>(null);
  const ids = useId();

  const qVal = (q: Topology["qubits"][number], id?: string) =>
    id ? (q.values as Values | undefined)?.[id] : undefined;
  const cVal = (c: Topology["couplers"][number], id?: string) =>
    id ? (c.values as Values | undefined)?.[id] : undefined;
  const qFieldObj = qField ? byId.get(qField) : undefined;
  const cFieldObj = cField ? byId.get(cField) : undefined;
  const qScale = useMemo(
    () =>
      scaleFor(
        qFieldObj,
        topo.qubits.map((q) => qVal(q, qField)),
      ),
    [topo, qField, qFieldObj],
  );
  const cScale = useMemo(
    () =>
      scaleFor(
        cFieldObj,
        topo.couplers.map((c) => cVal(c, cField)),
      ),
    [topo, cField, cFieldObj],
  );

  const headline = [
    ...(topo.processor ? [{ label: "Processor", value: topo.processor }] : []),
    ...HEADLINE.filter((id) => byId.has(id) && topo.medians?.[id] != null).map(
      (id) => ({
        label: `${byId.get(id)!.label.replace(/ \((µs|ns|GHz)\)$/, "")} (median)`,
        value: fmt(byId.get(id), topo.medians![id]),
      }),
    ),
    ...(topo.device ?? []).map((d) => ({
      label: d.field.label.replace(/ \((µs|s)\)$/, ""),
      value: fmt(d.field, d.value),
    })),
  ];
  const hasQubitData = qf.length > 0;

  return (
    <div className={styles.cal}>
      {headline.length > 0 && (
        <dl className={styles.headline}>
          {headline.map((h) => (
            <div key={h.label}>
              <dt className="caption-2 muted">{h.label}</dt>
              <dd className="title-1">{h.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {!hasQubitData && !topo.all_to_all && (
        <p className="body-6 soft">
          This provider reports no per-qubit calibration for this device.
        </p>
      )}

      {(hasQubitData || topo.all_to_all) && (
        <>
          <div className={styles.calBar}>
            <div
              className={styles.segmented}
              role="radiogroup"
              aria-label="View"
            >
              {(["map", "graph", "table"] as View[]).map((v) => (
                <label key={v}>
                  <input
                    type="radio"
                    name={`${ids}-view`}
                    checked={view === v}
                    onChange={() => setView(v)}
                    disabled={v !== "map" && !hasQubitData}
                  />
                  <span className="body-5">
                    {v === "map"
                      ? "Map view"
                      : v === "graph"
                        ? "Graph view"
                        : "Table view"}
                  </span>
                </label>
              ))}
            </div>
            {view !== "table" && hasQubitData && (
              <FieldPicker
                id={`${ids}-q`}
                label="Qubit"
                fields={qf}
                value={qField}
                onChange={setQField}
                scale={qScale}
                field={qFieldObj}
              />
            )}
            {view === "map" && cf.length > 0 && (
              <FieldPicker
                id={`${ids}-c`}
                label="Connection"
                fields={cf}
                value={cField}
                onChange={setCField}
                scale={cScale}
                field={cFieldObj}
              />
            )}
          </div>

          {view === "map" && (
            <MapView
              topo={topo}
              qScale={qScale}
              cScale={cScale}
              qv={(q) => qVal(q, qField)}
              cv={(c) => cVal(c, cField)}
              hover={hover}
              setHover={setHover}
              qf={qf}
              byId={byId}
            />
          )}
          {view === "graph" && hasQubitData && (
            <GraphView
              topo={topo}
              field={qFieldObj}
              scale={qScale}
              v={(q) => qVal(q, qField)}
              hover={hover}
              setHover={setHover}
            />
          )}
          {view === "table" && hasQubitData && (
            <TableView topo={topo} qf={qf} />
          )}
        </>
      )}
    </div>
  );
}

function FieldPicker({
  id,
  label,
  fields,
  value,
  onChange,
  scale,
  field,
}: {
  id: string;
  label: string;
  fields: Field[];
  value?: string;
  onChange: (v: string) => void;
  scale: ReturnType<typeof scaleFor>;
  field?: Field;
}) {
  return (
    <div className={styles.picker}>
      <label htmlFor={id} className="caption-2 muted">
        {label}
      </label>
      <div className={styles.pickerRow}>
        <select
          id={id}
          className={styles.select}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        {scale.any && (
          <div className={styles.legend}>
            <span className="caption-2 soft">
              Median {fmt(field, scale.med)}
            </span>
            <span className={styles.ramp} aria-hidden>
              {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                <span
                  key={t}
                  style={{ background: scale.color(scale.at(t)) }}
                />
              ))}
            </span>
            <span className="caption-2 muted">
              min {fmt(field, scale.lo)} · max {fmt(field, scale.hi)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- map ----------

function MapView({
  topo,
  qScale,
  cScale,
  qv,
  cv,
  hover,
  setHover,
  qf,
  byId,
}: {
  topo: Topology;
  qScale: ReturnType<typeof scaleFor>;
  cScale: ReturnType<typeof scaleFor>;
  qv: (q: Topology["qubits"][number]) => number | null | undefined;
  cv: (c: Topology["couplers"][number]) => number | null | undefined;
  hover: number | null;
  setHover: (i: number | null) => void;
  qf: Field[];
  byId: Map<string, Field>;
}) {
  const neighbours = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const c of topo.couplers) {
      m.set(c.a, [...(m.get(c.a) ?? []), c.b]);
      m.set(c.b, [...(m.get(c.b) ?? []), c.a]);
    }
    return m;
  }, [topo]);
  const PAD = 40,
    W = Math.max(topo.width, 0.05) * 1000 + PAD * 2,
    H = Math.max(topo.height, 0.05) * 1000 + PAD * 2;
  const r = topo.num_qubits > 130 ? 9 : topo.num_qubits > 60 ? 12 : 18;
  const labels = r >= 12; // numbers inside nodes when there is room
  const at = (q: { x: number; y: number }) =>
    [q.x * 1000 + PAD, q.y * 1000 + PAD] as const;
  const hq = hover != null ? topo.qubits[hover] : null;

  return (
    <div className={styles.topoStage}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.topoSvg}
        role="img"
        aria-label={
          topo.all_to_all
            ? `${topo.num_qubits} qubits; every pair couples directly`
            : `Coupling map: ${topo.num_qubits} qubits and ${topo.couplers.length} couplers. Table view lists every value.`
        }
        onPointerLeave={() => setHover(null)}
      >
        {topo.couplers.map((c) => {
          const [x1, y1] = at(topo.qubits[c.a]);
          const [x2, y2] = at(topo.qubits[c.b]);
          const lit = hover != null && (c.a === hover || c.b === hover);
          return (
            <line
              key={`${c.a}-${c.b}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={cScale.color(cv(c))}
              strokeWidth={lit ? r * 0.75 : r * 0.45}
              strokeOpacity={hover == null || lit ? 0.9 : 0.25}
              strokeLinecap="round"
            />
          );
        })}
        {topo.qubits.map((q) => {
          const [x, y] = at(q);
          const on = hover === q.index;
          return (
            <g
              key={q.index}
              onPointerEnter={() => setHover(q.index)}
              className={styles.qubit}
            >
              <circle
                cx={x}
                cy={y}
                r={on ? r * 1.3 : r}
                fill={
                  topo.all_to_all && !qScale.any
                    ? "var(--accent-soft)"
                    : qScale.color(qv(q))
                }
                stroke={on ? "var(--ink)" : "var(--bg)"}
                strokeWidth={on ? 3 : 2}
              />
              {labels && (
                <text
                  x={x}
                  y={y}
                  className={styles.qubitNum}
                  fontSize={r * 0.85}
                  dominantBaseline="central"
                  textAnchor="middle"
                >
                  {q.index}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className={styles.readout} aria-live="polite">
        {topo.all_to_all && (
          <p className="body-6 soft">
            Every pair of qubits couples directly:{" "}
            {((topo.num_qubits * (topo.num_qubits - 1)) / 2).toLocaleString(
              "en-US",
            )}{" "}
            possible pairs.
          </p>
        )}
        {hq ? (
          <>
            <p className="title-3">Qubit {hq.index}</p>
            <dl className={styles.readoutList}>
              {qf.map((f) => (
                <div key={f.id}>
                  <dt className="caption-2 muted">{f.label}</dt>
                  <dd className="caption-2 soft">
                    {fmt(f, (hq.values as Values | undefined)?.[f.id])}
                  </dd>
                </div>
              ))}
            </dl>
            {!topo.all_to_all && (
              <p className="caption-2 muted">
                Couples to{" "}
                {(neighbours.get(hq.index) ?? [])
                  .sort((a, b) => a - b)
                  .map((n) => {
                    const c = topo.couplers.find(
                      (x) =>
                        (x.a === hq.index && x.b === n) ||
                        (x.b === hq.index && x.a === n),
                    );
                    const f = byId.get(
                      Object.keys((c?.values as Values) ?? {})[0] ?? "",
                    );
                    return `${n}${c && f ? ` (${f.label.replace(/ error$/, "")} ${fmt(f, (c.values as Values)[f.id])})` : ""}`;
                  })
                  .join(", ") || "none reported"}
              </p>
            )}
          </>
        ) : (
          qf.length > 0 && (
            <p className="caption-2 muted">
              Point at a qubit to read every value it reports.
            </p>
          )
        )}
      </div>
    </div>
  );
}

// ---------- graph ----------

type Order = "index" | "asc" | "desc";

function GraphView({
  topo,
  field,
  scale,
  v,
  hover,
  setHover,
}: {
  topo: Topology;
  field?: Field;
  scale: ReturnType<typeof scaleFor>;
  v: (q: Topology["qubits"][number]) => number | null | undefined;
  hover: number | null;
  setHover: (i: number | null) => void;
}) {
  const [order, setOrder] = useState<Order>("index");
  const ids = useId();
  const rows = useMemo(() => {
    const r = topo.qubits.map((q) => ({ i: q.index, v: v(q) }));
    if (order === "index") return r;
    return [...r].sort((a, b) =>
      a.v == null
        ? 1
        : b.v == null
          ? -1
          : (a.v - b.v) * (order === "asc" ? 1 : -1),
    );
  }, [topo, v, order]);
  const W = 1000,
    H = 300,
    L = 56,
    B = 28,
    T = 12;
  const max = scale.hi || 1,
    bw = (W - L) / Math.max(rows.length, 1);
  const y = (x: number) => H - B - (x / max) * (H - B - T);
  const ticks = [0, 0.5, 1].map((t) => t * max);
  const every = Math.ceil(rows.length / 24);
  const hv = hover != null ? topo.qubits[hover] : null;

  return (
    <div className={styles.graph}>
      <div className={styles.picker}>
        <label htmlFor={`${ids}-order`} className="caption-2 muted">
          Sort qubits
        </label>
        <select
          id={`${ids}-order`}
          className={styles.select}
          value={order}
          onChange={(e) => setOrder(e.target.value as Order)}
        >
          <option value="index">By qubit number</option>
          <option value="asc">By value, lowest first</option>
          <option value="desc">By value, highest first</option>
        </select>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.graphSvg}
        role="img"
        aria-label={`${field?.label ?? "Value"} for each qubit; median ${fmt(field, scale.med)}`}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={L}
              x2={W}
              y1={y(t)}
              y2={y(t)}
              className={styles.gridLine}
            />
            <text
              x={L - 8}
              y={y(t)}
              className={styles.axis}
              textAnchor="end"
              dominantBaseline="central"
            >
              {fmt(field, t)}
            </text>
          </g>
        ))}
        {rows.map((r, k) => (
          <g key={r.i} onPointerEnter={() => setHover(r.i)}>
            <rect
              x={L + k * bw + bw * 0.15}
              y={r.v == null ? H - B : y(r.v)}
              width={Math.max(1, bw * 0.7)}
              height={r.v == null ? 0 : H - B - y(r.v)}
              fill={scale.color(r.v)}
              opacity={hover == null || hover === r.i ? 1 : 0.45}
            />
            <rect
              x={L + k * bw}
              y={T}
              width={bw}
              height={H - B - T}
              fill="transparent"
            />
            {k % every === 0 && (
              <text
                x={L + k * bw + bw / 2}
                y={H - B + 16}
                className={styles.axis}
                textAnchor="middle"
              >
                {r.i}
              </text>
            )}
          </g>
        ))}
        {scale.med != null && (
          <line
            x1={L}
            x2={W}
            y1={y(scale.med)}
            y2={y(scale.med)}
            className={styles.medianLine}
          />
        )}
      </svg>
      <p className="caption-2 muted" aria-live="polite">
        {hv
          ? `Qubit ${hv.index}: ${field?.label ?? ""} ${fmt(field, v(hv))}`
          : `Dashed line: median ${fmt(field, scale.med)}. Point at a bar to read it.`}
      </p>
    </div>
  );
}

// ---------- table ----------

function TableView({ topo, qf }: { topo: Topology; qf: Field[] }) {
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(
    null,
  );
  const rows = useMemo(() => {
    const r = topo.qubits;
    if (!sort) return r;
    const val = (q: (typeof r)[number]) =>
      sort.col === "index" ? q.index : (q.values as Values)?.[sort.col];
    return [...r].sort((a, b) => {
      const x = val(a),
        y = val(b);
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * (sort.dir === "asc" ? 1 : -1);
    });
  }, [topo, sort]);

  const csv = () => {
    const head = ["qubit", ...qf.map((f) => f.label)];
    const lines = topo.qubits.map((q) =>
      [q.index, ...qf.map((f) => (q.values as Values)?.[f.id] ?? "")].join(","),
    );
    const blob = new Blob(
      [[head.map((h) => `"${h}"`).join(","), ...lines].join("\n")],
      { type: "text/csv" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${topo.candidate_id}-calibration.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const header = (col: string, label: string) => {
    const active = sort?.col === col;
    return (
      <th
        key={col}
        scope="col"
        aria-sort={
          active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"
        }
      >
        <button
          type="button"
          className={styles.sortBtn}
          onClick={() =>
            setSort(
              active
                ? sort!.dir === "asc"
                  ? { col, dir: "desc" }
                  : null
                : { col, dir: "asc" },
            )
          }
        >
          {label}
          {active &&
            (sort!.dir === "asc" ? (
              <CaretUp size={12} aria-hidden />
            ) : (
              <CaretDown size={12} aria-hidden />
            ))}
        </button>
      </th>
    );
  };

  return (
    <div className={styles.calTable}>
      <button
        type="button"
        className="btn btn-secondary button-sm"
        onClick={csv}
      >
        <DownloadSimple size={16} aria-hidden /> Download CSV
      </button>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <caption className="visually-hidden">
            Calibration of every qubit
          </caption>
          <thead>
            <tr className="caption-4 muted">
              {header("index", "Qubit")}
              {qf.map((f) => header(f.id, f.label))}
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.index}>
                <th scope="row" className="title-4">
                  {q.index}
                </th>
                {qf.map((f) => (
                  <td key={f.id} data-label={f.label}>
                    {fmt(f, (q.values as Values)?.[f.id])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
