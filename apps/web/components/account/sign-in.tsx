"use client";

import { ArrowRight, GithubLogo, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { useEffect, useState } from "react";

import { getUsage, signIn, useAccount, type Provider } from "@/lib/auth";

import styles from "./account.module.css";

/** Better Auth's error codes (`?error=`) in plain words. */
function errorText(code: string): string {
  if (code === "access_denied") return "Sign-in was cancelled. Nothing was shared with QRB.";
  if (code === "account_not_linked") return "That account could not be linked. Sign in with the provider you used first.";
  return `Sign-in did not complete (${code.replace(/_/g, " ")}). Try again.`;
}

/** ORCID's iD mark: a green disc with "iD". */
function OrcidMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="8" fill="#a6ce39" />
      <text x="8" y="11.2" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">
        iD
      </text>
    </svg>
  );
}

const PROVIDERS: { id: Provider; label: string; icon: React.ReactNode; shares: string }[] = [
  { id: "github", label: "Continue with GitHub", icon: <GithubLogo size={16} weight="fill" aria-hidden />, shares: "your public profile and email address" },
  { id: "orcid", label: "Continue with ORCID", icon: <OrcidMark />, shares: "your ORCID iD and name" },
];

export function SignIn() {
  const account = useAccount();
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anonQuota, setAnonQuota] = useState<number | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(errorText(code));
  }, []);

  useEffect(() => {
    if (account.status !== "signed-out") return;
    getUsage()
      .then((u) => setAnonQuota(u.tier === "anonymous" ? u.quota : null))
      .catch(() => undefined);
  }, [account.status]);

  const start = async (provider: Provider) => {
    setBusy(provider);
    setError(null);
    try {
      await signIn(provider);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className={styles.narrow}>
      <h1 className="heading-3">Sign in</h1>
      <p className={`${styles.lead} title-2 soft`}>
        An account gives you an API key with a daily budget of its own. Binding and browsing the catalog work without one.
      </p>

      {account.status === "loading" && (
        <div className={styles.providers} aria-busy="true" aria-label="Loading">
          <span className={styles.sk} />
          <span className={styles.sk} />
        </div>
      )}

      {account.status === "unavailable" && (
        <p className={`${styles.notice} body-6`} role="status">
          Accounts are not available on this server: it serves the API without the QRB gateway. Everything else works as usual.
        </p>
      )}

      {account.status === "signed-in" && (
        <div className={styles.providers}>
          <p className="body-3 soft">You are signed in as {account.user.name}.</p>
          <Link href="/account" className="link body-5">
            Go to your account <ArrowRight size={16} aria-hidden />
          </Link>
        </div>
      )}

      {account.status === "signed-out" && (
        <>
          <div className={styles.providers}>
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`btn btn-secondary button-md ${styles.provider}`}
                onClick={() => void start(p.id)}
                aria-disabled={busy !== null}
                disabled={busy !== null && busy !== p.id}
              >
                {p.icon}
                {busy === p.id ? "Opening…" : p.label}
              </button>
            ))}
          </div>
          {error && (
            <p className={`${styles.error} caption-2`} role="alert">
              <WarningCircle size={16} aria-hidden /> {error}
            </p>
          )}
          <ul className={`${styles.facts} body-6 soft`}>
            <li>QRB receives {PROVIDERS[0].shares} from GitHub, or {PROVIDERS[1].shares} from ORCID, and uses them only to identify your account.</li>
            <li>
              Without an account, this site and calls without a key share{" "}
              {anonQuota !== null ? `${anonQuota} units` : "a budget"} a day per IP address.
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
