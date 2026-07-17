import { cn } from "@/lib/utils";

// §10, §9: a 6px filled circle; pulses only while telemetry is fresh, and the
// live-pulse glow (§8) is the one ambient glow permitted anywhere in the system.
export function StatusDot({ live = true }: { live?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "size-1.5 rounded-full",
          live ? "bg-eligible animate-pulse" : "bg-violation"
        )}
        style={live ? { boxShadow: "var(--shadow-live-pulse)" } : undefined}
        aria-hidden
      />
      <span className="text-caption text-ink-tertiary">
        {live ? "live" : "offline"}
      </span>
    </span>
  );
}
