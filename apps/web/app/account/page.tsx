"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";

import { useAuthUser } from "@/components/auth-session";
import { ApiKeysSection } from "@/components/api-keys-section";
import { useNow } from "@/components/quota-status";
import { formatDuration } from "@/lib/api/errors";
import { fetchUsage } from "@/lib/api/quota";
import { ProviderButtons } from "@/components/provider-buttons";
import { Button } from "@/components/ui/button";
import { authClient, describeAuthError, PROVIDERS, type Provider } from "@/lib/auth/client";

interface LinkedAccount {
  id: string;
  providerId: string;
}

function UsageSection({ userId }: { userId: string }) {
  const now = useNow();
  const usage = useQuery({
    queryKey: ["usage", userId],
    queryFn: fetchUsage,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const data = usage.data;
  const seconds = data ? (Date.parse(data.resetAt) - now) / 1000 : 0;
  return (
    <section aria-labelledby="quota-h" className="flex flex-col gap-2">
      <h2 id="quota-h" className="text-subheading font-medium text-ink-primary">Usage and quota</h2>
      {usage.isPending ? (
        <p className="text-body text-ink-tertiary">Loading…</p>
      ) : usage.isError ? (
        <p className="text-body text-ink-tertiary">Could not load your usage. Please reload the page.</p>
      ) : !data ? (
        <p className="text-body text-ink-tertiary">No usage recorded yet.</p>
      ) : (
        <div className="rounded-lg border border-hairline p-4 text-body text-ink-secondary" data-testid="usage">
          <p>
            <span className="font-medium text-ink-primary">{data.remaining}</span> of {data.quota} resolves left today
            {" "}({data.used} used) · {data.tier === "signed_in" ? "signed-in" : "anonymous"} tier
          </p>
          <p className="mt-1 text-caption text-ink-tertiary">
            Resets {seconds > 0 ? `in ${formatDuration(seconds)} ` : ""}at{" "}
            {new Date(data.resetAt).toUTCString().replace("GMT", "UTC")}.
          </p>
        </div>
      )}
    </section>
  );
}

function AccountView() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, isPending } = useAuthUser();
  const [error, setError] = useState<string | null>(
    describeAuthError(params.get("error"), params.get("error_description")),
  );
  const [busy, setBusy] = useState(false);

  const accountsQuery = useQuery({
    queryKey: ["auth", "accounts", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await authClient.listAccounts();
      if (res.error) throw new Error(res.error.message);
      return res.data as LinkedAccount[];
    },
  });
  const accounts = accountsQuery.data;
  const refresh = accountsQuery.refetch;
  const loadError = accountsQuery.isError ? "Could not load your linked accounts. Please reload the page." : null;

  const linked = (accounts ?? []).filter((a) => a.providerId === "github" || a.providerId === "orcid");
  const onlyOne = linked.length <= 1;

  const unlink = async (account: LinkedAccount) => {
    setBusy(true);
    setError(null);
    const res = await authClient.unlinkAccount({ accountId: account.id });
    if (res.error) setError(res.error.message || "Could not unlink that account.");
    await refresh();
    setBusy(false);
  };

  const signOut = async () => {
    setBusy(true);
    await authClient.signOut();
    router.replace("/");
  };

  if (isPending) {
    return <main className="mx-auto w-full max-w-2xl px-6 py-16 text-body text-ink-secondary">Loading…</main>;
  }

  if (!user) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-16">
        <h1 className="text-heading-sm font-medium text-ink-primary">Account</h1>
        <p className="mt-2 text-body text-ink-secondary">
          You are not signed in. <Link href="/signin?next=/account" className="text-primary underline">Sign in</Link> to manage your account.
        </p>
      </main>
    );
  }

  const missing = PROVIDERS.filter((p) => !linked.some((a) => a.providerId === p.id)).map((p) => p.id as Provider);

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12 flex flex-col gap-10">
      <header>
        <h1 className="text-heading-sm font-medium text-ink-primary">Account</h1>
        <p className="mt-1 text-body text-ink-secondary">
          {user.name || "Signed in"}
          {user.email && !user.email.endsWith(".invalid") ? ` · ${user.email}` : ""}
        </p>
      </header>

      {(error ?? loadError) && (
        <div role="alert" className="rounded-lg border border-violation bg-violation-dim p-3 text-body text-violation">
          {error ?? loadError}
        </div>
      )}

      <section aria-labelledby="providers-h" className="flex flex-col gap-3">
        <h2 id="providers-h" className="text-subheading font-medium text-ink-primary">Sign-in methods</h2>
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {PROVIDERS.map((p) => {
            const account = linked.find((a) => a.providerId === p.id);
            return (
              <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-body font-medium text-ink-primary">{p.label}</p>
                  <p className="text-caption text-ink-tertiary">{account ? "Linked" : "Not linked"}</p>
                </div>
                {account ? (
                  <div className="flex flex-col items-end gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || onlyOne}
                      onClick={() => unlink(account)}
                    >
                      Unlink
                    </Button>
                    {onlyOne && (
                      <p className="max-w-56 text-right text-caption text-ink-tertiary">
                        This is your only sign-in method. Link another provider before unlinking it.
                      </p>
                    )}
                  </div>
                ) : (
                  <ProviderButtons
                    mode="link"
                    only={[p.id]}
                    next="/account"
                    errorPath="/account"
                    onError={setError}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {missing.length === 0 && (
          <p className="text-caption text-ink-tertiary">Both providers are linked; either signs you into this account.</p>
        )}
      </section>

      <ApiKeysSection userId={user.id} />

      <UsageSection userId={user.id} />

      <div>
        <Button type="button" variant="outline" disabled={busy} onClick={signOut}>
          Sign out
        </Button>
      </div>
    </main>
  );
}

export default function AccountPage() {
  return (
    <Suspense>
      <AccountView />
    </Suspense>
  );
}
