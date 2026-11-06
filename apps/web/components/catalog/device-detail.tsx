"use client";

import { ArrowLeft } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type CatalogSource, type Schemas } from "@/lib/api/client";

import { Failed, type CatalogRow } from "./catalog-list";
import styles from "./catalog.module.css";
import {
  ago,
  coherence,
  count,
  pct,
  providerName,
  sourceLine,
  statusLabel,
  utc,
} from "./format";
import { CalibrationData } from "./calibration";

/** GET /catalog/{id} result: a catalog row plus the calibration summary. */
type Detail = CatalogRow & {
  native_gates: string[];
  median_t1_us: number | null;
  median_t2_us: number | null;
  median_gate_error_1q: number | null;
};

type State =
  | { kind: "loading"; startedAt: number }
  | {
      kind: "done";
      detail: Detail;
      topo: Schemas["Topology"] | null;
      source: CatalogSource;
    }
  | { kind: "missing" }
  | { kind: "failed"; detail: string; network: boolean };

export function DeviceDetail({ id }: { id: string }) {
  const [state, setState] = useState<State>({
    kind: "loading",
    startedAt: Date.now(),
  });
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setState({ kind: "loading", startedAt: Date.now() });
    try {
      const path = { params: { path: { candidate_id: id } } };
      const [d, t] = await Promise.all([
        api.GET("/catalog/{candidate_id}", path),
        api.GET("/catalog/{candidate_id}/topology", path),
      ]);
      if (d.response.status === 404) return setState({ kind: "missing" });
      if (!d.data) {
        const x = (d.error as { detail?: unknown } | undefined)?.detail;
        return setState({
          kind: "failed",
          detail: typeof x === "string" ? x : "",
          network: false,
        });
      }
      setState({
        kind: "done",
        detail: d.data.result as unknown as Detail,
        topo: t.data?.result ?? null,
        source: d.data.source,
      });
    } catch {
      setState({ kind: "failed", detail: "", network: true });
    }
  }, [id]);

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

  return (
    <div className={styles.page}>
      <Link href="/catalog" className={`${styles.back} link body-5`}>
        <ArrowLeft size={16} aria-hidden /> All QPUs
      </Link>
      {state.kind === "loading" && (
        <div className={styles.loading}>
          <p className="body-5" role="status">
            Fetching live provider data ·{" "}
            {Math.max(0, Math.floor((now - state.startedAt) / 1000))} s
          </p>
          <div className={styles.skHero} aria-hidden>
            <span className={styles.sk} />
            <span className={styles.sk} />
          </div>
        </div>
      )}
      {state.kind === "failed" && (
        <Failed
          network={state.network}
          detail={state.detail}
          onRetry={() => void load()}
        />
      )}
      {state.kind === "missing" && (
        <div className={styles.failed}>
          <h1 className="heading-5">No QPU called “{id}”</h1>
          <p className="body-6 soft">
            It is not in the live catalog. It may have been retired, or the link
            may be mistyped.
          </p>
          <Link href="/catalog" className="btn btn-secondary button-md">
            See every QPU
          </Link>
        </div>
      )}
      {state.kind === "done" && (
        <Device
          d={state.detail}
          topo={state.topo}
          source={state.source}
          now={now}
        />
      )}
    </div>
  );
}

function Device({
  d,
  topo,
  source,
  now,
}: {
  d: Detail;
  topo: Schemas["Topology"] | null;
  source: CatalogSource;
  now: number;
}) {
  const facts: [string, string][] = [
    ...(topo?.processor
      ? ([["Processor", topo.processor]] as [string, string][])
      : []),
    ["Qubits", count(d.num_qubits)],
    ["Queue", d.queue_length == null ? "—" : `${count(d.queue_length)} jobs`],
    ["Median 1q error", pct(d.median_gate_error_1q)],
    ["Median 2q error", pct(d.median_gate_error_2q)],
    ["Median readout error", pct(d.median_readout_error)],
    ["Median T1", coherence(d.median_t1_us)],
    ["Median T2", coherence(d.median_t2_us)],
  ];
  return (
    <>
      <header className={styles.devHead}>
        <h1 className="heading-4">{d.name}</h1>
        <p
          className={`${styles.provider} body-5 soft`}
          data-provider={d.provider_id}
        >
          {providerName(d.provider_id)} · {d.vendor}
        </p>
        <span className={styles.status} data-on={d.operational}>
          {statusLabel(d.operational)}
        </span>
      </header>

      <section className={styles.devHero} aria-label="Device">
        <Portrait candidateId={d.candidate_id} name={d.name} />
        <div className={styles.facts}>
          <dl className={styles.factGrid}>
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt className="caption-2 muted">{k}</dt>
                <dd className="title-1">{v}</dd>
              </div>
            ))}
          </dl>
          <div className={styles.gates}>
            <p className="caption-2 muted">Native gates</p>
            <ul>
              {d.native_gates.map((g) => (
                <li key={g}>
                  <code>{g}</code>
                </li>
              ))}
            </ul>
          </div>
          <p className="caption-2 muted">
            Calibrated {ago(d.last_calibrated_at, now)} (
            {utc(d.last_calibrated_at)}). {sourceLine(source)}.
          </p>
          <Link
            href={`/bind?provider=${d.provider_id}`}
            className="btn btn-primary button-md"
          >
            Bind with {providerName(d.provider_id)}
          </Link>
        </div>
      </section>

      <section className={styles.devTopo} aria-labelledby="calibration">
        <h2 id="calibration" className="heading-6">
          Calibration data
        </h2>
        {topo ? (
          <CalibrationData topo={topo} />
        ) : (
          <p className="body-6 soft">
            The calibration data could not be loaded for this device.
          </p>
        )}
      </section>
    </>
  );
}

/** The device alone, drawn by the catalog scene in its portrait mode. No WebGL2: nothing is drawn. */
function Portrait({
  candidateId,
  name,
}: {
  candidateId: string;
  name: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let dispose: (() => void) | undefined,
      cancelled = false;
    const onReady = () => setReady(true);
    el.addEventListener("scene-ready", onReady);
    (async () => {
      try {
        const mod = await import("@/scenes/qpu-catalog/main.js");
        const device = mod.candidateToDevice(candidateId);
        if (cancelled || !device) return;
        const reduced = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        dispose = mod.mount(el, {
          focus: device,
          frozenAt: reduced ? 10 : null,
        }).dispose;
      } catch {
        // No WebGL2, or a device the scene does not know: the frame stays empty.
      }
    })();
    return () => {
      cancelled = true;
      el.removeEventListener("scene-ready", onReady);
      dispose?.();
    };
  }, [candidateId]);
  return (
    <div
      ref={box}
      className={styles.portrait}
      data-ready={ready}
      role="img"
      aria-label={`${name}, drawn as glyphs`}
    />
  );
}
