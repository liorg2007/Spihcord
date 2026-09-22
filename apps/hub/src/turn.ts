import { createHmac } from "node:crypto";
import type { IceServer } from "@shpihcord/protocol";
import type { HubConfig } from "./config.js";

export interface TurnCredentials {
  username: string;
  credential: string;
  expiresAt: number; // unix seconds
}

/**
 * coturn `use-auth-secret` (TURN REST API) credentials:
 * username = `${expiryUnix}:${userId}`, credential = base64(HMAC-SHA1(secret, username)).
 */
export function turnCredentials(
  secret: string,
  userId: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): TurnCredentials {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiresAt}:${userId}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential, expiresAt };
}

export function turnEnabled(config: HubConfig): boolean {
  return config.turnUrls.length > 0 && !!config.turnSecret;
}

export function iceServersFor(config: HubConfig, userId: string, nowMs: number = Date.now()): IceServer[] {
  const servers: IceServer[] = [];
  if (config.stunUrls.length > 0) servers.push({ urls: config.stunUrls });
  if (turnEnabled(config)) {
    const { username, credential } = turnCredentials(config.turnSecret!, userId, config.turnTtlSeconds, nowMs);
    servers.push({ urls: config.turnUrls, username, credential });
  }
  return servers;
}
