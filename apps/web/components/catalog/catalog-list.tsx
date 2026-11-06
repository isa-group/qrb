"use client";

import {
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type CatalogSource } from "@/lib/api/client";

import styles from "./catalog.module.css";
import {
  ago,
  count,
  deviceHref,
  pct,
  providerName,
  sourceLine,
  statusLabel,
  utc,
} from "./format";

/** A GET /catalog row (the API returns it as a plain object; this is its shape). */
export type CatalogRow = {
  candidate_id: string;
  name: string;
  provider_id: string;
  vendor: string;
  num_qubits: number;
  queue_length: number | null;
  status: string;
  operational: boolean;
  last_calibrated_at: string | null;
  median_gate_error_2q: number | null;
  median_readout_error: number | null;
};

type Col = {
  id: keyof CatalogRow | "calibrated";
  label: string;
  numeric?: boolean;
  value: (r: CatalogRow) => number | string | null;
};
const COLS: Col[] = [
  {
    id: "num_qubits",
    label: "Qubits",
    numeric: true,
    value: (r) => r.num_qubits,
  },
  {
    id: "queue_length",
    label: "Queue (jobs)",
    numeric: true,
    value: (r) => r.queue_length,
  },
  {
    id: "median_gate_error_2q",
    label: "Median 2q error",
    numeric: true,
    value: (r) => r.median_gate_error_2q,
  },
  {
    id: "median_readout_error",
    label: "Median readout",
    numeric: true,
    value: (r) => r.median_readout_error,
  },
  {
    id: "calibrated",
    label: "Calibrated",
    numeric: true,
    value: (r) =>
      r.last_calibrated_at ? -new Date(r.last_calibrated_at).getTime() : null,
  },
];
type Sort = { col: Col["id"]; dir: "asc" | "desc" } | null;

type State =
  | { kind: "loading"; startedAt: number }
  | { kind: "done"; rows: CatalogRow[]; source: CatalogSource }
  | { kind: "failed"; detail: string; network: boolean };

export function CatalogList() {
  const [state, setState] = useState<State>({
    kind: "loading",
    startedAt: Date.now(),
  });
  const [sort, setSort] = useState<Sort>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setState({ kind: "loading", startedAt: Date.now() });
    try {
      // The catalog the API keeps current (queues every 2 minutes, IBM calibration every 10) (the endpoint's defaults: live=true, force_refresh=false).
      const { data, error } = await api.GET("/catalog");
      if (data)
        setState({
          kind: "done",
          rows: data.result as unknown as CatalogRow[],
          source: data.source,
        });
      else {
        const d = (error as { detail?: unknown } | undefined)?.detail;
        setState({
          kind: "failed",
          detail: typeof d === "string" ? d : "",
          network: false,
        });
      }
    } catch {
      setState({ kind: "failed", detail: "", network: true });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const t = window.setInterval(
      () => setNow(Date.now()),
      state.kind === "loading" ? 1000 : 60000,
    );
    return () => window.clearInterval(t);
  }, [state.kind]);

  const groups = useMemo(() => {
    if (state.kind !== "done") return [];
    const col = sort && COLS.find((c) => c.id === sort.col);
    const order = (rows: CatalogRow[]) =>
      col
        ? [...rows].sort((a, b) => {
            const x = col.value(a),
              y = col.value(b);
            if (x == null) return 1; // missing values sink, in either direction
            if (y == null) return -1;
            return (
              (x < y ? -1 : x > y ? 1 : 0) * (sort!.dir === "asc" ? 1 : -1)
            );
          })
        : rows;
    const ids = [...new Set(state.rows.map((r) => r.provider_id))];
    return ids.map((id) => ({
      id,
      rows: order(state.rows.filter((r) => r.provider_id === id)),
    }));
  }, [state, sort]);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className="heading-5">Catalog</h1>
        <p className="caption-2 muted">
          The QPUs QRB binds to, with their live calibration.
          {state.kind === "done" && ` ${state.rows.length} devices.`}
        </p>
      </header>

      {state.kind === "loading" && (
        <Loading startedAt={state.startedAt} now={now} />
      )}
      {state.kind === "failed" && (
        <Failed
          network={state.network}
          detail={state.detail}
          onRetry={() => void load()}
        />
      )}
      {state.kind === "done" && (
        <>
          <p className={`${styles.source} caption-2 muted`}>
            {sourceLine(state.source)}
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="visually-hidden">
                QPUs in the catalog, grouped by provider
              </caption>
              <thead>
                <tr className="caption-4 muted">
                  <th scope="col">QPU</th>
                  {COLS.map((c) => {
                    const active = sort?.col === c.id;
                    return (
                      <th
                        key={c.id}
                        scope="col"
                        aria-sort={
                          active
                            ? sort!.dir === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          className={styles.sortBtn}
                          onClick={() =>
                            setSort(
                              active
                                ? sort!.dir === "asc"
                                  ? { col: c.id, dir: "desc" }
                                  : null
                                : { col: c.id, dir: "asc" },
                            )
                          }
                        >
                          {c.label}
                          {active &&
                            (sort!.dir === "asc" ? (
                              <CaretUp size={12} aria-hidden />
                            ) : (
                              <CaretDown size={12} aria-hidden />
                            ))}
                        </button>
                      </th>
                    );
                  })}
                  <th scope="col">Status</th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.id}>
                  <tr className={styles.groupRow}>
                    <th
                      colSpan={COLS.length + 2}
                      scope="colgroup"
                      className="caption-4 muted"
                    >
                      <span className={styles.provider} data-provider={g.id}>
                        {providerName(g.id)} ({g.rows.length})
                      </span>
                    </th>
                  </tr>
                  {g.rows.map((r) => (
                    <tr
                      key={r.candidate_id}
                      data-off={!r.operational || undefined}
                    >
                      <th scope="row">
                        <Link
                          href={deviceHref(r.candidate_id)}
                          className={`${styles.name} title-4`}
                        >
                          {r.name}
                        </Link>
                        <span className="caption-2 muted">{r.vendor}</span>
                      </th>
                      <td data-label="Qubits">{count(r.num_qubits)}</td>
                      <td data-label="Queue (jobs)">{count(r.queue_length)}</td>
                      <td data-label="Median 2q error">
                        {pct(r.median_gate_error_2q)}
                      </td>
                      <td data-label="Median readout">
                        {pct(r.median_readout_error)}
                      </td>
                      <td data-label="Calibrated">
                        <time
                          dateTime={r.last_calibrated_at ?? undefined}
                          title={utc(r.last_calibrated_at)}
                        >
                          {ago(r.last_calibrated_at, now)}
                        </time>
                      </td>
                      <td data-label="Status">
                        <span className={styles.status} data-on={r.operational}>
                          {statusLabel(r.operational)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Loading({ startedAt, now }: { startedAt: number; now: number }) {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className={styles.loading}>
      <p className="body-5" role="status">
        Fetching live provider data · {s} s
      </p>
      <div className={styles.skRows} aria-hidden>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={styles.sk} />
        ))}
      </div>
    </div>
  );
}

export function Failed({
  network,
  detail,
  onRetry,
}: {
  network: boolean;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div className={styles.failed} role="alert">
      <WarningCircle size={24} aria-hidden />
      <h2 className="heading-6">
        {network
          ? "The QRB API could not be reached"
          : "Live provider data is unavailable right now"}
      </h2>
      <p className="body-6 soft">
        The catalog only shows live data. Try again in a moment.
      </p>
      {detail && <pre className={styles.detail}>{detail}</pre>}
      <button
        type="button"
        className="btn btn-secondary button-md"
        onClick={onRetry}
      >
        <ArrowCounterClockwise size={16} aria-hidden /> Try again
      </button>
    </div>
  );
}
