/**
 * Persists the login session (server URL + token + user) encrypted with the
 * OS keychain via Electron safeStorage, in the userData directory.
 *
 * Linux without a keyring (no gnome-keyring/kwallet/libsecret) has no
 * safeStorage. Rather than failing login we then store the session as a
 * user-only (0600) plain file and tell the renderer ("plaintext") so it warns.
 */
import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SessionSaveResult, StoredSession } from "../shared/ipc";

const sessionFile = (): string => join(app.getPath("userData"), "session.bin");
const plainFile = (): string => join(app.getPath("userData"), "session.json");

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

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

export async function saveSession(session: unknown): Promise<SessionSaveResult> {
  if (!isStoredSession(session)) throw new Error("invalid session payload");
  const clean: StoredSession = {
    serverUrl: session.serverUrl,
    token: session.token,
    user: { id: session.user.id, username: session.user.username, displayName: session.user.displayName },
  };
  if (!encryptionAvailable()) {
    if (process.platform !== "linux") {
      console.warn("[session] safeStorage unavailable; session will not be persisted");
      await clearSession();
      return false;
    }
    console.warn("[session] no OS keyring; storing the session unencrypted (0600) in userData");
    await fs.rm(sessionFile(), { force: true });
    await writeAtomic(plainFile(), JSON.stringify(clean));
    return "plaintext";
  }
  await writeAtomic(sessionFile(), safeStorage.encryptString(JSON.stringify(clean)));
  await fs.rm(plainFile(), { force: true });
  return true;
}

export async function loadSession(): Promise<StoredSession | null> {
  try {
    let parsed: unknown;
    if (encryptionAvailable()) {
      try {
        parsed = JSON.parse(safeStorage.decryptString(await fs.readFile(sessionFile())));
      } catch {
        parsed = null;
      }
    }
    if (!parsed && process.platform === "linux") {
      parsed = JSON.parse(await fs.readFile(plainFile(), "utf8"));
    }
    return isStoredSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await fs.rm(sessionFile(), { force: true });
  await fs.rm(plainFile(), { force: true });
}
