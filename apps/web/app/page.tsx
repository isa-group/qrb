import Link from "next/link";

import { HeroPreview } from "@/components/hero-preview";

const PROVIDER_GROUPS = [
  {
    label: "IBM Quantum",
    color: "var(--color-provider-ibm)",
    vendors: [] as string[],
  },
  {
    label: "Amazon Braket",
    color: "var(--color-provider-aws)",
    vendors: ["IonQ", "Rigetti", "IQM", "AQT"],
  },
];

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-24">
      <div className="flex max-w-3xl flex-col items-center text-center">
        <span className="font-geist-mono text-mono-caption font-medium tracking-wide text-primary">
          LIVE CATALOG · REAL SOLVING
        </span>
        <h1 className="mt-3 font-geist-sans text-heading-lg font-medium text-ink-primary sm:text-display">
          <span className="text-primary">Declarative</span> Quantum Resource
          Binding
        </h1>
        <p className="mt-6 max-w-xl text-body-lg text-ink-secondary">
          QRB exposes the live state of the quantum ecosystem as a catalog.
          Declare your circuit, your constraints, and your criteria — pick a
          preset or build your own — and let the binding engine resolve it,
          in MONO or Pareto mode. No leaderboard, no claim about which
          backend is &ldquo;best&rdquo;, just what&rsquo;s available right
          now and what satisfies your task.
        </p>

        <div className="mt-8 flex items-center gap-3">
          <Link
            href="/playground"
            className="rounded-sm bg-primary px-4 py-2 text-body font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Open Playground
          </Link>
          <Link
            href="/catalog"
            className="rounded-sm border border-hairline px-4 py-2 text-body font-medium text-ink-primary transition-colors hover:border-hairline-bright"
          >
            Browse Catalog
          </Link>
        </div>
      </div>

      <div className="mt-16 w-full max-w-(--page-max-width) overflow-hidden rounded-lg border border-hairline bg-instrument">
        <HeroPreview />
      </div>

      <div className="mt-16 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
        {PROVIDER_GROUPS.map((group, i) => (
          <div key={group.label} className="flex items-center gap-3">
            {i > 0 && (
              <span
                aria-hidden
                className="h-4 w-px bg-hairline hidden sm:inline-block"
              />
            )}
            <span
              className="font-geist-mono text-mono-caption font-medium"
              style={{ color: group.color }}
            >
              {group.label}
            </span>
            {group.vendors.length > 0 && (
              <span className="font-geist-mono text-mono-caption text-ink-tertiary">
                {group.vendors.join(" · ")}
              </span>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
