"use client";

import {
  ArrowCounterClockwise,
  CaretDown,
  CaretUp,
  Check,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import {
  Fragment,
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CopyButton } from "@/components/copy-button";
import { getUsage, useAccount } from "@/lib/auth";
import { highlight } from "@/components/highlight";
import type {
  CandidateEvaluation,
  SelectRequest,
  SelectResponse,
} from "@/lib/api/client";

import styles from "./bind.module.css";
import {
  constrainable,
  describeViolation,
  format,
  label,
  unitLabel,
  type Feature,
} from "./features";

export type Outcome =
  | { state: "idle" }
  | { state: "solving"; startedAt: number; pareto: boolean }
  | {
      state: "done";
      response: SelectResponse;
      curl: string;
      sent: SelectRequest;
    }
  | { state: "failed"; status: number; detail: string; retryAfter?: number };

const PROVIDER_NAMES: Record<string, string> = {
  ibm: "IBM Quantum",
  braket: "Amazon Braket",
};
const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;

/** Provider name with its colour marker (IBM blue, Braket orange; neutral for anything else). */
function Provider({
  id,
  className = "caption-2 muted",
}: {
  id: string;
  className?: string;
}) {
  return (
    <span className={`${styles.provider} ${className}`} data-provider={id}>
      {providerName(id)}
    </span>
  );
}

const UTC = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

type Props = {
  outcome: Outcome;
  features: Feature[];
  request: SelectRequest;
  curl: string;
  onRetry: () => void;
};

export const Results = forwardRef<HTMLElement, Props>(function Results(
  { outcome, features, request, curl, onRetry },
  ref,
) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (outcome.state === "done" || outcome.state === "failed")
      headingRef.current?.focus({ preventScroll: true });
  }, [outcome]);

  return (
    <section
      ref={ref}
      className={styles.results}
      aria-label="Result"
      aria-busy={outcome.state === "solving"}
    >
      {outcome.state === "idle" && <Idle request={request} curl={curl} />}
      {outcome.state === "solving" && <Solving startedAt={outcome.startedAt} />}
      {outcome.state === "failed" && (
        <Failed
          ref={headingRef}
          status={outcome.status}
          detail={outcome.detail}
          retryAfter={outcome.retryAfter}
          onRetry={onRetry}
        />
      )}
      {outcome.state === "done" && (
        <Done
          ref={headingRef}
          response={outcome.response}
          curl={outcome.curl}
          sent={outcome.sent}
          features={features}
        />
      )}
    </section>
  );
});

// ---------- states ----------

/** Before the first solve: what will appear, and the exact request Solve will send, kept live. */
function Idle({ request, curl }: { request: SelectRequest; curl: string }) {
  return (
    <div className={styles.idle}>
      <div className={styles.idleIntro}>
        <h2 className="heading-6">Your binding will appear here</h2>
        <ul className={`${styles.idleList} body-6 soft`}>
          <li>
            The QPU that is optimal for your weights and constraints, with its
            provider and figures.
          </li>
          <li>Which data it was decided on, and when that data was fetched.</li>
          <li>
            Every candidate with its features, and for each excluded one, the
            constraint it broke.
          </li>
        </ul>
        <p className="caption-2 muted">
          Solve uses live provider data. Fetching it can take several seconds.
        </p>
      </div>
      <figure className={styles.request}>
        <figcaption className={styles.requestBar}>
          <span className="caption-2 muted">
            Request Solve will send: <code>POST /select</code>
          </span>
          <CopyButton text={curl} label="Copy as curl" name="the request" />
        </figcaption>
        <pre tabIndex={0} aria-label="Request body">
          <code>{highlight(JSON.stringify(request, null, 2), "json")}</code>
        </pre>
      </figure>
    </div>
  );
}

function Solving({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className={styles.solving}>
      <p className="body-5" role="status">
        Fetching live provider data and solving · {s} s
      </p>
      <div className={styles.skHead} aria-hidden>
        <span className={styles.sk} />
        <span className={styles.sk} />
      </div>
      <div className={styles.skRows} aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} className={styles.sk} />
        ))}
      </div>
    </div>
  );
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.max(1, Math.round((seconds % 3600) / 60));
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/**
 * A 429 from the gateway. The daily budget: when it resets and, for a visitor without an account,
 * what signing in gives (the number comes from the gateway). A burst limit: when to try again.
 */
const Limited = forwardRef<HTMLHeadingElement, { detail: string; retryAfter?: number; onRetry: () => void }>(function Limited(
  { detail, retryAfter, onRetry },
  ref,
) {
  const account = useAccount();
  const daily = /daily quota|budget/i.test(detail);
  const [offer, setOffer] = useState<number | null>(null);
  useEffect(() => {
    if (!daily || account.status !== "signed-out") return;
    getUsage()
      .then((u) => setOffer(u.signedInQuota ?? null))
      .catch(() => undefined);
  }, [daily, account.status]);

  const resetsAt = retryAfter ? new Date(Date.now() + retryAfter * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className={styles.failed} role="alert">
      <WarningCircle size={24} aria-hidden />
      <h2 ref={ref} tabIndex={-1} className="heading-6">
        {daily ? "Today\u2019s units are used up" : "Too many solves in a minute"}
      </h2>
      <p className="body-6 soft">
        {daily
          ? `${account.status === "signed-in" ? "Your account\u2019s" : "This address\u2019s"} daily budget resets${resetsAt ? ` at ${resetsAt}, in ${waitText(retryAfter!)}` : " at 00:00 UTC"}. Your inputs are kept.`
          : `Try again${retryAfter ? ` in ${waitText(retryAfter)}` : " in a moment"}. Your inputs are kept.`}
      </p>
      {daily && account.status === "signed-out" && offer !== null && (
        <p className="body-6 soft">Sign in for {offer} units a day of your own, and an API key that shares them.</p>
      )}
      {daily && account.status === "signed-out" && offer !== null ? (
        <Link href="/signin" className="btn btn-secondary button-md">
          Sign in
        </Link>
      ) : !daily ? (
        <button type="button" className="btn btn-secondary button-md" onClick={onRetry}>
          <ArrowCounterClockwise size={16} aria-hidden /> Try again
        </button>
      ) : null}
    </div>
  );
});

const Failed = forwardRef<
  HTMLHeadingElement,
  { status: number; detail: string; retryAfter?: number; onRetry: () => void }
>(function Failed({ status, detail, retryAfter, onRetry }, ref) {
  if (status === 429) return <Limited ref={ref} detail={detail} retryAfter={retryAfter} onRetry={onRetry} />;
  const providerTrouble =
    /ibm|braket|catalog|provider|credential|token|account/i.test(detail);
  let title = "The solve did not complete";
  let body = "Your inputs are kept. Try again in a moment.";
  if (status === 0) {
    title = "The QRB API could not be reached";
    body = "Check your connection and try again. Your inputs are kept.";
  } else if (status === 422) {
    title = "The request was not accepted";
    body = "The details are next to the field that needs attention.";
  } else if (providerTrouble) {
    title = "Live provider data is unavailable right now";
    body =
      "Bind only answers from live data. Your inputs are kept; try again in a moment.";
  }
  return (
    <div className={styles.failed} role="alert">
      <WarningCircle size={24} aria-hidden />
      <h2 ref={ref} tabIndex={-1} className="heading-6">
        {title}
      </h2>
      <p className="body-6 soft">{body}</p>
      {detail && status !== 422 && (
        <pre className={styles.detail}>{detail}</pre>
      )}
      {status !== 422 && (
        <button
          type="button"
          className="btn btn-secondary button-md"
          onClick={onRetry}
        >
          <ArrowCounterClockwise size={16} aria-hidden /> Try again
        </button>
      )}
    </div>
  );
});

// ---------- result ----------

type Sort = { col: string; dir: "asc" | "desc" } | null;

const Done = forwardRef<
  HTMLHeadingElement,
  {
    response: SelectResponse;
    curl: string;
    sent: SelectRequest;
    features: Feature[];
  }
>(function Done({ response, curl, sent, features }, ref) {
  const byId = useMemo(
    () => new Map(features.map((f) => [f.id, f])),
    [features],
  );
  const [sort, setSort] = useState<Sort>(null);

  const { result, source, candidates, timings_ms } = response;
  const pareto = Boolean(sent.preferences?.pareto);
  const feasible =
    result.feasibility === "FEASIBLE" && result.solutions.length > 0;

  // Columns: the features this request weighted or constrained, plus qubits, in the API's order.
  const used = new Set<string>([
    "num_qubits",
    ...Object.keys(sent.preferences?.weights ?? {}),
  ]);
  for (const c of sent.preferences?.constraints ?? []) used.add(c.feature);
  const cols = constrainable(features).filter((f) => used.has(f.id));

  const excluded = (c: CandidateEvaluation) =>
    c.violated_constraints.length > 0 || Boolean(c.excluded_reason);
  const sorted = (rows: CandidateEvaluation[]) =>
    sort
      ? [...rows].sort(
          (a, b) =>
            ((a.features[sort.col] ?? 0) - (b.features[sort.col] ?? 0)) *
            (sort.dir === "asc" ? 1 : -1),
        )
      : rows;
  const chosen = sorted(candidates.filter((c) => c.selected));
  const others = sorted(candidates.filter((c) => !c.selected && !excluded(c)));
  const out = sorted(candidates.filter((c) => !c.selected && excluded(c)));
  const winner =
    !pareto && feasible ? candidates.find((c) => c.selected) : undefined;

  const asOf = source.as_of ? new Date(source.as_of) : null;
  const sourceText =
    source.mode === "live"
      ? source.cache_hit
        ? `Provider data from ${asOf ? `${UTC.format(asOf)} UTC` : "the last refresh"} (queues refreshed every 2 minutes)`
        : `Provider data fetched now${asOf ? `, ${UTC.format(asOf)} UTC` : ""}`
      : `Frozen snapshot${asOf ? `, captured ${DAY.format(asOf)}` : ""}`;

  return (
    <div className={styles.done}>
      <div className={winner ? styles.winnerPanel : undefined}>
        <header className={styles.resultHead}>
          <div className={styles.resultTitle}>
            {winner && (
              <>
                <p className="caption-2 muted">Binding</p>
                <h2 ref={ref} tabIndex={-1} className="heading-4">
                  {winner.name}
                </h2>
                <Provider id={winner.provider_id} className="body-5 soft" />
              </>
            )}
            {pareto && (
              <>
                <h2 ref={ref} tabIndex={-1} className="heading-4">
                  {chosen.length} non dominated bindings
                </h2>
                <p className="body-6 soft">
                  No single optimum: for each binding here, no other candidate
                  is better on every weighted feature.
                </p>
              </>
            )}
            {!feasible && !winner && (
              <>
                <h2 ref={ref} tabIndex={-1} className="heading-4">
                  No candidate meets every constraint
                </h2>
                <p className="body-6 soft">
                  Each QPU below breaks at least one. Loosen a constraint and
                  solve again.
                </p>
              </>
            )}
          </div>
          <CopyButton text={curl} label="Copy as curl" name="the request" />
        </header>
        {winner && (
          <dl className={styles.evidence} aria-label={`${winner.name} figures`}>
            {cols.map((f) =>
              winner.features[f.id] === undefined ? null : (
                <div key={f.id}>
                  <dt className="caption-2 muted">{label(f)}</dt>
                  <dd className="title-2">
                    {format(f, winner.features[f.id])}
                    {unitLabel(f) && f.unit !== "usd" && (
                      <span className="caption-2 muted"> {unitLabel(f)}</span>
                    )}
                  </dd>
                </div>
              ),
            )}
          </dl>
        )}
      </div>
      <p className={`${styles.meta} caption-2 muted`}>
        <span>{sourceText}</span>
        <span>
          Solved by {result.provenance.engine_id} in{" "}
          {(timings_ms.request_total_ms / 1000).toFixed(1)} s
        </span>
      </p>
      <p className="visually-hidden" role="status">
        {winner
          ? `Binding found: ${winner.name}.`
          : pareto
            ? `${chosen.length} non dominated bindings found.`
            : "No candidate meets every constraint."}
      </p>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="visually-hidden">
            All {candidates.length} candidates and their features
          </caption>
          <thead>
            <tr className="caption-4 muted">
              <th scope="col">Candidate</th>
              {cols.map((f) => {
                const active = sort?.col === f.id;
                const unit = unitLabel(f);
                return (
                  <th
                    key={f.id}
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
                              ? { col: f.id, dir: "desc" }
                              : null
                            : { col: f.id, dir: "asc" },
                        )
                      }
                    >
                      {label(f)}
                      {unit ? ` (${unit})` : ""}
                      {active ? (
                        sort!.dir === "asc" ? (
                          <CaretUp size={12} aria-hidden />
                        ) : (
                          <CaretDown size={12} aria-hidden />
                        )
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          {chosen.length > 0 && (
            <Group
              title={
                pareto ? `Non dominated bindings (${chosen.length})` : "Binding"
              }
              rows={chosen}
              cols={cols}
              byId={byId}
              span={cols.length + 1}
              selected
            />
          )}
          {others.length > 0 && (
            <Group
              title={`Other feasible candidates (${others.length})`}
              rows={others}
              cols={cols}
              byId={byId}
              span={cols.length + 1}
            />
          )}
          {out.length > 0 && (
            <Group
              title={`Excluded (${out.length})`}
              rows={out}
              cols={cols}
              byId={byId}
              span={cols.length + 1}
              excluded
            />
          )}
        </table>
      </div>
    </div>
  );
});

function Group({
  title,
  rows,
  cols,
  byId,
  span,
  selected = false,
  excluded = false,
}: {
  title: string;
  rows: CandidateEvaluation[];
  cols: Feature[];
  byId: Map<string, Feature>;
  span: number;
  selected?: boolean;
  excluded?: boolean;
}) {
  return (
    <tbody
      className={
        selected ? styles.chosen : excluded ? styles.excluded : undefined
      }
    >
      <tr className={styles.groupRow}>
        <th colSpan={span} scope="colgroup" className="caption-4 muted">
          {title}
        </th>
      </tr>
      {rows.map((c) => (
        <Fragment key={c.candidate_id}>
          <tr>
            <th scope="row">
              <span className={styles.cand}>
                {selected && (
                  <Check
                    size={16}
                    weight="bold"
                    aria-label="Selected"
                    className={styles.check}
                  />
                )}
                <Link
                  href={`/catalog/${encodeURIComponent(c.candidate_id)}`}
                  className={`${styles.candLink} title-4`}
                >
                  {c.name}
                </Link>
              </span>
              <Provider id={c.provider_id} />
            </th>
            {cols.map((f) => (
              <td
                key={f.id}
                className="body-6"
                data-label={`${label(f)}${unitLabel(f) ? ` (${unitLabel(f)})` : ""}`}
              >
                {c.features[f.id] === undefined
                  ? "—"
                  : format(f, c.features[f.id])}
              </td>
            ))}
          </tr>
          {excluded && (
            <tr className={styles.reasonRow}>
              <td colSpan={span}>
                <ul
                  className={styles.reasons}
                  aria-label={`Why ${c.name} was excluded`}
                >
                  {c.violated_constraints.map((v) => (
                    <li key={v.constraint_id} className="caption-2 soft">
                      {describeViolation(byId, v)}
                    </li>
                  ))}
                  {c.excluded_reason && (
                    <li className="caption-2 soft">{c.excluded_reason}</li>
                  )}
                </ul>
              </td>
            </tr>
          )}
        </Fragment>
      ))}
    </tbody>
  );
}
