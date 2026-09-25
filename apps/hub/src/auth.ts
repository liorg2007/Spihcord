import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { Store, UserRow } from "./db.js";

/**
 * Sessions expire after 30 days of NOT being used (security H1). Every use (HTTP or WS auth)
 * slides the expiry forward, at most once per SESSION_SLIDE_GRANULARITY_MS to avoid a DB write
 * per request. A desktop app that is opened at least monthly never asks to log in again, while a
 * leaked token from an abandoned device dies within a month; explicit logout, revoke-all and
 * password change cover the "leaked and still in use" case immediately.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_SLIDE_GRANULARITY_MS = 60 * 60 * 1000;

/** @node-rs/argon2 defaults to argon2id (m=19456 KiB, t=2, p=1). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;
/** Burn comparable CPU time when the username doesn't exist (no user enumeration by timing). */
export async function verifyDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(await dummyHash, password);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a session and returns the raw token (only the hash is stored). */
export function issueToken(store: Store, userId: string): string {
  const token = randomBytes(32).toString("base64url");
  store.createSession(hashToken(token), userId, SESSION_TTL_MS);
  return token;
}

/** Resolves a raw token to its user and slides the session's expiry. */
export function userForToken(store: Store, token: string): UserRow | undefined {
  if (!token || token.length > 256) return undefined;
  const tokenHash = hashToken(token);
  const session = store.getSession(tokenHash);
  if (!session) return undefined;
  const now = Date.now();
  if (session.expires_at - now < SESSION_TTL_MS - SESSION_SLIDE_GRANULARITY_MS) {
    store.touchSession(tokenHash, now + SESSION_TTL_MS);
  }
  return store.getUserById(session.user_id);
}
