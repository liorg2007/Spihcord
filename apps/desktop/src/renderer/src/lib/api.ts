import { AuthResponseSchema, ErrorResponseSchema, type AuthResponse } from "@shpihcord/protocol";

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

/** Accepts "host:port", "https://host/", etc. and returns "scheme://host[:port][/path]" without trailing slash. */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new ApiError("invalid_url", "Enter a server address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ApiError("invalid_url", "That server address doesn't look right.");
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError("invalid_url", "Server address must start with http:// or https://");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function toWsUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function post(serverUrl: string, path: string, body: unknown): Promise<AuthResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
  const parsed = AuthResponseSchema.safeParse(json);
  if (!parsed.success) throw new ApiError("bad_response", "The server sent an unexpected response. Is this a Shpihcord hub?");
  return parsed.data;
}

export function login(serverUrl: string, username: string, password: string): Promise<AuthResponse> {
  return post(serverUrl, "/api/login", { username, password });
}

export function register(serverUrl: string, username: string, password: string, inviteCode: string): Promise<AuthResponse> {
  return post(serverUrl, "/api/register", { username, password, inviteCode });
}
