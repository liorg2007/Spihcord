import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { HubConfig } from "./config.js";
import { Store } from "./db.js";
import { Gateway } from "./gateway.js";
import { registerHttpRoutes } from "./http.js";
import { turnEnabled } from "./turn.js";

export interface HubServer {
  app: FastifyInstance;
  store: Store;
  gateway: Gateway;
  port: number;
  /** Invite code created because there are no users yet (first run), else null. */
  firstRunInvite: string | null;
  close(): Promise<void>;
}

const FIRST_RUN_INVITE_USES = 25;
const FIRST_RUN_INVITE_TTL_MS = 30 * 24 * 3600_000;

/** Creates the hub, opens the DB (running migrations/seeding) and starts listening. */
export async function createServer(config: HubConfig): Promise<HubServer> {
  const store = new Store(config.dataDir);
  store.pruneSessions();

  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });

  // Electron renderer origins vary (file://, http://localhost:5173, ...); auth is bearer-token based.
  await app.register(cors, { origin: "*", methods: ["GET", "POST", "OPTIONS"] });

  const gateway = new Gateway(config, store, app.log);
  registerHttpRoutes(app, { store, onUserRegistered: (user) => gateway.userUpserted(user) });
  app.server.on("upgrade", (req, socket, head) => gateway.handleUpgrade(req, socket, head));

  if (config.turnUrls.length > 0 && !config.turnSecret) {
    app.log.warn("TURN_URLS is set but TURN_SECRET is not; TURN servers will not be advertised.");
  } else if (!turnEnabled(config)) {
    app.log.info("TURN not configured; clients get STUN only.");
  }

  let firstRunInvite: string | null = null;
  if (store.countUsers() === 0) {
    const invite =
      store.findHostInvite() ??
      store.createInvite({ uses: FIRST_RUN_INVITE_USES, expiresInMs: FIRST_RUN_INVITE_TTL_MS });
    firstRunInvite = invite.code;
  }

  await app.listen({ port: config.port, host: config.host });
  const port = (app.server.address() as AddressInfo).port;

  let closed = false;
  return {
    app,
    store,
    gateway,
    port,
    firstRunInvite,
    async close() {
      if (closed) return;
      closed = true;
      gateway.close();
      await app.close();
      store.close();
    },
  };
}
