"use client";

import { ArrowRight, CaretDown, DownloadSimple, Trash, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import catalog from "@/components/catalog/catalog.module.css";
import { CopyButton } from "@/components/copy-button";
import { highlight } from "@/components/highlight";
import { booleanSentence, format, isBoolean, label, OP_WORDS, unitLabel, type Feature, type Op } from "@/components/bind/features";
import { API_BASE_URL, api } from "@/lib/api/client";
import {
  clearBinds,
  csvUrl,
  deleteBind,
  getBind,
  listBinds,
  listRequests,
  type BindSummary,
  type DailyUsage,
  type LoggedRequest,
  type Page,
  type StoredBind,
  type StoredBindDetail,
} from "@/lib/auth";

import styles from "./account.module.css";

// ---------- formatting ----------

const PRESET_NAMES: Record<string, string> = {
  balanced: "Balanced",
  "fidelity-first": "Fidelity first",
  cheapest: "Cheapest",
  fastest: "Fastest",
  "nisq-analyzer": "NISQ Analyzer",
  "q-orchestrator": "Q-Orchestrator",
  "mqt-predictor": "MQT Predictor",
};
const FEATURE_NAMES: Record<string, string> = {
  expected_fidelity: "fidelity",
  estimated_success_probability: "success probability",
  cost: "cost",
  queue: "queue",
  critical_depth: "critical depth",
};
const PROVIDERS: Record<string, string> = { ibm: "IBM Quantum", braket: "Amazon Braket" };

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayLabel = (day: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
const units = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

function preferencesText(p: StoredBind["preferences"]): string {
  if (p.preset) return PRESET_NAMES[p.preset] ?? p.preset;
  const weights = Object.entries(p.weights ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const top = weights
    .slice(0, 2)
    .map(([k, v]) => `${FEATURE_NAMES[k] ?? k} ${pct(v)}`)
    .join(", ");
  const more = weights.length > 2 ? ` +${weights.length - 2}` : "";
  return top ? top + more : "No weights";
}

function constraintsText(p: StoredBind["preferences"]): string | null {
  const n = (p.constraints ?? []).length;
  const parts = [n ? `${n} constraint${n === 1 ? "" : "s"}` : "", p.require_provider ? `${p.require_provider === "ibm" ? "IBM" : "Braket"} only` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Age of the data a bind used, measured from the bind's own time. */
function dataText(s: BindSummary["source"], at: string): string {
  if (s.mode === "snapshot") return "Snapshot";
  if (s.mode !== "live") return "Unknown";
  if (!s.cache_hit) return "Live, fetched now";
  const age = s.as_of ? Math.max(0, Math.round((new Date(at).getTime() - new Date(s.as_of).getTime()) / 1000)) : null;
  if (age === null) return "Stored data";
  if (age < 60) return "Stored, under a minute old";
  return `Stored, ${Math.round(age / 60)} min old`;
}

function statusText(status: number): string {
  if (status === 202) return "Accepted";
  if (status < 300) return "OK";
  if (status === 401) return "Key refused";
  if (status === 413) return "Too large";
  if (status === 422) return "Invalid request";
  if (status === 429) return "Limit reached";
  if (status === 504) return "Interrupted";
  if (status >= 500) return "Failed";
  return "Rejected";
}

const sourceText = (r: { source: string; apiKeyStart: string | null }) =>
  r.source === "key" ? `API key ${r.apiKeyStart ? `${r.apiKeyStart}…` : ""}`.trim() : "Browser";

function featureName(id: string, byId: Map<string, Feature>): string {
  const f = byId.get(id);
  if (f) return label(f);
  const s = id.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Cost at most $5.00", in the feature's own unit; the same words as /bind's constraint rows. */
function constraintSentence(c: { feature: string; op: string; value: number }, byId: Map<string, Feature>): string {
  const f = byId.get(c.feature);
  if (f && isBoolean(f)) return booleanSentence(f);
  const unit = f && f.unit !== "usd" ? unitLabel(f) : "";
  return `${featureName(c.feature, byId)} ${OP_WORDS[c.op as Op] ?? c.op} ${format(f, c.value)}${unit ? ` ${unit}` : ""}`;
}

/** The exact `POST /select` this bind sent, as /bind's "Copy as curl" writes it. */
function curlFor(request: StoredBindDetail["request"]): string {
  return `curl -sS -X POST "${API_BASE_URL}/select" \\
  -H "Content-Type: application/json" \\
  --data-binary @- <<'JSON'
${JSON.stringify(request, null, 2)}
JSON`;
}

// ---------- 30-day chart ----------

const MID = 15;

/**
 * Units per UTC day for 30 days, each bar stacked by source (API key below, browser above). The
 * quota is drawn as a reference line when the busiest day comes near it; otherwise the scale
 * follows the data so small use stays readable. The chart is one slider: hover a day, or focus it
 * and step with the arrow keys; a table carries the same numbers for screen readers.
 */
export function UsageChart({ days, quota }: { days: DailyUsage[]; quota: number }) {
  const [active, setActive] = useState<number | null>(null);
  const ids = useId();
  const last = days.length - 1;
  const total = (d: DailyUsage) => d.key + d.browser;
  const peak = Math.max(0, ...days.map(total));
  const showQuota = quota > 0 && peak >= quota * 0.6;
  const top = showQuota ? Math.max(quota, peak) * 1.05 : Math.max(peak, 1) * 1.15;
  const i = active ?? last;
  const shown = days[i];
  const sum = days.reduce((a, d) => a + total(d), 0);
  const name = (d: DailyUsage, k: number) => (k === last ? "Today" : dayLabel(d.day, { weekday: "short", day: "numeric", month: "short" }));

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -7, PageUp: 7 };
    let next: number | null = null;
    if (e.key in step) next = Math.min(last, Math.max(0, i + step[e.key]));
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") return setActive(null);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  if (sum === 0) return <p className="body-6 soft">No units used in the last 30 days. Each day&rsquo;s use appears here, split by API key and browser.</p>;

  return (
    <div className={styles.chartWrap}>
      {/* At rest it names the chart and its total; pointing at or focusing a day reads that day. */}
      <p className={`${styles.readout} body-6`} aria-hidden>
        {active === null ? (
          <>
            <span className="title-4">Last 30 days</span>
            <span className="soft">{units(sum)}</span>
          </>
        ) : (
          <>
            <span className="title-4">{name(shown, i)}</span>
            <span className="soft">
              {units(total(shown))}
              {total(shown) > 0 && ` · API key ${shown.key}, browser ${shown.browser}`}
            </span>
          </>
        )}
      </p>
      <div
        className={styles.chart}
        role="slider"
        tabIndex={0}
        aria-label="Units per day, last 30 days"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={i}
        aria-valuetext={`${name(shown, i)}: ${units(total(shown))}, API key ${shown.key}, browser ${shown.browser}`}
        onKeyDown={onKey}
        onMouseLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
      >
        {showQuota && <div className={styles.quotaLine} style={{ bottom: `${(quota / top) * 100}%` }} aria-hidden />}
        {days.map((d, k) => (
          <div key={d.day} className={styles.bar} data-active={active === k || undefined} onMouseEnter={() => setActive(k)} aria-hidden>
            <span className={styles.barKey} style={{ height: `${(d.key / top) * 100}%` }} />
            <span className={styles.barBrowser} style={{ height: `${(d.browser / top) * 100}%` }} />
          </div>
        ))}
      </div>
      {/* Three labels pinned to the start, the middle and the end: they cannot collide at any width. */}
      <div className={`${styles.chartAxis} caption-4 muted`} aria-hidden>
        <span>{dayLabel(days[0].day)}</span>
        <span className={styles.axisMid} style={{ left: `${((MID + 0.5) / days.length) * 100}%` }}>
          {dayLabel(days[MID].day)}
        </span>
        <span className={styles.axisToday}>Today</span>
      </div>
      <div className={`${styles.legend} caption-2 muted`}>
        <span className={styles.legendKey}>API key</span>
        <span className={styles.legendBrowser}>Browser</span>
        {showQuota && <span className={styles.legendQuota}>Daily budget, {quota}</span>}
        <span className={styles.chartHint}>Point at a day, or focus the chart and use the arrow keys.</span>
      </div>
      {/* Hidden through a wrapper: a caption sits outside the table box and would escape clipping on the table itself. */}
      <div className="visually-hidden">
        <table aria-labelledby={`${ids}-cap`}>
          <caption id={`${ids}-cap`}>Units used per day, last 30 days</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">API key</th>
              <th scope="col">Browser</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <th scope="row">{dayLabel(d.day)}</th>
                <td>{d.key}</td>
                <td>{d.browser}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- activity ----------

type View = "binds" | "requests";

function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={styles.inlineError} role="alert">
      <p className={`${styles.error} caption-2`}>
        <WarningCircle size={16} aria-hidden /> {message}
      </p>
      {onRetry && (
        <button type="button" className="btn btn-secondary button-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** A paged list from the gateway: first page on mount, "Load more" for the next. */
function usePaged<T extends { id: string }>(load: (before?: string | null) => Promise<Page<T>>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const first = useCallback(() => {
    setError(null);
    load()
      .then((p) => {
        setItems(p.items);
        setNext(p.next);
      })
      .catch((e: Error) => setError(e.message));
  }, [load]);
  useEffect(first, [first]);

  const more = async () => {
    if (!next) return;
    setBusy(true);
    try {
      const p = await load(next);
      setItems((cur) => [...(cur ?? []), ...p.items]);
      setNext(p.next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { items, setItems, next, error, busy, more, reload: first };
}

/** Feature metadata from the free `GET /features`, for constraint sentences; empty until it loads. */
function useFeatures(): Map<string, Feature> {
  const [byId, setById] = useState<Map<string, Feature>>(new Map());
  useEffect(() => {
    let live = true;
    api
      .GET("/features")
      .then(({ data }) => {
        if (live && data) setById(new Map(data.result.map((f) => [f.id, f])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return byId;
}

/** What a bind resolved to, in one line under its name. */
function outcome(b: StoredBind): { main: string; sub: string; tone?: "off" | "error"; winner?: BindSummary["winners"] } {
  const sum = b.summary;
  if (b.status === "pending") return { main: "Binding…", sub: "still resolving", tone: "off" };
  if (!sum) return { main: "Not bound", sub: b.error ?? "the bind failed", tone: "error" };
  const w = sum.winners;
  if (sum.feasibility === "INFEASIBLE" || !w.length) return { main: "No QPU met the constraints", sub: `none of ${sum.candidates} qualified` };
  return {
    main: w[0].name,
    sub: sum.solutions > 1 ? `${sum.solutions} non-dominated of ${sum.candidates}` : `chosen from ${sum.candidates}`,
    winner: w,
  };
}

function BindDetail({
  bind,
  features,
  id,
  onDelete,
  deleting,
}: {
  bind: StoredBind;
  features: Map<string, Feature>;
  id: string;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [detail, setDetail] = useState<StoredBindDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getBind(bind.id)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [bind.id]);
  useEffect(load, [load]);

  const p = bind.preferences;
  const sum = bind.summary;
  const weights = Object.entries(p.weights ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const constraints = p.constraints ?? [];
  const lines = detail ? detail.request.circuit_qasm.trimEnd().split("\n").length : 0;

  return (
    <div className={styles.detail} id={id}>
      <figure className={`${styles.code} ${styles.circuit}`}>
        <figcaption className="caption-2 muted">
          <span>{detail ? `Circuit · ${lines} line${lines === 1 ? "" : "s"}` : "Circuit"}</span>
          {detail && <CopyButton text={detail.request.circuit_qasm} name="the circuit" />}
        </figcaption>
        {error ? (
          <div className={styles.circuitState}>
            <Failure message={`The circuit could not be loaded. ${error}`} onRetry={load} />
          </div>
        ) : detail ? (
          <pre tabIndex={0} aria-label="Circuit">
            <code>{highlight(detail.request.circuit_qasm, "qasm")}</code>
          </pre>
        ) : (
          <div className={styles.circuitState} aria-busy="true" aria-label="Loading the circuit">
            <span className={`${styles.sk} ${styles.skLine}`} />
            <span className={`${styles.sk} ${styles.skLine}`} />
            <span className={`${styles.sk} ${styles.skLine}`} />
          </div>
        )}
      </figure>

      <div className={styles.facts2}>
        <dl className={`${styles.factList} body-6`}>
          <div>
            <dt className="caption-4 muted">{sum && sum.solutions > 1 ? "Non-dominated bindings" : "Binding"}</dt>
            <dd>
              {bind.status === "pending" ? (
                <span className="soft">Still resolving. This list updates when it finishes.</span>
              ) : !sum ? (
                <span className={styles.errorText}>{bind.error ?? "The bind failed."} No units were kept unless the request itself was invalid.</span>
              ) : sum.winners.length === 0 ? (
                <span className="soft">No QPU met every constraint ({sum.candidates} candidates). Open it in /bind to see what each one broke.</span>
              ) : (
                <ul className={styles.winners}>
                  {sum.winners.map((w) => (
                    <li key={w.id}>
                      <Link href={`/catalog/${encodeURIComponent(w.id)}`} className={`${catalog.provider} ${styles.winnerLink}`} data-provider={w.provider ?? undefined}>
                        {w.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt className="caption-4 muted">Objective</dt>
            <dd>
              {p.preset ? (
                <span className="soft">{PRESET_NAMES[p.preset] ?? p.preset} preset</span>
              ) : weights.length ? (
                <ul className={styles.inlineList}>
                  {weights.map(([k, v]) => (
                    <li key={k}>
                      {featureName(k, features)} <span className="muted">{pct(v)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="soft">No weights</span>
              )}
              {p.pareto && <span className="muted"> · Pareto front</span>}
            </dd>
          </div>
          <div>
            <dt className="caption-4 muted">Constraints</dt>
            <dd>
              {constraints.length || p.require_provider ? (
                <ul className={styles.stackList}>
                  {constraints.map((c, k) => (
                    <li key={k}>{constraintSentence(c, features)}</li>
                  ))}
                  {p.require_provider && <li>{PROVIDERS[p.require_provider] ?? p.require_provider} only</li>}
                </ul>
              ) : (
                <span className="soft">None beyond enough qubits for the circuit</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="caption-4 muted">Data</dt>
            <dd className="soft">
              {sum ? (
                <>
                  {dataText(sum.source, bind.at)}
                  {sum.source.as_of && <span className="muted"> · as of {clock(sum.source.as_of)}</span>}
                </>
              ) : detail?.request.force_refresh ? (
                "Fresh from the providers"
              ) : (
                "Stored data"
              )}
            </dd>
          </div>
          <div>
            <dt className="caption-4 muted">Shots</dt>
            <dd className="soft">{bind.shots.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="caption-4 muted">Charged</dt>
            <dd className="soft">
              {units(bind.cost)} <span className="muted">· {sourceText(bind)}</span>
            </dd>
          </div>
          {sum?.engine && (
            <div>
              <dt className="caption-4 muted">Engine</dt>
              <dd>
                <code className={styles.endpoint}>{sum.engine}</code>
              </dd>
            </div>
          )}
        </dl>

        <div className={styles.detailActions}>
          {bind.status !== "pending" && (
            <Link href={`/bind?bind=${encodeURIComponent(bind.id)}`} className="link body-5">
              Open in /bind <ArrowRight size={16} aria-hidden />
            </Link>
          )}
          <span className={styles.detailButtons}>
            {detail && <CopyButton text={curlFor(detail.request)} label="Copy as curl" name="the request as curl" />}
            <button type="button" className={`btn btn-secondary button-sm ${styles.danger}`} onClick={onDelete} aria-disabled={deleting} disabled={deleting}>
              <Trash size={16} aria-hidden />
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** While a bind is resolving, the first page is fetched again every few seconds and merged in. */
const POLL_MS = 4000;

function BindsView({ onChange }: { onChange?: () => void }) {
  const { items, setItems, next, error, busy, more, reload } = usePaged(listBinds);
  const features = useFeatures();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const ids = useId();
  const pendingIds = useMemo(() => (items ?? []).filter((b) => b.status === "pending").map((b) => b.id).join(","), [items]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!pendingIds) return;
    const t = window.setInterval(() => {
      listBinds()
        .then((p) => {
          const fresh = new Map(p.items.map((b) => [b.id, b]));
          let settled = false;
          setItems((cur) => {
            const known = new Set((cur ?? []).map((b) => b.id));
            const updated = (cur ?? []).map((b) => {
              const f = fresh.get(b.id);
              if (f && b.status === "pending" && f.status !== "pending") settled = true;
              return f ?? b;
            });
            return [...p.items.filter((b) => !known.has(b.id)), ...updated];
          });
          if (settled) onChangeRef.current?.();
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [pendingIds, setItems]);

  const toggle = (id: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /** A click anywhere on a row opens it, except on its own controls or a text selection. */
  const rowClick = (e: MouseEvent<HTMLTableRowElement>, id: string) => {
    if ((e.target as HTMLElement).closest("a, button, input, label")) return;
    if (window.getSelection()?.toString()) return;
    toggle(id);
  };

  const remove = async (id: string) => {
    setWorking(id);
    setActionError(null);
    try {
      await deleteBind(id);
      setItems((cur) => (cur ?? []).filter((b) => b.id !== id));
    } catch (e) {
      setActionError(`The bind was not deleted. ${(e as Error).message}`);
    } finally {
      setWorking(null);
    }
  };

  const clear = async () => {
    setWorking("all");
    setActionError(null);
    try {
      await clearBinds();
      setItems([]);
      setConfirmClear(false);
    } catch (e) {
      setActionError(`The history was not cleared. ${(e as Error).message}`);
    } finally {
      setWorking(null);
    }
  };

  if (error && !items) return <Failure message={`Your binds could not be loaded. ${error}`} onRetry={reload} />;
  if (!items) return <Skeleton />;
  if (!items.length)
    return (
      <div className={styles.emptyActivity}>
        <p className="body-3 soft">
          No binds in the last 30 days. Binds you make on /bind while signed in, or with your API key, appear here with their circuit, so you can reopen them.
        </p>
        <Link href="/bind" className="link body-5">
          Bind a circuit <ArrowRight size={16} aria-hidden />
        </Link>
      </div>
    );

  return (
    <>
      <div className={styles.tableWrap}>
        <table className={`${styles.activityTable} ${styles.bindsTable} body-6`}>
          <caption className="visually-hidden">Binds of the last 30 days, newest first. Open a row to see its circuit and preferences.</caption>
          <thead>
            <tr className="caption-4 muted">
              <th scope="col">Time</th>
              <th scope="col">Binding</th>
              <th scope="col">Preferences</th>
              <th scope="col">Data</th>
              <th scope="col" className={styles.num}>
                Units
              </th>
              <th scope="col">
                <span className="visually-hidden">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((b) => {
              const o = outcome(b);
              const cons = constraintsText(b.preferences);
              const isOpen = open.has(b.id);
              const detailId = `${ids}-bind-${b.id}`;
              return (
                <Fragment key={b.id}>
                  <tr className={styles.bindRow} data-open={isOpen || undefined} data-status={b.status} onClick={(e) => rowClick(e, b.id)}>
                    <td data-label="Time">
                      <span className={styles.cellMain}>{when(b.at)}</span>
                      <span className="caption-2 muted">{sourceText(b)}</span>
                    </td>
                    <th scope="row" data-label="Binding">
                      {o.winner ? (
                        <span className={`${catalog.provider} ${styles.cellMain}`} data-provider={o.winner[0].provider ?? undefined}>
                          {o.main}
                          {o.winner.length > 1 && <span className="muted"> +{o.winner.length - 1}</span>}
                        </span>
                      ) : (
                        <span className={`${styles.cellMain} ${b.status === "pending" ? styles.pendingText : ""}`}>{o.main}</span>
                      )}
                      <span className={`caption-2 ${o.tone === "error" ? styles.errorText : "muted"} ${styles.clamp}`}>{o.sub}</span>
                    </th>
                    <td data-label="Preferences">
                      <span className={styles.cellMain}>{preferencesText(b.preferences)}</span>
                      {cons && <span className="caption-2 muted">{cons}</span>}
                    </td>
                    <td data-label="Data">{b.summary ? dataText(b.summary.source, b.at) : <span className="muted">—</span>}</td>
                    <td data-label="Units" className={styles.num}>
                      {b.cost}
                    </td>
                    <td className={styles.toggleCell}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => toggle(b.id)}
                        aria-expanded={isOpen}
                        aria-controls={detailId}
                        aria-label={`${isOpen ? "Hide" : "Show"} the bind of ${when(b.at)}`}
                      >
                        <CaretDown size={16} aria-hidden className={styles.caret} />
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className={styles.detailRow}>
                      <td colSpan={6}>
                        <BindDetail bind={b} features={features} id={detailId} onDelete={() => void remove(b.id)} deleting={working === b.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {(error || actionError) && <Failure message={actionError ?? `More binds could not be loaded. ${error}`} />}
      <div className={styles.activityFoot}>
        {next ? (
          <button type="button" className="btn btn-secondary button-sm" onClick={() => void more()} aria-disabled={busy} disabled={busy}>
            {busy ? "Loading…" : "Load more"}
          </button>
        ) : (
          <span className="caption-2 muted">That is every bind of the last 30 days.</span>
        )}
        {!confirmClear ? (
          <button type="button" className="btn btn-secondary button-sm" onClick={() => setConfirmClear(true)}>
            Clear history
          </button>
        ) : (
          <div className={styles.confirmInline}>
            <span className="body-6 soft">Delete every stored bind and its circuit?</span>
            <button type="button" className={`btn btn-secondary button-sm ${styles.danger}`} onClick={() => void clear()} aria-disabled={working === "all"} disabled={working === "all"}>
              {working === "all" ? "Clearing…" : "Clear history"}
            </button>
            <button type="button" className="btn btn-secondary button-sm" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function RequestsView() {
  const { items, next, error, busy, more, reload } = usePaged(listRequests);
  if (error && !items) return <Failure message={`Your requests could not be loaded. ${error}`} onRetry={reload} />;
  if (!items) return <Skeleton />;
  if (!items.length) return <p className={`${styles.emptyActivity} body-3 soft`}>No requests in the last 30 days.</p>;
  return (
    <>
      <div className={styles.tableWrap}>
        <table className={`${styles.activityTable} body-6`}>
          <caption className="visually-hidden">Counted requests of the last 30 days, newest first</caption>
          <thead>
            <tr className="caption-4 muted">
              <th scope="col">Time</th>
              <th scope="col">Request</th>
              <th scope="col">From</th>
              <th scope="col">Status</th>
              <th scope="col" className={styles.num}>
                Units
              </th>
              <th scope="col" className={styles.num}>
                Duration
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((r: LoggedRequest) => (
              <tr key={r.id} data-off={r.status >= 400 || undefined}>
                <td data-label="Time">{when(r.at)}</td>
                <th scope="row" data-label="Request">
                  <code className={styles.endpoint}>
                    {r.method} {r.path}
                  </code>
                </th>
                <td data-label="From">{sourceText(r)}</td>
                <td data-label="Status">
                  {r.status} <span className={`${styles.inline} muted`}>{statusText(r.status)}</span>
                </td>
                <td data-label="Units" className={styles.num}>
                  {r.cost}
                </td>
                <td data-label="Duration" className={styles.num}>
                  {r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toFixed(1)} s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <Failure message={`More requests could not be loaded. ${error}`} />}
      <div className={styles.activityFoot}>
        {next ? (
          <button type="button" className="btn btn-secondary button-sm" onClick={() => void more()} aria-disabled={busy} disabled={busy}>
            {busy ? "Loading…" : "Load more"}
          </button>
        ) : (
          <span className="caption-2 muted">That is every request of the last 30 days.</span>
        )}
      </div>
    </>
  );
}

function Skeleton() {
  return (
    <div className={styles.usageSk} aria-busy="true" aria-label="Loading">
      <span className={styles.sk} />
      <span className={styles.sk} />
      <span className={styles.sk} />
    </div>
  );
}

export function Activity({ onChange }: { onChange?: () => void }) {
  const [view, setView] = useState<View>("binds");
  const ids = useId();
  return (
    <section className={styles.activity} aria-labelledby={`${ids}-title`}>
      <div className={styles.activityHead}>
        <div>
          <h2 id={`${ids}-title`} className="heading-6">
            Activity
          </h2>
          <p className="caption-2 muted">Binds and requests are kept for 30 days.</p>
        </div>
        <div className={styles.activityTools}>
          <div className={styles.segmented} role="radiogroup" aria-label="Show">
            {(["binds", "requests"] as const).map((v) => (
              <label key={v}>
                <input type="radio" name={`${ids}-view`} value={v} checked={view === v} onChange={() => setView(v)} />
                <span className="title-4">{v === "binds" ? "Binds" : "Requests"}</span>
              </label>
            ))}
          </div>
          <a className="btn btn-secondary button-sm" href={csvUrl(view)} download>
            <DownloadSimple size={16} aria-hidden />
            Download {view} as CSV
          </a>
        </div>
      </div>
      {view === "binds" ? <BindsView onChange={onChange} /> : <RequestsView />}
    </section>
  );
}
