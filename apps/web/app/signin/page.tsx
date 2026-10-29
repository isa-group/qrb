"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { useAuthUser } from "@/components/auth-session";
import { ProviderButtons } from "@/components/provider-buttons";
import { describeAuthError, safeNext } from "@/lib/auth/client";

function SignInForm() {
  const params = useSearchParams();
  const router = useRouter();
  const next = safeNext(params.get("next"));
  const { user } = useAuthUser();
  const [startError, setStartError] = useState<string | null>(null);

  const error =
    startError ?? describeAuthError(params.get("error"), params.get("error_description"));

  // Already signed in: go where the user was headed.
  useEffect(() => {
    if (user && !params.get("error")) router.replace(next);
  }, [user, next, params, router]);

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <h1 className="text-heading-sm font-medium text-ink-primary">Sign in to QRB</h1>
      <p className="mt-2 text-body text-ink-secondary">
        Sign in with GitHub or ORCID to resolve bindings, fetch the live catalog and manage API keys.
        There are no passwords; if you use both providers you can link them on your account page.
      </p>

      {error && (
        <div role="alert" className="mt-6 rounded-lg border border-violation bg-violation-dim p-3 text-body text-violation">
          {error}
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3">
        <ProviderButtons
          mode="sign-in"
          next={next}
          errorPath={`/signin?next=${encodeURIComponent(next)}`}
          onError={setStartError}
        />
      </div>

      <p className="mt-6 text-caption text-ink-tertiary">
        You will be redirected back to <span className="font-geist-mono">{next}</span> afterwards.{" "}
        <Link href="/playground" className="underline">Continue without signing in</Link>
      </p>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
