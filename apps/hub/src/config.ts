import path from "node:path";
import { parseTrustProxy, type TrustProxy } from "./net.js";

export interface HubConfig {
  port: number;
  host: string;
  dataDir: string;
  stunUrls: string[];
  turnUrls: string[];
  /** Shared secret with coturn (`static-auth-secret`). TURN creds are only issued if set. */
  turnSecret: string | null;
  turnTtlSeconds: number;
  /** Proxies trusted for X-Forwarded-For: hop count or IP/CIDR list, never "all" (security H3). */
  trustProxy: TrustProxy;
  logLevel: string;
  /** Tunables, overridable mostly for tests. */
  authTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  wsMaxPayload: number;
  /** WebSocket caps (security H4); they count unauthenticated sockets too. */
  wsMaxConnections: number;
  wsMaxConnectionsPerIp: number;
  /** Sockets that have not authenticated yet (bounded separately; they cost nothing to open). */
  wsMaxPending: number;
  /** Session replacement (same account connecting again) per user (security H2). */
  sessionReplaceMax: number;
  sessionReplaceWindowMs: number;
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}

/** Default TURN credential lifetime: 4 h (refreshed at 80% over the WS). */
export const DEFAULT_TURN_TTL_SECONDS = 4 * 3600;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  return {
    port: int(env.PORT, 8420, "PORT"),
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    stunUrls: list(env.STUN_URLS, ["stun:stun.l.google.com:19302"]),
    turnUrls: list(env.TURN_URLS, []),
    turnSecret: env.TURN_SECRET ? env.TURN_SECRET : null,
    turnTtlSeconds: int(env.TURN_TTL_SECONDS, DEFAULT_TURN_TTL_SECONDS, "TURN_TTL_SECONDS") || DEFAULT_TURN_TTL_SECONDS,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL || "info",
    authTimeoutMs: 10_000,
    heartbeatIntervalMs: 25_000,
    heartbeatTimeoutMs: 60_000,
    wsMaxPayload: 64 * 1024,
    wsMaxConnections: int(env.WS_MAX_CONNECTIONS, 1000, "WS_MAX_CONNECTIONS"),
    wsMaxConnectionsPerIp: int(env.WS_MAX_CONNECTIONS_PER_IP, 20, "WS_MAX_CONNECTIONS_PER_IP"),
    wsMaxPending: int(env.WS_MAX_PENDING, 100, "WS_MAX_PENDING"),
    sessionReplaceMax: 5,
    sessionReplaceWindowMs: 10 * 60_000,
  };
}

const WEAK_TURN_SECRETS = new Set(["change-me", "changeme", "secret", "s3cret", "password"]);
export const MIN_TURN_SECRET_LENGTH = 32;

/** Refuses to run with a guessable coturn secret when TURN is configured (security T3). */
export function assertSafeConfig(config: HubConfig): void {
  if (config.turnUrls.length === 0 || !config.turnSecret) return;
  const s = config.turnSecret;
  if (WEAK_TURN_SECRETS.has(s.toLowerCase()) || s.length < MIN_TURN_SECRET_LENGTH) {
    throw new Error(
      `TURN_SECRET is weak or a placeholder (need at least ${MIN_TURN_SECRET_LENGTH} random characters). ` +
        "Generate one with: openssl rand -hex 32",
    );
  }
}
