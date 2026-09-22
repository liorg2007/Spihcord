/** Session lifecycle: restore/login/logout and the hub connection. */
import type { StoredSession } from "../../../shared/ipc";
import { applyServerMessage, getApp, resetSessionState, setApp, toast } from "../store/app";
import { bridge } from "./bridge";
import { HubClient } from "./hub";
import { attachHub, handleHubDisconnected, handleServerMessage, leaveVoice } from "./voice";

let hub: HubClient | null = null;
const LAST_LOGIN_KEY = "shpihcord.lastLogin";

export interface LastLogin {
  serverUrl: string;
  username: string;
}

export function getLastLogin(): LastLogin | null {
  try {
    const raw = localStorage.getItem(LAST_LOGIN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastLogin>;
    return typeof v.serverUrl === "string" && typeof v.username === "string" ? { serverUrl: v.serverUrl, username: v.username } : null;
  } catch {
    return null;
  }
}

function rememberLogin(session: StoredSession): void {
  try {
    localStorage.setItem(LAST_LOGIN_KEY, JSON.stringify({ serverUrl: session.serverUrl, username: session.user.username }));
  } catch {
    /* ignore */
  }
}

function stopHub(): void {
  attachHub(null);
  hub?.stop();
  hub = null;
}

function startSession(session: StoredSession): void {
  stopHub();
  resetSessionState({ screen: "app", session, connection: "connecting" });
  const h = new HubClient(session.serverUrl, session.token);
  hub = h;
  attachHub(h);
  h.on("message", (msg) => {
    if (hub !== h) return;
    const prevVoiceStates = getApp().voiceStates;
    applyServerMessage(msg);
    handleServerMessage(msg, prevVoiceStates);
    if (msg.type === "error") toast(msg.message || msg.code, "error");
  });
  h.on("status", ({ status, retryInMs }) => {
    if (hub !== h) return;
    setApp({ connection: status, retryInMs });
    if (status !== "connected") handleHubDisconnected();
  });
  h.on("fatal", (fatal) => {
    if (hub !== h) return;
    leaveVoice({ silent: true, notifyHub: false });
    if (fatal.kind === "unauthorized") {
      void logout("Your session has expired. Please log in again.");
    } else {
      setApp({ fatal });
    }
  });
  h.start();
}

/** On startup: restore a saved session or show the login screen. */
let bootstrapped = false;
export async function bootstrap(): Promise<void> {
  if (bootstrapped) return; // React StrictMode runs effects twice in dev
  bootstrapped = true;
  let saved: StoredSession | null = null;
  try {
    saved = await bridge.session.load();
  } catch (err) {
    console.warn("[session] load failed", err);
  }
  if (saved) startSession(saved);
  else setApp({ screen: "login" });
}

export async function loginWith(session: StoredSession): Promise<void> {
  rememberLogin(session);
  let persisted = false;
  try {
    persisted = await bridge.session.save(session);
  } catch (err) {
    console.warn("[session] save failed", err);
  }
  startSession(session);
  if (!persisted && bridge.platform !== "browser") {
    toast("Secure storage isn't available, so you'll need to log in again next time.", "info", 8000);
  }
}

export async function logout(notice?: string): Promise<void> {
  leaveVoice({ silent: true });
  stopHub();
  try {
    await bridge.session.clear();
  } catch {
    /* ignore */
  }
  resetSessionState({ screen: "login", loginNotice: notice ?? null });
}

/** After "session replaced": take the session back on this device. */
export function reconnectHere(): void {
  const session = getApp().session;
  if (session) startSession(session);
}

export function reconnectNow(): void {
  hub?.reconnectNow();
}
