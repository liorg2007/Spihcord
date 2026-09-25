import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  PROTOCOL_VERSION,
  RegisterRequestSchema,
  type AuthResponse,
  type ErrorResponse,
  type OkResponse,
  type User,
} from "@shpihcord/protocol";
import { hashPassword, hashToken, issueToken, userForToken, verifyDummy, verifyPassword } from "./auth.js";
import { toUser, type Store, type UserRow } from "./db.js";

export interface HttpDeps {
  store: Store;
  /** Called after a successful registration (gateway broadcasts `user.upsert`). */
  onUserRegistered: (user: User) => void;
  /**
   * Called after sessions were revoked so live WebSockets using them are closed (code 4001).
   * `tokenHash`: only that session; `exceptTokenHash`: all of the user's sessions but that one;
   * neither: all of the user's sessions.
   */
  onSessionsRevoked: (userId: string, opts: { tokenHash?: string; exceptTokenHash?: string }) => void;
}

function sendError(reply: FastifyReply, status: number, error: string, message: string) {
  const body: ErrorResponse = { error, message };
  return reply.code(status).send(body);
}

/** Tiny fixed-window limiter per IP for credential endpoints. */
function createIpLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    const entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= max;
  };
}

const CreateInviteBodySchema = z
  .object({
    uses: z.number().int().min(1).max(1000).optional(),
    /** Hours until expiry; 0 / omitted-null means never. Default 7 days. */
    expiresInHours: z.number().min(0).max(24 * 365).optional(),
  })
  .strict();

const DEFAULT_INVITE_USES = 5;
const DEFAULT_INVITE_HOURS = 7 * 24;

export function registerHttpRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const { store } = deps;
  const credLimiter = createIpLimiter(20, 60_000);

  const limit = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (credLimiter(req.ip)) return true;
    void sendError(reply, 429, "rate_limited", "Too many attempts, try again in a minute.");
    return false;
  };

  app.get("/api/health", async () => ({ ok: true as const, protocolVersion: PROTOCOL_VERSION }));

  app.post("/api/register", async (req, reply) => {
    if (!limit(req, reply)) return reply;
    const parsed = RegisterRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request");
    }
    const { username, password, inviteCode } = parsed.data;
    const passwordHash = await hashPassword(password);
    const result = store.registerWithInvite(username, passwordHash, inviteCode.trim().toUpperCase());
    if (!result.ok) {
      if (result.error === "username_taken") {
        return sendError(reply, 409, "username_taken", "That username is already taken.");
      }
      return sendError(reply, 403, "invalid_invite", "The invite code is invalid, used up or expired.");
    }
    const user = toUser(result.user);
    req.log.info({ userId: user.id, username: user.username, admin: !!result.user.is_admin }, "user registered");
    deps.onUserRegistered(user);
    const body: AuthResponse = { token: issueToken(store, user.id), user };
    return reply.code(201).send(body);
  });

  app.post("/api/login", async (req, reply) => {
    if (!limit(req, reply)) return reply;
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid request");
    const { username, password } = parsed.data;
    const row = username.length <= 64 ? store.getUserByUsername(username) : undefined;
    if (!row) {
      await verifyDummy(password);
      return sendError(reply, 401, "invalid_credentials", "Invalid username or password.");
    }
    if (!(await verifyPassword(row.password_hash, password))) {
      return sendError(reply, 401, "invalid_credentials", "Invalid username or password.");
    }
    const body: AuthResponse = { token: issueToken(store, row.id), user: toUser(row) };
    return reply.send(body);
  });

  /** Resolves the bearer token; sends 401 and returns null if it is missing or invalid. */
  const authed = (req: FastifyRequest, reply: FastifyReply): { user: UserRow; tokenHash: string } | null => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    const user = match ? userForToken(store, match[1]) : undefined;
    if (!match || !user) {
      void sendError(reply, 401, "unauthorized", "Missing or invalid token.");
      return null;
    }
    return { user, tokenHash: hashToken(match[1]) };
  };
  const ok: OkResponse = { ok: true };

  app.post("/api/logout", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    store.deleteSession(auth.tokenHash);
    deps.onSessionsRevoked(auth.user.id, { tokenHash: auth.tokenHash });
    req.log.info({ userId: auth.user.id }, "session revoked (logout)");
    return reply.send(ok);
  });

  app.post("/api/sessions/revoke-all", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    store.deleteSessionsForUser(auth.user.id);
    deps.onSessionsRevoked(auth.user.id, {});
    req.log.info({ userId: auth.user.id }, "all sessions revoked");
    return reply.send(ok);
  });

  app.post("/api/password", async (req, reply) => {
    if (!limit(req, reply)) return reply;
    const auth = authed(req, reply);
    if (!auth) return reply;
    const parsed = ChangePasswordRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request");
    }
    const { currentPassword, newPassword } = parsed.data;
    if (!(await verifyPassword(auth.user.password_hash, currentPassword))) {
      return sendError(reply, 403, "invalid_credentials", "The current password is wrong.");
    }
    // The caller's session stays valid (so its live connection is not dropped); every other
    // session is revoked and disconnected.
    store.changePassword(auth.user.id, await hashPassword(newPassword), auth.tokenHash);
    deps.onSessionsRevoked(auth.user.id, { exceptTokenHash: auth.tokenHash });
    req.log.info({ userId: auth.user.id }, "password changed, other sessions revoked");
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")!;
    const body: AuthResponse = { token: match[1], user: toUser(auth.user) };
    return reply.send(body);
  });

  app.post("/api/invites", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const { user } = auth;
    if (!user.is_admin) return sendError(reply, 403, "forbidden", "Only admins can create invites.");

    const parsed = CreateInviteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "invalid_request", "Invalid request");
    const uses = parsed.data.uses ?? DEFAULT_INVITE_USES;
    const hours = parsed.data.expiresInHours ?? DEFAULT_INVITE_HOURS;
    const invite = store.createInvite({
      createdBy: user.id,
      uses,
      expiresInMs: hours === 0 ? null : hours * 3600_000,
    });
    return reply.code(201).send({
      code: invite.code,
      usesLeft: invite.uses_left,
      expiresAt: invite.expires_at,
    });
  });
}
