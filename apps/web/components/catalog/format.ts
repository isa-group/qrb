/** Formatting shared by the catalog list and the device page. Missing values are always a dash. */

export const DASH = "—";

export const PROVIDERS: Record<string, string> = { ibm: "IBM Quantum", braket: "Amazon Braket" };
export const providerName = (id: string) => PROVIDERS[id] ?? id;

/** An error rate as a percentage with two significant figures: 0.00018 → "0.018%", 0.041 → "4.1%". */
export function pct(e: number | null | undefined): string {
  if (e == null || !Number.isFinite(e)) return DASH;
  const p = e * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toPrecision(2)}%`;
}

/** A coherence time given in µs, in the unit that reads best: 43 µs, 1.0 ms, 100 s. */
export function coherence(us: number | null | undefined): string {
  if (us == null || !Number.isFinite(us)) return DASH;
  if (us >= 1e6) return `${(us / 1e6).toPrecision(3).replace(/\.?0+$/, "")} s`;
  if (us >= 1e3) return `${(us / 1e3).toPrecision(3).replace(/\.?0+$/, "")} ms`;
  return `${us.toPrecision(3).replace(/\.?0+$/, "")} µs`;
}

export const count = (n: number | null | undefined) => (n == null ? DASH : n.toLocaleString("en-US"));

const UTC = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export function utc(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH : `${UTC.format(d)} UTC`;
}

/** How long ago, against `now`: "35 min ago", "3 h ago", "2 d ago". */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return DASH;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return DASH;
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** One status vocabulary across providers ("active", "ONLINE" → Online). */
export const statusLabel = (operational: boolean) => (operational ? "Online" : "Not operational");

/** The data line every catalog view shows, read from the API's `source`. */
export function sourceLine(source: { mode: string; as_of: string | null; cache_hit: boolean | null }): string {
  if (source.mode === "snapshot") return `Frozen snapshot${source.as_of ? `, captured ${utc(source.as_of)}` : ""}`;
  if (source.cache_hit) return `Provider data from ${source.as_of ? utc(source.as_of) : "the last refresh"} (queues refreshed every 2 minutes)`;
  return `Provider data fetched now${source.as_of ? `, ${utc(source.as_of)}` : ""}`;
}

/** A device page's URL. Candidate ids contain dots and may contain spaces. */
export const deviceHref = (candidateId: string) => `/catalog/${encodeURIComponent(candidateId)}`;
