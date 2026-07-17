// §10, §4: monochrome by default. Only IBM Quantum and Amazon Braket resolve
// to their brand hue, and only in the glyph itself — never a badge fill/border.
const PROVIDER_LABELS: Record<string, string> = {
  ibm: "IBM",
  braket: "Braket",
};

const PROVIDER_COLORS: Record<string, string> = {
  ibm: "var(--color-provider-ibm)",
  braket: "var(--color-provider-aws)",
};

export function ProviderBadge({
  providerId,
  vendor,
}: {
  providerId: string;
  // QPU manufacturer, e.g. "IonQ"/"Rigetti"/"IQM" — only meaningful for
  // Braket, which fronts multiple hardware vendors behind one provider
  // badge (IBM's badge already names the manufacturer, since it's IBM's
  // own hardware).
  vendor?: string;
}) {
  const label = PROVIDER_LABELS[providerId] ?? providerId;
  const color = PROVIDER_COLORS[providerId];

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="font-geist-mono text-mono-caption font-medium"
        style={{ color: color ?? "var(--color-ink-secondary)" }}
      >
        {label}
      </span>
      {vendor && (
        <span className="text-mono-caption text-ink-tertiary">{vendor}</span>
      )}
    </span>
  );
}
