import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyBaseLogger } from "fastify";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ClientMessageOf,
  type ServerMessage,
  type User,
  type VoiceState,
} from "@shpihcord/protocol";
import { userForToken } from "./auth.js";
import type { HubConfig } from "./config.js";
import { toUser, type Store } from "./db.js";
import { iceServersFor, turnEnabled } from "./turn.js";

/** Application close codes (4000-4999). */
export const CloseCode = {
  unauthorized: 4001,
  outdatedClient: 4002,
  sessionReplaced: 4003,
  authTimeout: 4004,
  heartbeatTimeout: 4005,
  invalidMessage: 4006,
  rateLimited: 4008,
} as const;

/** Token bucket: allows bursts (ICE candidates on join) but caps sustained rate. */
const BUCKET_CAPACITY = 200;
const BUCKET_REFILL_PER_SEC = 40;
/** Consecutive-ish violations before we give up on a client. */
const MAX_RATE_VIOLATIONS = 500;

interface Conn {
  ws: WebSocket;
  user: User | null;
  lastPong: number;
  tokens: number;
  lastRefill: number;
  rateViolations: number;
  lastRateError: number;
  /** Set when a newer connection took over; its close must not touch shared state. */
  replaced: boolean;
  authTimer: NodeJS.Timeout | null;
  iceTimer: NodeJS.Timeout | null;
}

export class Gateway {
  private readonly wss: WebSocketServer;
  /** Authenticated connections, one per user. */
  private readonly online = new Map<string, Conn>();
  private readonly pending = new Set<Conn>();
  private readonly voice = new Map<string, VoiceState>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly config: HubConfig,
    private readonly store: Store,
    private readonly log: FastifyBaseLogger,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: config.wsMaxPayload });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.heartbeat = setInterval(() => this.tick(), config.heartbeatIntervalMs);
  }

  /** Hook for the HTTP server's `upgrade` event. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  /** Broadcast a newly registered user to everyone online. */
  userUpserted(user: User): void {
    this.broadcast({ type: "user.upsert", user });
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const conn of [...this.pending, ...this.online.values()]) {
      this.clearTimers(conn);
      conn.replaced = true; // skip broadcasts during shutdown
      conn.ws.close(1001, "server shutting down");
    }
    this.pending.clear();
    this.online.clear();
    this.voice.clear();
    this.wss.close();
  }

  // ---------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    const now = Date.now();
    const conn: Conn = {
      ws,
      user: null,
      lastPong: now,
      tokens: BUCKET_CAPACITY,
      lastRefill: now,
      rateViolations: 0,
      lastRateError: 0,
      replaced: false,
      authTimer: null,
      iceTimer: null,
    };
    this.pending.add(conn);
    conn.authTimer = setTimeout(() => {
      if (!conn.user) this.fail(conn, "auth_timeout", "Authentication timed out.", CloseCode.authTimeout);
    }, this.config.authTimeoutMs);

    ws.on("message", (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on("close", () => this.onClose(conn));
    ws.on("error", (err) => this.log.debug({ err }, "ws error"));
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (!this.takeToken(conn)) return;

    let msg: ClientMessage;
    try {
      if (isBinary) throw new Error("binary");
      const parsed = ClientMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) throw new Error("schema");
      msg = parsed.data;
    } catch {
      if (!conn.user) {
        this.fail(conn, "unauthorized", "Expected an auth message.", CloseCode.unauthorized);
      } else {
        this.send(conn, { type: "error", code: "invalid_message", message: "Malformed or unknown message." });
      }
      return;
    }

    if (!conn.user) {
      if (msg.type !== "auth") {
        this.fail(conn, "unauthorized", "The first message must be auth.", CloseCode.unauthorized);
        return;
      }
      this.onAuth(conn, msg);
      return;
    }

    switch (msg.type) {
      case "auth":
        this.send(conn, { type: "error", code: "already_authenticated", message: "Already authenticated." });
        return;
      case "pong":
        conn.lastPong = Date.now();
        return;
      case "voice.join":
        this.onVoiceJoin(conn, msg);
        return;
      case "voice.leave":
        this.leaveVoice(conn.user.id);
        return;
      case "voice.update":
        this.onVoiceUpdate(conn, msg);
        return;
      case "rtc.signal":
        this.onSignal(conn, msg);
        return;
    }
  }

  private onAuth(conn: Conn, msg: ClientMessageOf<"auth">): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.fail(
        conn,
        "outdated_client",
        `Protocol version ${msg.protocolVersion} is not supported (hub speaks ${PROTOCOL_VERSION}). Please update.`,
        CloseCode.outdatedClient,
      );
      return;
    }
    const row = userForToken(this.store, msg.token);
    if (!row) {
      this.fail(conn, "unauthorized", "Invalid or expired session.", CloseCode.unauthorized);
      return;
    }
    const user = toUser(row);
    this.pending.delete(conn);
    if (conn.authTimer) clearTimeout(conn.authTimer);
    conn.authTimer = null;
    conn.user = user;
    conn.lastPong = Date.now();

    const previous = this.online.get(user.id);
    if (previous) {
      // One connection per user: the newest wins.
      previous.replaced = true;
      this.clearTimers(previous);
      this.leaveVoice(user.id);
      this.send(previous, {
        type: "error",
        code: "session_replaced",
        message: "You connected from somewhere else.",
      });
      previous.ws.close(CloseCode.sessionReplaced, "session replaced");
    }
    this.online.set(user.id, conn);

    this.send(conn, {
      type: "ready",
      self: user,
      users: this.store.listUsers(),
      onlineUserIds: [...this.online.keys()],
      channels: this.store.listChannels(),
      voiceStates: [...this.voice.values()],
      iceServers: iceServersFor(this.config, user.id),
    });
    this.scheduleIceRefresh(conn);

    if (!previous) this.broadcast({ type: "presence.update", userId: user.id, online: true }, user.id);
    this.log.info({ userId: user.id, username: user.username, replaced: !!previous }, "ws authenticated");
  }

  private onClose(conn: Conn): void {
    this.clearTimers(conn);
    this.pending.delete(conn);
    if (!conn.user || conn.replaced) return;
    const userId = conn.user.id;
    if (this.online.get(userId) !== conn) return;
    this.leaveVoice(userId);
    this.online.delete(userId);
    this.broadcast({ type: "presence.update", userId, online: false });
    this.log.info({ userId }, "ws disconnected");
  }

  // ---- voice -------------------------------------------------------------

  private onVoiceJoin(conn: Conn, msg: ClientMessageOf<"voice.join">): void {
    const userId = conn.user!.id;
    const channel = this.store.getChannel(msg.channelId);
    if (!channel || channel.type !== "voice") {
      this.send(conn, { type: "error", code: "invalid_channel", message: "No such voice channel." });
      return;
    }
    const current = this.voice.get(userId);
    if (current?.channelId === channel.id) {
      // Already there: just re-confirm to the caller.
      this.send(conn, { type: "voice.state", voiceState: current });
      return;
    }
    // Keep self-mute/deafen when switching channels.
    const muted = current?.muted ?? false;
    const deafened = current?.deafened ?? false;
    if (current) this.leaveVoice(userId);
    // Screen share and camera do not follow the user into another channel.
    const state: VoiceState = { userId, channelId: channel.id, muted, deafened, streaming: false, video: false };
    this.voice.set(userId, state);
    this.broadcast({ type: "voice.state", voiceState: state });
  }

  private onVoiceUpdate(conn: Conn, msg: ClientMessageOf<"voice.update">): void {
    const current = this.voice.get(conn.user!.id);
    if (!current) {
      this.send(conn, { type: "error", code: "not_in_voice", message: "You are not in a voice channel." });
      return;
    }
    const streaming = msg.streaming ?? current.streaming;
    const video = msg.video ?? current.video;
    if (
      current.muted === msg.muted &&
      current.deafened === msg.deafened &&
      current.streaming === streaming &&
      current.video === video
    )
      return;
    const state: VoiceState = { ...current, muted: msg.muted, deafened: msg.deafened, streaming, video };
    this.voice.set(state.userId, state);
    this.broadcast({ type: "voice.state", voiceState: state });
  }

  private leaveVoice(userId: string): void {
    const current = this.voice.get(userId);
    if (!current) return;
    this.voice.delete(userId);
    this.broadcast({ type: "voice.left", userId, channelId: current.channelId });
  }

  private onSignal(conn: Conn, msg: ClientMessageOf<"rtc.signal">): void {
    const from = conn.user!.id;
    if (msg.to === from) return;
    const mine = this.voice.get(from);
    const theirs = this.voice.get(msg.to);
    if (!mine || !theirs || mine.channelId !== theirs.channelId) return;
    const target = this.online.get(msg.to);
    if (!target) return;
    this.send(target, { type: "rtc.signal", from, data: msg.data });
  }

  // ---- plumbing ----------------------------------------------------------

  private scheduleIceRefresh(conn: Conn): void {
    if (!turnEnabled(this.config)) return;
    const delay = Math.floor(this.config.turnTtlSeconds * 1000 * 0.8);
    conn.iceTimer = setTimeout(() => {
      if (!conn.user || conn.replaced || conn.ws.readyState !== conn.ws.OPEN) return;
      this.send(conn, { type: "ice.refresh", iceServers: iceServersFor(this.config, conn.user.id) });
      this.scheduleIceRefresh(conn);
    }, delay);
    conn.iceTimer.unref?.();
  }

  private tick(): void {
    const now = Date.now();
    for (const conn of this.online.values()) {
      if (now - conn.lastPong > this.config.heartbeatTimeoutMs) {
        this.log.info({ userId: conn.user?.id }, "heartbeat timeout");
        conn.ws.terminate(); // triggers onClose cleanup
        continue;
      }
      this.send(conn, { type: "ping" });
    }
  }

  private takeToken(conn: Conn): boolean {
    const now = Date.now();
    conn.tokens = Math.min(BUCKET_CAPACITY, conn.tokens + ((now - conn.lastRefill) / 1000) * BUCKET_REFILL_PER_SEC);
    conn.lastRefill = now;
    if (conn.tokens >= 1) {
      conn.tokens -= 1;
      return true;
    }
    conn.rateViolations++;
    if (conn.rateViolations > MAX_RATE_VIOLATIONS) {
      this.fail(conn, "rate_limited", "Too many messages.", CloseCode.rateLimited);
    } else if (now - conn.lastRateError > 1000) {
      conn.lastRateError = now;
      this.send(conn, { type: "error", code: "rate_limited", message: "Slow down; message dropped." });
    }
    return false;
  }

  private clearTimers(conn: Conn): void {
    if (conn.authTimer) clearTimeout(conn.authTimer);
    if (conn.iceTimer) clearTimeout(conn.iceTimer);
    conn.authTimer = conn.iceTimer = null;
  }

  private fail(conn: Conn, code: string, message: string, closeCode: number): void {
    this.send(conn, { type: "error", code, message });
    conn.ws.close(closeCode, code);
  }

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, exceptUserId?: string): void {
    const payload = JSON.stringify(msg);
    for (const [userId, conn] of this.online) {
      if (userId === exceptUserId) continue;
      if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(payload);
    }
  }
}
