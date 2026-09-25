import { AuthResponseSchema, ErrorResponseSchema, type AuthResponse } from "@shpihcord/protocol";

import {
  needsCleartextConsent,
  normalizeServerUrl as normalize,
  serverOrigin,
  ServerUrlError,
} from "../../../shared/serverUrl";

export const DEFAULT_SERVER_URL = "http://localhost:8420";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Accepts "host:port", "https://host/", etc. (see shared/serverUrl.ts). Bare public hosts get https://. */
export function normalizeServerUrl(input: string): string {
  try {
    return normalize(input);
  } catch (err) {
    throw new ApiError("invalid_url", err instanceof ServerUrlError ? err.message : String(err));
  }
}

// --- cleartext consent (security T1) ------------------------------------------

const CLEARTEXT_OK_KEY = "shpihcord.cleartextAllowed";

function loadCleartextAllowed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLEARTEXT_OK_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remember that the user accepted an unencrypted connection to this server. */
export function allowCleartext(serverUrl: string): void {
  const origin = serverOrigin(serverUrl);
  const list = loadCleartextAllowed();
  if (list.includes(origin)) return;
  try {
    localStorage.setItem(CLEARTEXT_OK_KEY, JSON.stringify([...list, origin].slice(-50)));
  } catch {
    /* ignore */
  }
}

/**
 * True if we may talk to this server: https, a local/LAN/Tailscale host, or an
 * http server the user explicitly accepted before.
 */
export function isConnectionAllowed(serverUrl: string): boolean {
  return !needsCleartextConsent(serverUrl) || loadCleartextAllowed().includes(serverOrigin(serverUrl));
}

export const CLEARTEXT_WARNING =
  "This server is not encrypted — your password will be sent in plain text.";

function assertAllowed(serverUrl: string): void {
  if (!isConnectionAllowed(serverUrl)) throw new ApiError("insecure_url", CLEARTEXT_WARNING);
}

export function toWsUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function request(serverUrl: string, path: string, body: unknown, token?: string): Promise<unknown> {
  assertAllowed(serverUrl);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError("unreachable", `Couldn't reach ${serverUrl}. Check the address and that the server is running.`);
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = ErrorResponseSchema.safeParse(json);
    if (err.success) throw new ApiError(err.data.error, err.data.message);
    throw new ApiError(`http_${res.status}`, `Server returned ${res.status} ${res.statusText}`.trim());
  }
  return json;
}

async function post(serverUrl: string, path: string, body: unknown): Promise<AuthResponse> {
  const parsed = AuthResponseSchema.safeParse(await request(serverUrl, path, body));
  if (!parsed.success) throw new ApiError("bad_response", "The server sent an unexpected response. Is this a Shpihcord hub?");
  return parsed.data;
}

export function login(serverUrl: string, username: string, password: string): Promise<AuthResponse> {
  return post(serverUrl, "/api/login", { username, password });
}

export function register(serverUrl: string, username: string, password: string, inviteCode: string): Promise<AuthResponse> {
  return post(serverUrl, "/api/register", { username, password, inviteCode });
}

// --- session management (security H1) ------------------------------------------

/** Revoke this device's token on the hub. Best effort: callers still clear local state. */
export async function logoutRemote(serverUrl: string, token: string): Promise<void> {
  await request(serverUrl, "/api/logout", {}, token);
}

/** Revoke every token of this account (all devices, including this one). */
export async function revokeAllSessions(serverUrl: string, token: string): Promise<void> {
  await request(serverUrl, "/api/sessions/revoke-all", {}, token);
}

/**
 * Change the password. The hub revokes the other sessions; if it hands back a
 * fresh token for this device it is returned so the caller can keep going.
 */
export async function changePassword(
  serverUrl: string,
  token: string,
  currentPassword: string,
  newPassword: string,
): Promise<AuthResponse | null> {
  const json = await request(serverUrl, "/api/password", { currentPassword, newPassword }, token);
  const parsed = AuthResponseSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
