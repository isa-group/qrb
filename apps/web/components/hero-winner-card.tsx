import Link from "next/link";

import { ProviderBadge } from "@/components/provider-badge";

const MOCK_FEATURES: Array<[string, string]> = [
  ["expected_fidelity", "0.994"],
  ["cost", "$0.4200"],
  ["queue", "3 pending"],
];

// Static mirror of BindingResultPanel's real winner card — same resolved
// task the HeroTerminal "ran", illustrated rather than live-resolved.
export function HeroWinnerCard({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-lg border border-primary p-4 ${className}`}
      style={{ background: "var(--color-primary-dim)" }}
    >
      <div className="flex items-center gap-2">
        <h3 className="font-geist-sans text-heading-sm font-medium text-ink-primary">
          ibm_kyoto
        </h3>
        <ProviderBadge providerId="ibm" />
      </div>

      <ul className="mt-3 flex flex-col gap-1.5">
        {MOCK_FEATURES.map(([key, value]) => (
          <li
            key={key}
            className="flex items-center justify-between text-body text-ink-primary"
          >
            <span className="text-ink-secondary">{key}</span>
            <span className="font-geist-mono text-mono-body">{value}</span>
          </li>
        ))}
      </ul>

      <Link
        href="/playground"
        className="mt-4 inline-block text-body font-medium text-primary hover:underline"
      >
        Try it yourself →
      </Link>
    </div>
  );
}
