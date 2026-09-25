/** Session lifecycle: restore/login/logout and the hub connection. */
import type { StoredSession } from "../../../shared/ipc";
import { applyServerMessage, getApp, resetSessionState, setApp, toast } from "../store/app";
import { changePassword as apiChangePassword, isConnectionAllowed, logoutRemote, revokeAllSessions } from "./api";
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
  void bridge.net?.setHub(null).catch(() => {});
  attachHub(null);
  hub?.stop();
  hub = null;
}

function startSession(session: StoredSession): void {
  stopHub();
  resetSessionState({ screen: "app", session, connection: "connecting" });
  // Main picks the WebRTC IP policy from the hub's address (security T2).
  void bridge.net?.setHub(session.serverUrl).catch(() => {});
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
      void logout("Your session has expired. Please log in again.", { remote: false });
    } else if (fatal.kind === "insecure") {
      void logout(fatal.message, { remote: false });
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
  if (saved && !isConnectionAllowed(saved.serverUrl)) {
    // Saved before the https policy (or the confirmation was cleared): don't
    // send the token in plain text; ask again on the login screen.
    await logout("This server isn't encrypted. Log in again to confirm the connection.", { remote: false });
    return;
  }
  if (saved) startSession(saved);
  else setApp({ screen: "login" });
}

export async function loginWith(session: StoredSession): Promise<void> {
  rememberLogin(session);
  let persisted: boolean | "plaintext" = false;
  try {
    persisted = await bridge.session.save(session);
  } catch (err) {
    console.warn("[session] save failed", err);
  }
  startSession(session);
  if (!persisted && bridge.platform !== "browser") {
    toast("Secure storage isn't available, so you'll need to log in again next time.", "info", 8000);
  } else if (persisted === "plaintext") {
    toast("No system keyring found, so your login is saved unencrypted on this computer. Install gnome-keyring or KWallet to protect it.", "info", 10000);
  }
}

export async function logout(notice?: string, opts: { remote?: boolean } = {}): Promise<void> {
  const session = getApp().session;
  leaveVoice({ silent: true });
  stopHub();
  if (session && opts.remote !== false) {
    // Revoke the token on the hub too (best effort: offline / older hubs just keep it until expiry).
    await logoutRemote(session.serverUrl, session.token).catch((err: unknown) =>
      console.warn("[session] remote logout failed", err instanceof Error ? err.message : err),
    );
  }
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

/** Revoke every session of this account on the hub, then log out here. Throws on failure. */
export async function logoutAllDevices(): Promise<void> {
  const session = getApp().session;
  if (!session) return;
  await revokeAllSessions(session.serverUrl, session.token);
  await logout("You were logged out on all devices.", { remote: false });
}

/**
 * Change the password. If the hub returns a new token for this device, keep
 * going with it; otherwise (it revoked everything) log in again.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const session = getApp().session;
  if (!session) return;
  const res = await apiChangePassword(session.serverUrl, session.token, currentPassword, newPassword);
  if (res) {
    await loginWith({ serverUrl: session.serverUrl, token: res.token, user: res.user });
  } else {
    await logout("Password changed. Log in with your new password.", { remote: false });
  }
}
