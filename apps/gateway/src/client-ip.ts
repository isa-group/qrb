/**
 * Client IP resolution (task 4.3). The per-IP anonymous cap, the open-route
 * per-IP rate limit and Better Auth's own auth-route limiter all key on the
 * value computed here, once per request.
 *
 * Rule (design "Single VPS, single origin"):
 * - The peer is the socket's remote address (Bun `server.requestIP`).
 * - If the peer is NOT in `TRUSTED_PROXIES`, it is the client; any
 *   `X-Forwarded-For` is ignored (it is spoofable by the client).
 * - If the peer IS a trusted proxy, walk `X-Forwarded-For` from the right and
 *   take the first entry that is not itself a trusted proxy (multi-hop: each
 *   trusted hop appended the address it saw). Entries left of that are
 *   client-supplied and never read. If the walk hits an entry that is not an
 *   IP address (malformed header), it stops and uses the nearest hop verified
 *   so far, the closest address we can still vouch for. If every entry is
 *   trusted (or there is no header), the left-most trusted address is used.
 * - No socket address (in-process `app.request`, a Unix socket): the peer is
 *   unknown and untrusted, and all such requests share the `UNKNOWN_CLIENT`
 *   bucket (fail closed). Production listens on TCP, so this does not occur.
 *
 * `TRUSTED_PROXIES`: comma-separated IPs or CIDR ranges (IPv4 and IPv6),
 * matched with `node:net`'s `BlockList`; default `127.0.0.1, ::1`. Invalid
 * entries fail at startup. IPv4-mapped IPv6 peers (`::ffff:127.0.0.1`, what a
 * dual-stack socket reports) match their IPv4 entries.
 *
 * Normalisation (`clientKey`): IPv4 as is; IPv4-mapped IPv6 becomes IPv4;
 * other IPv6 addresses are bucketed by their /64 prefix (one subscriber
 * usually holds a whole /64, so per-address limits would be trivial to rotate
 * around) and written in Better Auth's form, fully expanded with the host
 * bits zeroed (`2001:0db8:0000:0001:0000:0000:0000:0000`). That string is a
 * valid IPv6 address that Better Auth's own normaliser (/64 by default) maps
 * to itself, so both limiters see the same key.
 *
 * Better Auth: the gateway sets `CLIENT_IP_HEADER` on the request (after
 * deleting any client-sent copy) and Better Auth reads only that header
 * (`advanced.ipAddress.ipAddressHeaders`), never `X-Forwarded-For`.
 */
import { BlockList, isIP } from "node:net";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { GatewayEnv } from "./forward";

/** Internal header carrying the resolved client IP to Better Auth. Client-sent copies are stripped. */
export const CLIENT_IP_HEADER = "x-qrb-client-ip";
/** Bucket key when the socket address is not available. */
export const UNKNOWN_CLIENT = "unknown";
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = Object.freeze(["127.0.0.1", "::1"]);

/** Returns the socket remote address of the request, if known. */
export type ClientAddress = (c: Context<GatewayEnv>) => string | undefined;

type Family = "ipv4" | "ipv6";
interface ParsedIp {
  address: string;
  family: Family;
}

/** Eight 16-bit groups of an IPv6 address (`isIP` already validated it), or null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  const tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    // Embedded IPv4 tail, e.g. ::ffff:192.0.2.1
    const o = last.split(".").map(Number);
    tail.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
    s = s.slice(0, lastColon) + (s[lastColon - 1] === ":" ? ":" : "");
  }
  const halves = s.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").filter((g) => g !== "").map((g) => parseInt(g, 16)) : []);
  const left = parse(halves[0]);
  const right = [...parse(halves[1]), ...tail];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1) return missing === 0 ? [...left, ...right] : null;
  if (missing < 0) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/** Strips `[...]`, a `:port` after IPv4 or `[v6]`, and an IPv6 zone. */
function stripDecorations(raw: string): string {
  let s = raw.trim();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracket) s = bracket[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  return s;
}

/** Parses an address; IPv4-mapped IPv6 becomes IPv4. Null if not an IP address. */
export function parseIp(raw: string | undefined | null): ParsedIp | null {
  if (!raw) return null;
  const s = stripDecorations(raw);
  const v = isIP(s);
  if (v === 4) return { address: s, family: "ipv4" };
  if (v !== 6) return null;
  const g = ipv6Groups(s);
  if (!g) return null;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return { address: `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`, family: "ipv4" };
  }
  return { address: g.map((x) => x.toString(16).padStart(4, "0")).join(":"), family: "ipv6" };
}

/** Bucket key of an address: IPv4 as is, IPv6 by /64 (see module doc). */
function bucketOf(ip: ParsedIp): string {
  if (ip.family === "ipv4") return ip.address;
  return ip.address.split(":").slice(0, 4).concat(["0000", "0000", "0000", "0000"]).join(":");
}

/** `clientKey("2001:db8::1")` -> `2001:0db8:0000:0000:0000:0000:0000:0000`; null if not an IP. */
export function clientKey(raw: string): string | null {
  const ip = parseIp(raw);
  return ip ? bucketOf(ip) : null;
}

/** Set of trusted proxy addresses and ranges. */
export class TrustedProxies {
  private readonly list = new BlockList();
  readonly entries: readonly string[];

  constructor(entries: readonly string[]) {
    this.entries = Object.freeze([...entries]);
    for (const entry of entries) {
      const slash = entry.lastIndexOf("/");
      const ip = parseIp(slash === -1 ? entry : entry.slice(0, slash));
      const prefix = slash === -1 ? undefined : entry.slice(slash + 1);
      const max = ip?.family === "ipv4" ? 32 : 128;
      // A range written as mapped IPv6 (::ffff:10.0.0.0/104) is refused: write IPv4 ranges in IPv4 form.
      const mappedRange = ip?.family === "ipv4" && prefix !== undefined && entry.includes(":");
      if (!ip || mappedRange || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > max))) {
        throw new Error(`TRUSTED_PROXIES: not an IP address or CIDR range: ${entry}`);
      }
      if (prefix === undefined) this.list.addAddress(ip.address, ip.family);
      else this.list.addSubnet(ip.address, Number(prefix), ip.family);
    }
  }

  has(ip: ParsedIp): boolean {
    return this.list.check(ip.address, ip.family);
  }
}

/** `TRUSTED_PROXIES` from the environment; empty or unset means the default. Validated (throws). */
export function trustedProxiesFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.TRUSTED_PROXIES?.trim();
  const entries = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_TRUSTED_PROXIES];
  new TrustedProxies(entries);
  return entries;
}

/**
 * The client's bucket key from the socket address and `X-Forwarded-For`
 * (see module doc). `UNKNOWN_CLIENT` when the socket address is unknown.
 */
export function resolveClientIp(socketAddress: string | undefined, forwardedFor: string | null | undefined, trusted: TrustedProxies): string {
  const peer = parseIp(socketAddress);
  if (!peer) return UNKNOWN_CLIENT;
  if (!trusted.has(peer)) return bucketOf(peer);
  let nearest = peer;
  const hops = (forwardedFor ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = parseIp(hops[i]);
    if (!hop) break;
    if (!trusted.has(hop)) return bucketOf(hop);
    nearest = hop;
  }
  return bucketOf(nearest);
}

/** Socket remote address from Bun's server (the `env` Hono gets from `Bun.serve`). */
export const bunClientAddress: ClientAddress = (c) => {
  const env = c.env as { requestIP?: unknown; server?: { requestIP?: unknown } } | undefined;
  const server = (env?.server ?? env) as { requestIP?: (r: Request) => { address?: string } | null } | undefined;
  if (typeof server?.requestIP !== "function") return undefined;
  return server.requestIP(c.req.raw)?.address ?? undefined;
};

export interface ClientIpOptions {
  trustedProxies: readonly string[];
  /** Socket address source; defaults to Bun's `server.requestIP`. Injectable for tests. */
  clientAddress?: ClientAddress;
}

/**
 * Middleware: resolves the client IP once, sets `clientIp`, and replaces any
 * client-sent `CLIENT_IP_HEADER` with the resolved value (removed when the
 * client is unknown) so Better Auth sees the same address. Mount first.
 */
export function clientIp(opts: ClientIpOptions): MiddlewareHandler<GatewayEnv> {
  const trusted = new TrustedProxies(opts.trustedProxies);
  const address = opts.clientAddress ?? bunClientAddress;
  return async (c: Context<GatewayEnv>, next: Next) => {
    const ip = resolveClientIp(address(c), c.req.header("x-forwarded-for"), trusted);
    c.set("clientIp", ip);
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    if (ip !== UNKNOWN_CLIENT) headers.set(CLIENT_IP_HEADER, ip);
    // Rebuild rather than mutate: a server request's headers may be immutable.
    // Nothing has read the body yet (this runs first), so it is passed through.
    const raw = c.req.raw;
    c.req.raw = new Request(raw, { headers });
    await next();
  };
}
