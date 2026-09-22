import path from "node:path";

export interface HubConfig {
  port: number;
  host: string;
  dataDir: string;
  stunUrls: string[];
  turnUrls: string[];
  /** Shared secret with coturn (`static-auth-secret`). TURN creds are only issued if set. */
  turnSecret: string | null;
  turnTtlSeconds: number;
  /** Trust X-Forwarded-* headers (set when running behind Caddy). */
  trustProxy: boolean;
  logLevel: string;
  /** Tunables, overridable mostly for tests. */
  authTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  wsMaxPayload: number;
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

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  return {
    port: int(env.PORT, 8420, "PORT"),
    host: env.HOST || "0.0.0.0",
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    stunUrls: list(env.STUN_URLS, ["stun:stun.l.google.com:19302"]),
    turnUrls: list(env.TURN_URLS, []),
    turnSecret: env.TURN_SECRET ? env.TURN_SECRET : null,
    turnTtlSeconds: int(env.TURN_TTL_SECONDS, 43200, "TURN_TTL_SECONDS") || 43200,
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL || "info",
    authTimeoutMs: 10_000,
    heartbeatIntervalMs: 25_000,
    heartbeatTimeoutMs: 60_000,
    wsMaxPayload: 64 * 1024,
  };
}
