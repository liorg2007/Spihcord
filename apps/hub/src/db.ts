import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Channel, User } from "@shpihcord/protocol";
import { newId, randomCode } from "./ids.js";

type DB = Database.Database;

/** Each entry migrates from user_version = index to index + 1. */
const MIGRATIONS: ((db: DB) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token_hash   TEXT PRIMARY KEY,           -- sha256(token) hex; the raw token is never stored
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);

      CREATE TABLE invites (
        code         TEXT PRIMARY KEY,
        created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL = created by the host (CLI / first run)
        uses_left    INTEGER NOT NULL,
        expires_at   INTEGER,                                        -- NULL = never
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE channels (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        type         TEXT NOT NULL CHECK (type IN ('text', 'voice')),
        position     INTEGER NOT NULL,
        created_at   INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    const insert = db.prepare(
      "INSERT INTO channels (id, name, type, position, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(newId(now), "general", "text", 0, now);
    insert.run(newId(now), "Hangout", "voice", 1, now);
    insert.run(newId(now), "Gaming", "voice", 2, now);
  },
];

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  created_at: number;
}

export interface InviteRow {
  code: string;
  created_by: string | null;
  uses_left: number;
  expires_at: number | null;
  created_at: number;
}

export function toUser(row: UserRow): User {
  return { id: row.id, username: row.username, displayName: row.display_name };
}

function restrictMode(p: string, mode: number): void {
  try {
    if (fs.existsSync(p)) fs.chmodSync(p, mode);
  } catch {
    /* e.g. a volume owned by someone else; not fatal */
  }
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export class Store {
  readonly db: DB;

  constructor(dataDir: string) {
    // Owner-only data dir and DB file (security A14). SQLite gives -wal/-shm the DB file's mode.
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    restrictMode(dataDir, 0o700);
    const file = path.join(dataDir, "hub.sqlite");
    fs.closeSync(fs.openSync(file, "a", 0o600));
    for (const f of [file, `${file}-wal`, `${file}-shm`]) restrictMode(f, 0o600);
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    let version = this.db.pragma("user_version", { simple: true }) as number;
    while (version < MIGRATIONS.length) {
      const target = version + 1;
      this.db.transaction(() => {
        MIGRATIONS[version](this.db);
        this.db.pragma(`user_version = ${target}`);
      })();
      version = target;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- users -------------------------------------------------------------

  countUsers(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  getUserById(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  getUserByUsername(username: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | UserRow
      | undefined;
  }

  listUsers(): User[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at, id").all() as UserRow[];
    return rows.map(toUser);
  }

  /**
   * Atomically consumes one use of `inviteCode` and creates the user.
   * The first user ever becomes admin.
   */
  registerWithInvite(
    username: string,
    passwordHash: string,
    inviteCode: string,
  ): { ok: true; user: UserRow } | { ok: false; error: "invalid_invite" | "username_taken" } {
    return this.db.transaction(() => {
      const now = Date.now();
      const invite = this.db.prepare("SELECT * FROM invites WHERE code = ?").get(inviteCode) as
        | InviteRow
        | undefined;
      if (!invite || invite.uses_left <= 0 || (invite.expires_at !== null && invite.expires_at <= now)) {
        return { ok: false as const, error: "invalid_invite" as const };
      }
      if (this.getUserByUsername(username)) {
        return { ok: false as const, error: "username_taken" as const };
      }
      const isAdmin = this.countUsers() === 0 ? 1 : 0;
      const row: UserRow = {
        id: newId(now),
        username,
        display_name: username,
        password_hash: passwordHash,
        is_admin: isAdmin,
        created_at: now,
      };
      this.db
        .prepare(
          `INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at)
           VALUES (@id, @username, @display_name, @password_hash, @is_admin, @created_at)`,
        )
        .run(row);
      this.db.prepare("UPDATE invites SET uses_left = uses_left - 1 WHERE code = ?").run(inviteCode);
      return { ok: true as const, user: row };
    })();
  }

  // ---- sessions ----------------------------------------------------------

  createSession(tokenHash: string, userId: string, ttlMs: number): void {
    const now = Date.now();
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, userId, now, now + ttlMs);
  }

  getUserBySessionHash(tokenHash: string): UserRow | undefined {
    return this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, Date.now()) as UserRow | undefined;
  }

  /** A live (unexpired) session. */
  getSession(tokenHash: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, Date.now()) as SessionRow | undefined;
  }

  touchSession(tokenHash: string, expiresAt: number): void {
    this.db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(expiresAt, tokenHash);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  /** Deletes every session of the user, except `keepTokenHash` if given. */
  deleteSessionsForUser(userId: string, keepTokenHash?: string): void {
    this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
      .run(userId, keepTokenHash ?? "");
  }

  /** Sets a new password hash and revokes every other session, atomically. */
  changePassword(userId: string, passwordHash: string, keepTokenHash: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
      this.deleteSessionsForUser(userId, keepTokenHash);
    })();
  }

  pruneSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  }

  // ---- invites -----------------------------------------------------------

  createInvite(opts: { createdBy?: string | null; uses?: number; expiresInMs?: number | null } = {}): InviteRow {
    const now = Date.now();
    const row: InviteRow = {
      code: randomCode(10),
      created_by: opts.createdBy ?? null,
      uses_left: opts.uses ?? 1,
      expires_at: opts.expiresInMs == null ? null : now + opts.expiresInMs,
      created_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO invites (code, created_by, uses_left, expires_at, created_at)
         VALUES (@code, @created_by, @uses_left, @expires_at, @created_at)`,
      )
      .run(row);
    return row;
  }

  /** A still-usable invite created by the host (no creator), if any. */
  findHostInvite(): InviteRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM invites WHERE created_by IS NULL AND uses_left > 0
         AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1`,
      )
      .get(Date.now()) as InviteRow | undefined;
  }

  // ---- channels ----------------------------------------------------------

  listChannels(): Channel[] {
    return this.db
      .prepare("SELECT id, name, type, position FROM channels ORDER BY position, id")
      .all() as Channel[];
  }

  getChannel(id: string): Channel | undefined {
    return this.db.prepare("SELECT id, name, type, position FROM channels WHERE id = ?").get(id) as
      | Channel
      | undefined;
  }
}
