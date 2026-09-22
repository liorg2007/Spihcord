/**
 * WebSocket client for the hub: auth handshake, zod validation of incoming
 * frames, ping/pong, and reconnect with exponential backoff + jitter.
 */
import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type ServerMessageOf,
} from "@shpihcord/protocol";
import { toWsUrl } from "./api";

export type HubStatus = "connecting" | "connected" | "reconnecting" | "stopped";

/** Errors after which we must not auto-reconnect. */
export type HubFatal =
  | { kind: "unauthorized"; message: string }
  | { kind: "outdated"; message: string }
  | { kind: "replaced"; message: string };

const FATAL_CODES: Record<string, HubFatal["kind"]> = {
  unauthorized: "unauthorized",
  invalid_token: "unauthorized",
  auth_failed: "unauthorized",
  outdated_client: "outdated",
  session_replaced: "replaced",
};

type Listener<T> = (payload: T) => void;

interface HubEvents {
  message: ServerMessage;
  status: { status: HubStatus; retryInMs?: number; attempt: number };
  fatal: HubFatal;
}

/** Hub WebSocket close codes that must not be retried. */
const FATAL_CLOSE_CODES: Record<number, HubFatal> = {
  4001: { kind: "unauthorized", message: "Your session is no longer valid." },
  4002: { kind: "outdated", message: "This version of Shpihcord is too old for the server." },
  4003: { kind: "replaced", message: "You signed in from another location." },
};

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 15000;
/** Hub pings every 25s; if nothing arrives for this long, assume the socket is dead. */
const IDLE_TIMEOUT_MS = 65000;

export class HubClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private _status: HubStatus = "connecting";
  private listeners: { [K in keyof HubEvents]: Set<Listener<HubEvents[K]>> } = {
    message: new Set(),
    status: new Set(),
    fatal: new Set(),
  };
  private readonly onOnline = (): void => {
    if (this._status === "reconnecting") this.reconnectNow();
  };

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
  ) {}

  get status(): HubStatus {
    return this._status;
  }

  on<K extends keyof HubEvents>(event: K, handler: Listener<HubEvents[K]>): () => void {
    this.listeners[event].add(handler);
    return () => this.listeners[event].delete(handler);
  }

  /** Subscribe to one server message type. */
  onMessage<T extends ServerMessage["type"]>(type: T, handler: (msg: ServerMessageOf<T>) => void): () => void {
    return this.on("message", (msg) => {
      if (msg.type === type) handler(msg as ServerMessageOf<T>);
    });
  }

  private emit<K extends keyof HubEvents>(event: K, payload: HubEvents[K]): void {
    for (const h of [...this.listeners[event]]) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[hub] ${event} handler failed`, err);
      }
    }
  }

  private setStatus(status: HubStatus, retryInMs?: number): void {
    this._status = status;
    this.emit("status", { status, retryInMs, attempt: this.attempt });
  }

  start(): void {
    this.stopped = false;
    window.addEventListener("online", this.onOnline);
    this.open();
  }

  /** Close for good (logout, fatal error). */
  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, "client closing");
      } catch {
        /* ignore */
      }
    }
    this.setStatus("stopped");
  }

  /** Skip the backoff wait and try again immediately. */
  reconnectNow(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.dropSocket();
    this.open();
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** True once `ready` has been received on the current socket. */
  get isReady(): boolean {
    return this._status === "connected";
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.retryTimer = this.handshakeTimer = this.idleTimer = null;
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      console.warn("[hub] no traffic, reconnecting");
      this.handleDisconnect();
    }, IDLE_TIMEOUT_MS);
  }

  private open(): void {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(this.serverUrl));
    } catch (err) {
      console.error("[hub] bad websocket url", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.handshakeTimer = setTimeout(() => {
      console.warn("[hub] handshake timed out");
      this.handleDisconnect();
    }, HANDSHAKE_TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: this.token, protocolVersion: PROTOCOL_VERSION } satisfies ClientMessage));
      this.bumpIdle();
    };
    ws.onmessage = (ev) => this.handleFrame(ev.data);
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (ev) => {
      if (ev.code !== 1000) console.info(`[hub] socket closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
      // Fallback for when the close arrives without (or before we parsed) an `error` frame.
      const fatal = FATAL_CLOSE_CODES[ev.code];
      if (fatal && !this.stopped) {
        this.stop();
        this.emit("fatal", { ...fatal, message: ev.reason || fatal.message });
        return;
      }
      this.handleDisconnect();
    };
  }

  private handleFrame(raw: unknown): void {
    this.bumpIdle();
    if (typeof raw !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      console.warn("[hub] non-JSON frame dropped");
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      console.warn("[hub] invalid frame dropped", parsed.error.issues, json);
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case "ping":
        this.send({ type: "pong" });
        return;
      case "ready":
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.attempt = 0;
        this.setStatus("connected");
        break;
      case "error": {
        const kind = FATAL_CODES[msg.code];
        if (kind) {
          this.stop();
          this.emit("fatal", { kind, message: msg.message });
          return;
        }
        break;
      }
    }
    this.emit("message", msg);
  }

  private handleDisconnect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.dropSocket();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 10));
    // "Equal jitter": half fixed, half random, so clients don't reconnect in lockstep.
    const delay = Math.round(exp / 2 + Math.random() * (exp / 2));
    this.attempt++;
    this.setStatus("reconnecting", delay);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }
}
