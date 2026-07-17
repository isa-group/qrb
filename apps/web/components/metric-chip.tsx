// §10: a measurement, never a verdict — values never change color to
// indicate quality.
export function MetricChip({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xs bg-deep-well px-2 py-1.5">
      <div className="text-caption text-ink-tertiary">{label}</div>
      <div className="font-geist-mono text-mono-body text-ink-primary">
        {value}
      </div>
    </div>
  );
}
