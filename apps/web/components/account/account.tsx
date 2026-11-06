"use client";

import { CaretDown, Key, SignOut, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { highlight } from "@/components/highlight";
import { API_BASE_URL } from "@/lib/api/client";
import {
  RequestError,
  createKey,
  getUsage,
  linkedProviders,
  listKeys,
  revokeKey,
  signOut,
  useAccount,
  getDaily,
  type ApiKey,
  type DailyUsage,
  type Usage,
} from "@/lib/auth";

import { Activity, UsageChart } from "./activity";
import { Avatar } from "./user-status";
import styles from "./account.module.css";

const PROVIDER_NAME: Record<string, string> = { github: "GitHub", orcid: "ORCID" };

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
function fmtIn(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.max(1, Math.round((seconds % 3600) / 60));
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
const per = (n: number, windowSeconds: number) => `${n} per ${windowSeconds === 60 ? "minute" : `${windowSeconds} s`}`;
const units = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;

function Failure({ message }: { message: string }) {
  return (
    <p className={`${styles.error} caption-2`} role="alert">
      <WarningCircle size={16} aria-hidden /> {message}
    </p>
  );
}

// ---------- usage ----------

/**
 * Today's units. The total is the quota counter (what the budget enforces); the split by source
 * comes from the day's activity, which also counts async binds still resolving, so the two agree.
 * Anything the counter holds that the activity does not explain yet is shown as such, never hidden
 * inside a source.
 */
function TodayUsage({ usage, error, today }: { usage: Usage | null; error: string | null; today: DailyUsage | null }) {
  if (error) return <Failure message={`Usage could not be loaded. ${error}`} />;
  if (!usage)
    return (
      <div className={styles.usageSk} aria-busy="true" aria-label="Loading usage">
        <span className={styles.sk} />
        <span className={styles.sk} />
      </div>
    );
  const out = usage.remaining === 0;
  const key = Math.min(today?.key ?? 0, usage.used);
  const browser = Math.min(today?.browser ?? 0, usage.used - key);
  const unlisted = Math.max(0, usage.used - key - browser);
  const pending = Math.min(today?.pending ?? 0, usage.used);
  const pct = (n: number) => `${usage.quota > 0 ? Math.min(100, (n / usage.quota) * 100) : 100}%`;
  return (
    <div className={styles.today}>
      <p className={styles.figure}>
        <span className="heading-3">{usage.used}</span>
        <span className="title-2 soft"> of {usage.quota} units used today</span>
      </p>
      <div
        className={styles.meter}
        role="meter"
        aria-label="Units used today"
        aria-valuemin={0}
        aria-valuemax={usage.quota}
        aria-valuenow={usage.used}
        aria-valuetext={`${usage.used} of ${usage.quota} units`}
        data-out={out || undefined}
      >
        <span className={styles.meterKey} style={{ width: pct(key) }} />
        <span className={styles.meterBrowser} style={{ width: pct(browser) }} />
        {unlisted > 0 && <span className={styles.meterOther} style={{ width: pct(unlisted) }} />}
      </div>
      <p className={`${styles.split} caption-2 muted`}>
        <span className={styles.legendKey}>
          API key <span className="soft">{key}</span>
        </span>
        <span className={styles.legendBrowser}>
          Browser <span className="soft">{browser}</span>
        </span>
        {unlisted > 0 && (
          <span className={styles.legendOther} title="Charged to your budget but not in the activity log yet; it appears there within seconds.">
            Not listed yet <span className="soft">{unlisted}</span>
          </span>
        )}
      </p>
      <p className="body-6 soft">
        {out ? "No units left today." : `${usage.remaining} left today.`} Your API key and your signed-in browsers draw on the same budget.
        {pending > 0 && (
          <span className="muted">
            {" "}
            {pending} {pending === 1 ? "unit is" : "units are"} held by binds still resolving and come back if they fail.
          </span>
        )}
      </p>
    </div>
  );
}

/** What requests cost and how often they may be made, from the gateway's own figures. */
function Costs({ usage }: { usage: Usage | null }) {
  if (!usage)
    return (
      <div className={styles.usageSk} aria-busy="true" aria-label="Loading prices">
        <span className={styles.sk} />
      </div>
    );
  return (
    <details className={styles.costs}>
      <summary className="body-5">
        What requests cost
        <CaretDown size={16} aria-hidden className={styles.costsCaret} />
      </summary>
    <table className={`${styles.limits} body-6`}>
      <caption className="visually-hidden">What requests cost and how often they may be made</caption>
      <tbody>
        <tr>
          <th scope="row">Bind on stored data</th>
          <td>
            <span className={styles.price}>{units(usage.costs.resolve)}</span>
            <span className="muted">The default. Queues are refreshed every 2 minutes.</span>
          </td>
        </tr>
        <tr>
          <th scope="row">Bind on fresh data</th>
          <td>
            <span className={styles.price}>{units(usage.costs.liveRefresh)}</span>
            <span className="muted">
              With <code>force_refresh</code>, which asks the providers now.
            </span>
          </td>
        </tr>
        <tr>
          <th scope="row">Catalog reads</th>
          <td>
            <span className={styles.price}>Free</span>
            <span className="muted">
              {units(usage.costs.liveRefresh)} with <code>force_refresh</code>.
            </span>
          </td>
        </tr>
        <tr>
          <th scope="row">Presets, features, usage</th>
          <td>
            <span className={styles.price}>Free</span>
          </td>
        </tr>
        <tr>
          <th scope="row">Rate</th>
          <td>
            <span className={styles.price}>{per(usage.burst.limit, usage.burst.windowSeconds)}</span>
            <span className="muted">
              From the website{usage.burst.apiKeyLimit !== undefined && `; ${per(usage.burst.apiKeyLimit, usage.burst.windowSeconds)} with the API key`}.
            </span>
          </td>
        </tr>
      </tbody>
    </table>
    </details>
  );
}

// ---------- API key ----------

type Created = ApiKey & { key: string };

function KeyPanel({ onChange }: { onChange: () => void }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listKeys()
      .then(setKeys)
      .catch((e: Error) => setError(`Your key could not be loaded. ${e.message}`));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const k = await createKey();
      setCreated(k);
      setKeys([k]);
      onChange();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof RequestError && e.status === 409) load();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokeKey(id);
      setKeys([]);
      setCreated(null);
      setConfirming(false);
    } catch (e) {
      setError(`The key was not revoked. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (keys === null && !error)
    return (
      <div className={styles.usageSk} aria-busy="true" aria-label="Loading your API key">
        <span className={styles.sk} />
      </div>
    );

  const key = keys?.[0];
  const curl = `curl -sS "${API_BASE_URL}/usage" \\\n  -H "x-api-key: ${created?.key ?? "$QRB_API_KEY"}"`;

  return (
    <>
      {!key && keys && (
        <div className={styles.empty}>
          <p className="body-3 soft">
            No API key yet. Create one to call the API from scripts and notebooks with this account&rsquo;s budget. An account holds one key at a time.
          </p>
          <button type="button" className="btn btn-primary button-md" onClick={() => void create()} aria-disabled={busy} disabled={busy}>
            <Key size={16} aria-hidden />
            {busy ? "Creating…" : "Create API key"}
          </button>
        </div>
      )}

      {created && (
        <div className={styles.secret} role="status">
          <p className="title-3">Copy your key now. It is shown only once.</p>
          <div className={styles.secretRow}>
            <code className={styles.secretValue}>{created.key}</code>
            <CopyButton text={created.key} name="the API key" />
          </div>
        </div>
      )}

      {key && (
        <div className={styles.keyRow}>
          <div>
            <p className="title-3">
              <code className={styles.keyStart}>{key.start ?? key.prefix ?? "qrb_"}…</code>
            </p>
            <p className="caption-2 muted">Created {fmtDate(key.createdAt)}</p>
          </div>
          {!confirming ? (
            <button type="button" className="btn btn-secondary button-sm" onClick={() => setConfirming(true)}>
              Revoke
            </button>
          ) : (
            <div className={styles.confirm}>
              <p className="body-6 soft">Revoke this key? Scripts that use it get 401 at once.</p>
              <div className={styles.confirmActions}>
                <button type="button" className={`btn btn-secondary button-sm ${styles.danger}`} onClick={() => void revoke(key.id)} aria-disabled={busy} disabled={busy}>
                  {busy ? "Revoking…" : "Revoke key"}
                </button>
                <button type="button" className="btn btn-secondary button-sm" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <Failure message={error} />}

      {key && (
        <figure className={styles.code}>
          <figcaption className="caption-2 muted">
            <span>Send the key in the x-api-key header</span>
            <CopyButton text={curl} label="Copy" name="the curl command" />
          </figcaption>
          <pre tabIndex={0}>
            <code>{highlight(curl, "shell")}</code>
          </pre>
        </figure>
      )}
    </>
  );
}

// ---------- page ----------

export function Account() {
  const account = useAccount();
  const router = useRouter();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [days, setDays] = useState<DailyUsage[] | null>(null);
  const [daysError, setDaysError] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [leaving, setLeaving] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const signedIn = account.status === "signed-in";

  useEffect(() => {
    if (account.status === "signed-out" || account.status === "unavailable") router.replace("/signin");
  }, [account.status, router]);

  const loadUsage = useCallback(() => {
    getUsage()
      .then((u) => {
        setUsage(u);
        setUsageError(null);
      })
      .catch((e: Error) => setUsageError(e.message));
    getDaily()
      .then((d) => {
        setDays(d);
        setDaysError(null);
      })
      .catch((e: Error) => setDaysError(e.message));
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    loadUsage();
    linkedProviders()
      .then(setProviders)
      .catch(() => undefined);
    // Keep the figures current while the page is open (a script may be using the key).
    const t = window.setInterval(loadUsage, 30_000);
    return () => window.clearInterval(t);
  }, [signedIn, loadUsage]);

  const leave = async () => {
    setLeaving(true);
    setSignOutError(null);
    try {
      await signOut();
      router.replace("/");
    } catch (e) {
      setSignOutError(`You are still signed in. ${(e as Error).message}`);
      setLeaving(false);
    }
  };

  if (!signedIn)
    return (
      <div className={styles.page} aria-busy="true">
        <span className={`${styles.sk} ${styles.skTitle}`} />
      </div>
    );

  const { user } = account;
  const via = providers.map((p) => PROVIDER_NAME[p] ?? p).join(" and ");

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.who}>
          <Avatar user={user} size={48} />
          <div>
            <h1 className="heading-4">{user.name}</h1>
            <p className="caption-2 muted">
              {[user.email, via && `Signed in with ${via}`].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
        <button type="button" className="btn btn-secondary button-sm" onClick={() => void leave()} aria-disabled={leaving} disabled={leaving}>
          <SignOut size={16} aria-hidden />
          {leaving ? "Signing out…" : "Sign out"}
        </button>
      </header>
      {signOutError && <Failure message={signOutError} />}

      <section className={styles.row} aria-labelledby="usage-title">
        <div className={styles.rowLabel}>
          <h2 id="usage-title" className="heading-6">
            Usage
          </h2>
          {usage && (
            <p className="caption-2 muted">
              The budget resets at {fmtTime(usage.resetAt)}, in {fmtIn(usage.secondsUntilReset)}.
            </p>
          )}
        </div>
        <div className={styles.rowBody}>
          <TodayUsage usage={usage} error={usageError} today={days?.at(-1) ?? null} />
          {daysError ? (
            <Failure message={`The last 30 days could not be loaded. ${daysError}`} />
          ) : days && usage ? (
            <UsageChart days={days} quota={usage.quota} />
          ) : (
            <div className={styles.usageSk} aria-busy="true" aria-label="Loading the last 30 days">
              <span className={`${styles.sk} ${styles.skChart}`} />
            </div>
          )}
          <Costs usage={usage} />
        </div>
      </section>

      <section className={styles.row} aria-labelledby="key-title">
        <div className={styles.rowLabel}>
          <h2 id="key-title" className="heading-6">
            API key
          </h2>
          <p className="caption-2 muted">For scripts, notebooks and CI. One key per account; it shares the budget above.</p>
        </div>
        <div className={styles.rowBody}>
          <KeyPanel onChange={loadUsage} />
        </div>
      </section>

      <Activity onChange={loadUsage} />
    </div>
  );
}
