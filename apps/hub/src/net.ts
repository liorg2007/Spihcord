import net from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * Which reverse proxies we trust to set X-Forwarded-For (security H3).
 * - `false`: none, the socket address is the client.
 * - a number: that many proxy hops in front of the hub (Caddy = 1).
 * - a list: only these proxy IPs / CIDRs.
 * `true` (trust everything, i.e. let any client pick its own IP) is not representable on purpose.
 */
export type TrustProxy = false | number | string[];

/** Parses TRUST_PROXY. Throws on `true`/`yes`/`on` and on malformed entries. */
export function parseTrustProxy(value: string | undefined): TrustProxy {
  const v = (value ?? "").trim();
  if (v === "" || /^(0|false|no|off)$/i.test(v)) return false;
  if (/^(true|yes|on)$/i.test(v)) {
    throw new Error(
      "TRUST_PROXY=true is not allowed: it lets any client spoof its IP via X-Forwarded-For. " +
        "Set the number of proxy hops (e.g. TRUST_PROXY=1 behind Caddy) or the proxy IPs/CIDRs.",
    );
  }
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n > 10) throw new Error(`Invalid TRUST_PROXY hop count: ${v}`);
    return n === 0 ? false : n;
  }
  const entries = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of entries) {
    const [addr, bits, ...rest] = e.split("/");
    const family = net.isIP(addr);
    const maxBits = family === 6 ? 128 : 32;
    if (!family || rest.length || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= maxBits))) {
      throw new Error(`Invalid TRUST_PROXY entry: ${e} (expected a hop count or IP/CIDR list)`);
    }
  }
  return entries;
}

function normalize(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1] : addr;
}

/** A proxy-addr style trust function `(addr, hopIndex) => trusted`, also handed to Fastify. */
export function trustFunction(trust: TrustProxy): (addr: string, hop: number) => boolean {
  if (trust === false) return () => false;
  if (typeof trust === "number") return (_addr, hop) => hop < trust;
  const list = new net.BlockList();
  for (const e of trust) {
    const [addr, bits] = e.split("/");
    const type = net.isIP(addr) === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, Number(bits), type);
  }
  return (addr) => {
    const a = normalize(addr);
    const family = net.isIP(a);
    if (!family) return false;
    return list.check(a, family === 6 ? "ipv6" : "ipv4");
  };
}

/** Client address for a raw request (the WS upgrade), with the same semantics Fastify uses for req.ip. */
export function clientIp(req: IncomingMessage, trust: (addr: string, hop: number) => boolean): string {
  const remote = normalize(req.socket.remoteAddress ?? "unknown");
  const header = req.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : header ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
  const addrs = [remote, ...forwarded];
  for (let i = 0; i < addrs.length - 1; i++) {
    if (!trust(addrs[i], i)) return normalize(addrs[i]);
  }
  return normalize(addrs[addrs.length - 1]);
}
