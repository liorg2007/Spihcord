/**
 * Persists the login session (server URL + token + user) encrypted with the
 * OS keychain via Electron safeStorage, in the userData directory.
 */
import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { StoredSession } from "../shared/ipc";

const sessionFile = (): string => join(app.getPath("userData"), "session.bin");

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const u = v.user as Record<string, unknown> | undefined;
  return (
    typeof v.serverUrl === "string" &&
    typeof v.token === "string" &&
    !!u &&
    typeof u.id === "string" &&
    typeof u.username === "string" &&
    typeof u.displayName === "string"
  );
}

export async function saveSession(session: unknown): Promise<boolean> {
  if (!isStoredSession(session)) throw new Error("invalid session payload");
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[session] safeStorage unavailable; session will not be persisted");
    await clearSession();
    return false;
  }
  const clean: StoredSession = {
    serverUrl: session.serverUrl,
    token: session.token,
    user: { id: session.user.id, username: session.user.username, displayName: session.user.displayName },
  };
  const encrypted = safeStorage.encryptString(JSON.stringify(clean));
  const file = sessionFile();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, encrypted, { mode: 0o600 });
  await fs.rename(tmp, file);
  return true;
}

export async function loadSession(): Promise<StoredSession | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const buf = await fs.readFile(sessionFile());
    const parsed: unknown = JSON.parse(safeStorage.decryptString(buf));
    return isStoredSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await fs.rm(sessionFile(), { force: true });
}
