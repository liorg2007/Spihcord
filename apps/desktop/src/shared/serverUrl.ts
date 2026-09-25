/**
 * Server-address policy (security T1): which hosts may be reached over
 * cleartext http:// / ws://.
 *
 * Cleartext carries the password (login/register), the bearer token and all
 * signaling (SDP fingerprints, ICE candidates), so it is only allowed without
 * asking for hosts that can't be on the public internet:
 *   loopback (localhost, 127/8, ::1), RFC 1918 (10/8, 172.16/12, 192.168/16),
 *   link-local (169.254/16, fe80::/10), IPv6 ULA (fc00::/7), *.local (mDNS),
 *   and Tailscale (100.64/10 CGNAT, *.ts.net; its WireGuard tunnel encrypts).
 * Anything else needs https, or an explicit, remembered user confirmation.
 *
 * Pure (no DOM / Electron imports) so it is unit-tested in isolation.
 */

export type HostClass = "loopback" | "private" | "public";

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function classifyIPv4([a, b]: number[]): HostClass {
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b! >= 16 && b! <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "private"; // link-local
  if (a === 100 && b! >= 64 && b! <= 127) return "private"; // 100.64/10: Tailscale / CGNAT
  return "public";
}

/** Expand an IPv6 literal (no brackets, no zone) to 8 16-bit groups, or null. */
function parseIPv6(host: string): number[] | null {
  let h = host.toLowerCase();
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(h) || !h.includes(":")) return null;
  // Embedded IPv4 tail (::ffff:10.0.0.1).
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (tail) {
    const v4 = parseIPv4(tail[1]!);
    if (!v4) return null;
    h = h.slice(0, -tail[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ":" + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((n) => !Number.isNaN(n)) ? out : null;
}

function classifyIPv6(g: number[]): HostClass {
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback"; // ::1
  // IPv4-mapped ::ffff:a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return classifyIPv4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  }
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA (incl. Tailscale fd7a:115c:a1e0::/48)
  if ((g[0]! & 0xffc0) === 0xfe80) return "private"; // fe80::/10 link-local
  return "public";
}

/** Classify a URL hostname (as returned by `new URL().hostname`, IPv6 may be bracketed). */
export function classifyHost(hostname: string): HostClass {
  let h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h) return "public";
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  const v4 = parseIPv4(h);
  if (v4) return classifyIPv4(v4);
  const v6 = parseIPv6(h);
  if (v6) return classifyIPv6(v6);
  if (h.endsWith(".local")) return "private"; // mDNS: resolves on the LAN only
  if (h.endsWith(".ts.net")) return "private"; // Tailscale MagicDNS: WireGuard-encrypted
  return "public";
}

/** True when cleartext to this host is acceptable without asking the user. */
export function isTrustedCleartextHost(hostname: string): boolean {
  return classifyHost(hostname) !== "public";
}

export class ServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerUrlError";
  }
}

/**
 * Accepts "host:port", "https://host/", "wss://host", etc. and returns
 * "scheme://host[:port][/path]" without a trailing slash, using http(s).
 * A bare host gets https://, except loopback/LAN/Tailscale hosts (a local hub
 * rarely has a certificate), which get http://.
 */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new ServerUrlError("Enter a server address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let host = "";
    try {
      host = new URL(`http://${s}`).hostname;
    } catch {
      throw new ServerUrlError("That server address doesn't look right.");
    }
    s = `${isTrustedCleartextHost(host) ? "http" : "https"}://${s}`;
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ServerUrlError("That server address doesn't look right.");
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ServerUrlError("Server address must start with https:// (or http:// for a local server).");
  }
  if (url.username || url.password) throw new ServerUrlError("Server address can't contain a username or password.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** "https://host" -> the origin used as the key for a remembered cleartext confirmation. */
export function serverOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}

/**
 * True if talking to `serverUrl` would send credentials in plain text to a host
 * that isn't local/LAN/Tailscale, i.e. the user must confirm first.
 */
export function needsCleartextConsent(serverUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return true;
  }
  if (url.protocol === "https:" || url.protocol === "wss:") return false;
  return !isTrustedCleartextHost(url.hostname);
}
