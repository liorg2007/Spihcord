import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type AuthResponse,
  type ClientMessage,
  type ServerMessage,
  type ServerMessageOf,
} from "@shpihcord/protocol";
import { loadConfig, type HubConfig } from "../src/config.js";
import { createServer, type HubServer } from "../src/server.js";

export interface TestHub {
  hub: HubServer;
  base: string;
  wsUrl: string;
  invite: string;
  stop(): Promise<void>;
}

export async function startHub(overrides: Partial<HubConfig> = {}): Promise<TestHub> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shpihcord-hub-"));
  const config: HubConfig = {
    ...loadConfig({}),
    port: 0,
    host: "127.0.0.1",
    dataDir,
    logLevel: "silent",
    ...overrides,
  };
  const hub = await createServer(config);
  const base = `http://127.0.0.1:${hub.port}`;
  return {
    hub,
    base,
    wsUrl: `ws://127.0.0.1:${hub.port}/ws`,
    invite: hub.firstRunInvite!,
    async stop() {
      await hub.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function post(base: string, route: string, body: unknown, token?: string) {
  const res = await fetch(base + route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function register(t: TestHub, username: string, password = "hunter22"): Promise<AuthResponse> {
  const res = await post(t.base, "/api/register", { username, password, inviteCode: t.invite });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return res.body as AuthResponse;
}

type Waiter = { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void };

/** A ws client that buffers received messages so tests can await specific ones. */
export class TestClient {
  readonly ws: WebSocket;
  readonly received: ServerMessage[] = [];
  private waiters: Waiter[] = [];
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.closed = new Promise((resolve) =>
      this.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    this.ws.on("message", (data) => {
      const msg = ServerMessageSchema.parse(JSON.parse(data.toString()));
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        this.received.push(msg);
      }
    });
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  next<T extends ServerMessage["type"]>(
    type: T,
    pred: (m: ServerMessageOf<T>) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<ServerMessageOf<T>> {
    const match = (m: ServerMessage) => m.type === type && pred(m as ServerMessageOf<T>);
    const idx = this.received.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.received.splice(idx, 1)[0] as ServerMessageOf<T>);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { pred: match, resolve: (m) => (clearTimeout(timer), resolve(m as ServerMessageOf<T>)) };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Resolves true if no matching message arrives within `ms`. */
  async none(type: ServerMessage["type"], ms = 300): Promise<boolean> {
    try {
      await this.next(type, () => true, ms);
      return false;
    } catch {
      return true;
    }
  }

  close(): void {
    this.ws.close();
  }
}

export async function connect(t: TestHub, token: string): Promise<{ client: TestClient; ready: ServerMessageOf<"ready"> }> {
  const client = new TestClient(t.wsUrl);
  await client.opened;
  client.send({ type: "auth", token, protocolVersion: PROTOCOL_VERSION });
  const ready = await client.next("ready");
  return { client, ready };
}
