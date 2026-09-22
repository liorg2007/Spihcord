import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { Store, UserRow } from "./db.js";

/** Sessions live 90 days; refresh tokens / rotation can come later. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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

export function userForToken(store: Store, token: string): UserRow | undefined {
  if (!token || token.length > 256) return undefined;
  return store.getUserBySessionHash(hashToken(token));
}
