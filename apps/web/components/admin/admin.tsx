"use client";

import { MagnifyingGlass, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  adminSession,
  banUser,
  clearQuota,
  getCatalog,
  getStats,
  getUser,
  listAudit,
  listUsers,
  needsReauth,
  removeUser,
  revokeSessions,
  revokeUserKey,
  setQuota,
  setRole,
  unbanUser,
  type AdminCatalog,
  type AdminSession,
  type AdminStats,
  type AdminUserDetail,
  type AdminUserRow,
  type AuditEntry,
} from "@/lib/admin";
import { linkedProviders, RequestError, signIn, useAccount, type Provider } from "@/lib/auth";

import account from "../account/account.module.css";
import styles from "./admin.module.css";

const PROVIDER_NAME: Record<string, string> = { github: "GitHub", orcid: "ORCID" };
const TABS = ["Users", "Overview", "Catalog", "Audit"] as const;
type Tab = (typeof TABS)[number];

const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
function fmtAge(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

function Failure({ message }: { message: string }) {
  return (
    <p className={`${account.error} caption-2`} role="alert">
      <WarningCircle size={16} aria-hidden /> {message}
    </p>
  );
}

function Skeleton() {
  return (
    <div className={account.usageSk} aria-busy="true" aria-label="Loading">
      <span className={account.sk} />
      <span className={account.sk} />
    </div>
  );
}

/** Runs an admin change; a stale sign-in is reported to the page instead of as an error. */
type Run = (work: () => Promise<unknown>, done?: () => void) => Promise<string | null>;

// ---------- users ----------

function UserTable({ rows, selected, onSelect }: { rows: AdminUserRow[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className={account.tableWrap}>
      <table className={account.activityTable}>
        <thead className="caption-2 muted">
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Signed in with</th>
            <th scope="col">Joined</th>
            <th scope="col" className={account.num}>Units today</th>
            <th scope="col" className={account.num}>Keys</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody className="body-6">
          {rows.map((u) => (
            <tr key={u.id} data-open={selected === u.id || undefined} data-off={u.banned || undefined}>
              <th scope="row">
                <button type="button" className={styles.rowButton} onClick={() => onSelect(u.id)} aria-expanded={selected === u.id}>
                  <span className={account.cellMain}>{u.name}</span>
                  <span className="caption-2 muted">{u.email ?? u.id}</span>
                </button>
              </th>
              <td>{u.providers.map((p) => PROVIDER_NAME[p] ?? p).join(", ") || "—"}</td>
              <td>{fmtDate(u.createdAt)}</td>
              <td className={account.num}>
                {u.unitsToday}
                {u.dailyUnitsOverride !== null && <span className="caption-2 muted"> of {u.dailyUnitsOverride}</span>}
              </td>
              <td className={account.num}>{u.keyCount}</td>
              <td>
                <span className={styles.badges}>
                  {(u.role === "admin" || u.bootstrapAdmin) && <span className={styles.badge}>Admin</span>}
                  {u.banned && <span className={`${styles.badge} ${styles.badgeDanger}`}>Banned</span>}
                  {u.dailyUnitsOverride !== null && <span className={styles.badge}>Own quota</span>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={styles.field}>
      <span className="caption-2 muted">{label}</span>
      {children}
    </label>
  );
}

/** One action: a button that opens a small form, or acts at once when it has no fields. */
function Action({
  label,
  danger,
  fields,
  submitLabel,
  onSubmit,
}: {
  label: string;
  danger?: boolean;
  fields?: ReactNode;
  submitLabel?: string;
  onSubmit: (form: FormData) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cls = `btn btn-secondary button-sm${danger ? ` ${account.danger}` : ""}`;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await onSubmit(new FormData(e.currentTarget));
    setBusy(false);
    if (err) setError(err);
    else setOpen(false);
  };
  if (!open)
    return (
      <button type="button" className={cls} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <form className={styles.actionForm} onSubmit={(e) => void submit(e)}>
      {fields}
      <div className={account.confirmActions}>
        <button type="submit" className={cls} disabled={busy} aria-disabled={busy}>
          {busy ? "Working…" : (submitLabel ?? label)}
        </button>
        <button type="button" className="btn btn-secondary button-sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && <Failure message={error} />}
    </form>
  );
}

function DailyBars({ days }: { days: { day: string; units: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.units));
  if (!days.length) return <p className="caption-2 muted">No units used in the last 30 days.</p>;
  return (
    <div className={styles.miniBars} role="img" aria-label={`Units per day, last 30 days, peak ${max}`}>
      {days.map((d) => (
        <span key={d.day} title={`${d.day}: ${d.units} units`} style={{ height: `${(d.units / max) * 100}%` }} />
      ))}
    </div>
  );
}

function UserDetail({ id, me, run, onChanged }: { id: string; me: string; run: Run; onChanged: () => void }) {
  const [u, setU] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    getUser(id)
      .then((d) => {
        setU(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <Failure message={`This account could not be loaded. ${error}`} />;
  if (!u) return <Skeleton />;

  const self = u.id === me;
  const after = () => {
    load();
    onChanged();
  };
  const isAdmin = u.role === "admin" || u.bootstrapAdmin;

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <div>
          <h3 className="heading-6">{u.name}</h3>
          <p className="caption-2 muted">
            {[u.email, `id ${u.id}`, `joined ${fmtDate(u.createdAt)}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        {u.banned && (
          <p className={`${styles.banNote} caption-2`}>
            Banned{u.banExpires ? ` until ${fmtDateTime(u.banExpires)}` : " permanently"}: {u.banReason}
          </p>
        )}
      </div>

      <dl className={styles.facts}>
        <div>
          <dt className="caption-2 muted">Sign-in accounts</dt>
          <dd className="body-6">
            {u.accounts.map((a) => (
              <span key={a.provider + a.accountId}>
                {PROVIDER_NAME[a.provider] ?? a.provider} <code>{a.accountId}</code>
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="caption-2 muted">Daily units</dt>
          <dd className="body-6">
            {u.quotaOverride ? (
              <span>
                {u.quotaOverride.dailyUnits} (own quota: {u.quotaOverride.reason})
              </span>
            ) : (
              <span>Signed-in tier default</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="caption-2 muted">Binds stored</dt>
          <dd className="body-6">
            {u.binds.total}
            {u.binds.pending > 0 && ` (${u.binds.pending} resolving)`}
          </dd>
        </div>
        <div>
          <dt className="caption-2 muted">Last 30 days</dt>
          <dd>
            <DailyBars days={u.daily} />
          </dd>
        </div>
      </dl>

      <div className={styles.detailGrid}>
        <section>
          <h4 className="title-4">Sessions</h4>
          {u.sessions.length ? (
            <ul className={styles.list}>
              {u.sessions.map((s) => (
                <li key={s.id} className="caption-2">
                  <span className="soft">Signed in {fmtDateTime(s.createdAt)}</span>
                  <span className="muted">
                    Last seen {fmtAge(s.lastSeenAt)}
                    {s.network ? ` from ${s.network}` : ""}
                  </span>
                  {s.userAgent && <span className={`muted ${styles.ua}`}>{s.userAgent}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="caption-2 muted">Not signed in anywhere.</p>
          )}
        </section>
        <section>
          <h4 className="title-4">API keys</h4>
          {u.keys.length ? (
            <ul className={styles.list}>
              {u.keys.map((k) => (
                <li key={k.id} className={styles.keyItem}>
                  <span className="caption-2">
                    <span className={account.keyStart}>{k.start}…</span> <span className="muted">{k.name} · {fmtDate(k.createdAt)}</span>
                  </span>
                  <Action label="Revoke" danger submitLabel="Revoke this key" onSubmit={() => run(() => revokeUserKey(u.id, k.id), after)} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="caption-2 muted">No API key.</p>
          )}
        </section>
      </div>

      <section>
        <h4 className="title-4">Recent counted requests</h4>
        {u.requests.length ? (
          <div className={account.tableWrap}>
            <table className={`${account.activityTable} ${styles.compact}`}>
              <thead className="caption-2 muted">
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Request</th>
                  <th scope="col">Source</th>
                  <th scope="col" className={account.num}>Status</th>
                  <th scope="col" className={account.num}>Cost</th>
                  <th scope="col" className={account.num}>Time</th>
                </tr>
              </thead>
              <tbody className="caption-2">
                {u.requests.slice(0, 15).map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.at)}</td>
                    <td>
                      <code className={account.endpoint}>
                        {r.method} {r.path}
                      </code>
                    </td>
                    <td>{r.apiKeyStart ? `Key ${r.apiKeyStart}…` : "Browser"}</td>
                    <td className={account.num}>{r.status}</td>
                    <td className={account.num}>{r.cost}</td>
                    <td className={account.num}>{(r.durationMs / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="caption-2 muted">None in the last 30 days.</p>
        )}
      </section>

      <section className={styles.actions} aria-label="Actions">
        <h4 className="title-4">Actions</h4>
        {self ? (
          <p className="caption-2 muted">This is your own account. Another admin can change it.</p>
        ) : (
          <div className={styles.actionRow}>
            {u.banned ? (
              <Action label="Lift the ban" onSubmit={() => run(() => unbanUser(u.id), after)} />
            ) : (
              <Action
                label="Ban"
                danger
                submitLabel="Ban and revoke keys"
                fields={
                  <>
                    <Field label="Reason (the user does not see it)">
                      <input name="reason" required maxLength={200} className={styles.input} />
                    </Field>
                    <Field label="For">
                      <select name="days" className={styles.input} defaultValue="">
                        <option value="1">1 day</option>
                        <option value="7">7 days</option>
                        <option value="30">30 days</option>
                        <option value="">Until lifted</option>
                      </select>
                    </Field>
                    <p className="caption-2 muted">Signs them out everywhere and deletes their API keys.</p>
                  </>
                }
                onSubmit={(f) => run(() => banUser(u.id, String(f.get("reason")), f.get("days") ? Number(f.get("days")) : null), after)}
              />
            )}
            <Action label="Sign out everywhere" submitLabel="Sign them out" onSubmit={() => run(() => revokeSessions(u.id), after)} />
            <Action
              label={u.quotaOverride ? "Change quota" : "Set own quota"}
              submitLabel="Save quota"
              fields={
                <>
                  <Field label="Daily units">
                    <input name="units" type="number" min={0} max={1_000_000} step={1} required defaultValue={u.quotaOverride?.dailyUnits ?? ""} className={styles.input} />
                  </Field>
                  <Field label="Reason">
                    <input name="reason" required maxLength={200} defaultValue={u.quotaOverride?.reason ?? ""} className={styles.input} />
                  </Field>
                </>
              }
              onSubmit={(f) => run(() => setQuota(u.id, Number(f.get("units")), String(f.get("reason"))), after)}
            />
            {u.quotaOverride && <Action label="Back to default quota" onSubmit={() => run(() => clearQuota(u.id), after)} />}
            {isAdmin ? (
              <Action label="Remove admin" submitLabel="Make a regular user" onSubmit={() => run(() => setRole(u.id, "user"), after)} />
            ) : (
              <Action label="Make admin" submitLabel="Give admin access" onSubmit={() => run(() => setRole(u.id, "admin"), after)} />
            )}
            <Action
              label="Delete account"
              danger
              submitLabel="Delete for good"
              fields={
                <Field label={`Type ${u.id} to confirm. Keys, history and quota go too; this cannot be undone.`}>
                  <input name="confirm" required pattern={u.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} className={styles.input} autoComplete="off" />
                </Field>
              }
              onSubmit={() => run(() => removeUser(u.id), onChanged)}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function Users({ me, run }: { me: string; run: Run }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ users: AdminUserRow[]; total: number; pageSize: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(() => {
    listUsers(query, page)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [query, page]);
  useEffect(load, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className={account.rowBody}>
      <form
        className={styles.search}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(0);
          setSelected(null);
          setQuery(q.trim());
        }}
      >
        <MagnifyingGlass size={16} aria-hidden className="muted" />
        <input
          className={styles.searchInput}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name, email, user id, GitHub id or ORCID iD"
          aria-label="Search accounts"
        />
        <button type="submit" className="btn btn-secondary button-sm">
          Search
        </button>
      </form>
      {error ? (
        <Failure message={`Accounts could not be loaded. ${error}`} />
      ) : !data ? (
        <Skeleton />
      ) : data.users.length === 0 ? (
        <p className="body-6 muted">No account matches.</p>
      ) : (
        <>
          <p className="caption-2 muted">
            {data.total} account{data.total === 1 ? "" : "s"}
            {query && ` matching “${query}”`}
          </p>
          <UserTable rows={data.users} selected={selected} onSelect={(id) => setSelected((s) => (s === id ? null : id))} />
          {pages > 1 && (
            <div className={styles.pager}>
              <button type="button" className="btn btn-secondary button-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Newer
              </button>
              <span className="caption-2 muted">
                Page {page + 1} of {pages}
              </span>
              <button type="button" className="btn btn-secondary button-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Older
              </button>
            </div>
          )}
        </>
      )}
      {selected && (
        <UserDetail
          key={selected}
          id={selected}
          me={me}
          run={run}
          onChanged={() => {
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------- overview ----------

function Overview() {
  const [s, setS] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getStats()
      .then(setS)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <Failure message={`Statistics could not be loaded. ${error}`} />;
  if (!s) return <Skeleton />;
  const t = s.totals;
  const today = s.days.at(-1)!;
  const max = Math.max(1, ...s.days.map((d) => d.unitsAnonymous + d.unitsSignedIn));
  const sum = (k: keyof AdminStats["days"][number]) => s.days.reduce((n, d) => n + (d[k] as number), 0);
  const figures: [string, number | string][] = [
    ["Accounts", t.users],
    ["New in 30 days", sum("signups")],
    ["Active today", today.activeAccounts],
    ["API keys", t.apiKeys],
    ["Admins", t.admins],
    ["Banned", t.banned],
    ["Own quotas", t.quotaOverrides],
    ["Binds resolving", t.pendingBinds],
  ];
  return (
    <div className={account.rowBody}>
      <dl className={styles.figures}>
        {figures.map(([label, n]) => (
          <div key={label}>
            <dt className="caption-2 muted">{label}</dt>
            <dd className="heading-5">{n}</dd>
          </div>
        ))}
      </dl>
      <div className={account.chartWrap}>
        <h3 className="title-4">Units used per day</h3>
        <div className={account.chart} role="img" aria-label={`Units per day over 30 days; peak ${max}`}>
          {s.days.map((d) => {
            return (
              <div key={d.day} className={account.bar} title={`${d.day}: ${d.unitsSignedIn} signed in, ${d.unitsAnonymous} without account`}>
                <span className={account.barKey} style={{ height: `${(d.unitsSignedIn / max) * 100}%` }} />
                <span className={account.barBrowser} style={{ height: `${(d.unitsAnonymous / max) * 100}%` }} />
              </div>
            );
          })}
        </div>
        <div className={account.legend}>
          <span className={`${account.legendKey} caption-2 muted`}>Signed in</span>
          <span className={`${account.legendBrowser} caption-2 muted`}>Without account (by IP)</span>
        </div>
      </div>
      <p className="caption-2 muted">
        Signed-in counted requests in 30 days: {sum("requests")}, of which {sum("rejected")} hit a limit (429) and {sum("errors")} failed upstream (5xx).
        Request rates, latency and host health are in Grafana.
      </p>
    </div>
  );
}

// ---------- catalog ----------

function Catalog() {
  const [c, setC] = useState<AdminCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getCatalog()
      .then(setC)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <Failure message={`The catalog state could not be loaded. ${error}`} />;
  if (!c) return <Skeleton />;
  if (!c.available) return <p className="body-6 muted">The stored catalog tables are not in this database (the API and poller have not run here).</p>;
  const stale = (iso: string | null, minutes: number) => !iso || Date.now() - Date.parse(iso) > minutes * 60_000;
  return (
    <div className={account.rowBody}>
      <p className="body-6">
        Queues and status were last fetched <strong data-stale={stale(c.statusFetchedAt, 10) || undefined} className={styles.age}>{fmtAge(c.statusFetchedAt)}</strong>
        {c.statusOrigin && <span className="muted"> by the {c.statusOrigin}</span>}. The poller refreshes them every 2 minutes.
      </p>
      <div className={account.tableWrap}>
        <table className={account.activityTable}>
          <thead className="caption-2 muted">
            <tr>
              <th scope="col">QPU</th>
              <th scope="col">Provider</th>
              <th scope="col">Last confirmed</th>
              <th scope="col">Calibrated</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody className="body-6">
            {c.resources.map((r) => (
              <tr key={r.provider + r.resource}>
                <th scope="row" className={account.cellMain}>
                  {r.resource}
                </th>
                <td>{r.provider}</td>
                <td>
                  <span data-stale={stale(r.checkedAt, 60) || undefined} className={styles.age}>
                    {fmtAge(r.checkedAt)}
                  </span>
                </td>
                <td>{fmtAge(r.calibratedAt)}</td>
                <td>{r.origin}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- audit ----------

const ACTION_LABEL: Record<string, string> = {
  "user.ban": "banned",
  "user.unban": "lifted the ban on",
  "user.revoke_sessions": "signed out",
  "key.revoke": "revoked an API key of",
  "quota.set": "set the quota of",
  "quota.clear": "reset the quota of",
  "user.set_role": "changed the role of",
  "user.remove": "deleted",
};

function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (before?: string | null) =>
    listAudit(before)
      .then((r) => {
        setEntries((e) => (before ? [...(e ?? []), ...r.entries] : r.entries));
        setNext(r.next);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (error) return <Failure message={`The audit log could not be loaded. ${error}`} />;
  if (!entries) return <Skeleton />;
  if (!entries.length) return <p className="body-6 muted">No admin actions yet.</p>;
  return (
    <div className={account.rowBody}>
      <ol className={styles.audit}>
        {entries.map((e) => (
          <li key={e.id}>
            <span className="body-6">
              <span className={account.cellMain}>{e.actor.name ?? e.actor.id}</span> {ACTION_LABEL[e.action] ?? e.action}{" "}
              <span className={account.cellMain}>{e.target ? (e.target.name ?? `${e.target.id} (deleted)`) : "—"}</span>
            </span>
            <span className="caption-2 muted">
              {fmtDateTime(e.at)}
              {Object.keys(e.details).length > 0 && ` · ${JSON.stringify(e.details)}`}
            </span>
          </li>
        ))}
      </ol>
      {next && (
        <button type="button" className="btn btn-secondary button-sm" onClick={() => void load(next)}>
          Older entries
        </button>
      )}
    </div>
  );
}

// ---------- page ----------

export function Admin() {
  const state = useAccount();
  const router = useRouter();
  const [session, setSession] = useState<AdminSession | null>(null);
  const [denied, setDenied] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [reauth, setReauth] = useState(false);
  const [tab, setTab] = useState<Tab>("Users");
  const [, tick] = useState(0);

  const signedIn = state.status === "signed-in";
  useEffect(() => {
    if (state.status === "signed-out" || state.status === "unavailable") router.replace("/signin");
  }, [state.status, router]);

  useEffect(() => {
    if (!signedIn) return;
    adminSession()
      .then(setSession)
      .catch((e) => {
        if (e instanceof RequestError && e.status === 404) setDenied(true);
      });
    linkedProviders()
      .then((p) => setProviders(p.filter((x): x is Provider => x === "github" || x === "orcid")))
      .catch(() => undefined);
    // Re-render each minute so the "changes allowed until" notice turns into the sign-in prompt.
    const t = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, [signedIn]);

  const run: Run = useCallback(async (work, done) => {
    try {
      await work();
      done?.();
      return null;
    } catch (e) {
      if (needsReauth(e)) {
        setReauth(true);
        return "Sign in again to make changes (see the notice at the top).";
      }
      return (e as Error).message;
    }
  }, []);

  if (!signedIn || (!session && !denied))
    return (
      <div className={account.page} aria-busy="true">
        <span className={`${account.sk} ${account.skTitle}`} />
      </div>
    );

  if (denied)
    return (
      <div className={account.narrow}>
        <h1 className="heading-4">Not available</h1>
        <p className={`${account.lead} body-3 soft`}>This page is for QRB maintainers.</p>
      </div>
    );

  const until = Date.parse(session!.changesAllowedUntil);
  const canChange = !reauth && Date.now() < until;

  return (
    <div className={account.page}>
      <header className={account.head}>
        <div>
          <h1 className="heading-4">Admin</h1>
          <p className="caption-2 muted">Accounts, limits and the stored catalog. Every change is recorded in the audit log.</p>
        </div>
        <div className={styles.stepUp} data-expired={!canChange || undefined}>
          {canChange ? (
            <p className="caption-2 muted">Changes allowed until {fmtTime(session!.changesAllowedUntil)}</p>
          ) : (
            <>
              <p className="caption-2 soft">Changes need a sign-in from the last 15 minutes.</p>
              {providers.map((p) => (
                <button key={p} type="button" className="btn btn-primary button-sm" onClick={() => void signIn(p, "/admin")}>
                  Sign in again with {PROVIDER_NAME[p]}
                </button>
              ))}
            </>
          )}
        </div>
      </header>

      <div className={account.segmented} role="radiogroup" aria-label="Section">
        {TABS.map((t) => (
          <label key={t}>
            <input type="radio" name="admin-tab" checked={tab === t} onChange={() => setTab(t)} />
            <span className="button-sm">{t}</span>
          </label>
        ))}
      </div>

      <section className={styles.panel} aria-label={tab}>
        {tab === "Users" && <Users me={session!.userId} run={run} />}
        {tab === "Overview" && <Overview />}
        {tab === "Catalog" && <Catalog />}
        {tab === "Audit" && <Audit />}
      </section>
    </div>
  );
}
