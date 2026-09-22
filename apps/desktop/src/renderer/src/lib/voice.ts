/**
 * Glue between the hub, the call engine and the store: joins/leaves voice
 * channels, keeps the mesh in sync with voice states, and applies local
 * controls (mute/deafen/PTT/devices) to the active call.
 */
import { createVoiceCall, type PeerInfo, type SignalingTransport, type VoiceCall } from "@shpihcord/call-engine";
import type { ServerMessage, SignalData, VoiceState } from "@shpihcord/protocol";
import { getApp, setApp, toast } from "../store/app";
import { getSettings, useSettings, type Settings } from "../store/settings";
import type { HubClient } from "./hub";
import { playSound, setSoundOutputDevice } from "./sounds";

let hub: HubClient | null = null;
let call: VoiceCall | null = null;
let signaling: (SignalingTransport & { dispose(): void }) | null = null;
let callUnsubs: Array<() => void> = [];
/** Bumped whenever the active call is replaced; stale async work checks it. */
let generation = 0;
/** After sending voice.join, ignore our own voice.left until the hub confirms the join. */
let awaitingSelfState = false;
let lastSyncKey = "";
const levelListeners = new Set<(level: number) => void>();

// ---------------------------------------------------------------------------
// Signaling adapter
// ---------------------------------------------------------------------------

/**
 * Wraps the hub as the engine's SignalingTransport. Signals that arrive before
 * the engine subscribes are buffered and flushed on subscribe.
 */
function makeSignaling(h: HubClient): SignalingTransport & { dispose(): void } {
  const handlers = new Set<(from: string, data: SignalData) => void>();
  const buffer: Array<[string, SignalData]> = [];
  let disposed = false;
  const off = h.onMessage("rtc.signal", (m) => {
    if (disposed) return;
    if (handlers.size === 0) {
      if (buffer.length < 512) buffer.push([m.from, m.data]);
      return;
    }
    for (const fn of [...handlers]) fn(m.from, m.data);
  });
  return {
    send(to, data) {
      if (!disposed) h.send({ type: "rtc.signal", to, data });
    },
    onSignal(handler) {
      handlers.add(handler);
      if (buffer.length) {
        const pending = buffer.splice(0);
        queueMicrotask(() => {
          if (!disposed) for (const [from, data] of pending) handler(from, data);
        });
      }
      return () => {
        handlers.delete(handler);
      };
    },
    dispose() {
      disposed = true;
      off();
      handlers.clear();
      buffer.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Hub wiring
// ---------------------------------------------------------------------------

export function attachHub(h: HubClient | null): void {
  hub = h;
}

/** Called by the session dispatcher after the store has applied `msg`. */
export function handleServerMessage(msg: ServerMessage, prevVoiceStates: Record<string, VoiceState>): void {
  const app = getApp();
  const selfId = app.self?.id;
  const myChannel = app.voiceChannelId;
  switch (msg.type) {
    case "ready":
      // (Re)connected: the snapshot replaced state. If we were in voice, rejoin with a fresh call.
      if (myChannel) void startCall(myChannel, true);
      break;
    case "voice.state": {
      const vs = msg.voiceState;
      if (vs.userId === selfId) {
        if (vs.channelId === myChannel) awaitingSelfState = false;
        break;
      }
      const before = prevVoiceStates[vs.userId]?.channelId;
      if (myChannel && app.voiceStatus === "connected") {
        if (before !== myChannel && vs.channelId === myChannel) playSound("peerJoin");
        else if (before === myChannel && vs.channelId !== myChannel) playSound("peerLeave");
      }
      syncPeers();
      break;
    }
    case "voice.left":
      if (msg.userId === selfId) {
        if (msg.channelId === myChannel && !awaitingSelfState && myChannel) {
          // The hub removed us (kicked / server-side cleanup).
          leaveVoice({ notifyHub: false });
          toast("You were disconnected from voice.", "info");
        }
        break;
      }
      if (myChannel && msg.channelId === myChannel && app.voiceStatus === "connected") playSound("peerLeave");
      syncPeers();
      break;
    case "ice.refresh":
      call?.setIceServers(msg.iceServers);
      break;
    default:
      break;
  }
}

/** Hub connection dropped: the hub drops our voice state, so show "connecting" until `ready` rejoins. */
export function handleHubDisconnected(): void {
  if (getApp().voiceChannelId) setApp({ voiceStatus: "connecting" });
}

// ---------------------------------------------------------------------------
// Call lifecycle
// ---------------------------------------------------------------------------

function teardownCall(): void {
  for (const off of callUnsubs) off();
  callUnsubs = [];
  if (call) {
    try {
      call.close();
    } catch (err) {
      console.warn("[voice] close failed", err);
    }
  }
  call = null;
  signaling?.dispose();
  signaling = null;
  lastSyncKey = "";
}

function describeMediaError(err: unknown): string {
  const name = err instanceof DOMException || (err instanceof Error && err.name) ? (err as Error).name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was denied. Allow microphone access for Shpihcord and try again.";
    case "NotFoundError":
      return "No microphone was found. Plug one in or pick another input device in Settings.";
    case "OverconstrainedError":
      return "The selected microphone isn't available. Pick another input device in Settings.";
    case "NotReadableError":
    case "AbortError":
      return "Couldn't open the microphone. It may be in use by another application.";
    default:
      return `Couldn't start voice: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function applyStoredPeerPrefs(info: PeerInfo): void {
  if (!call) return;
  const s = getSettings();
  const vol = s.userVolumes[info.userId] ?? 1;
  const muted = s.userMuted[info.userId] ?? false;
  if (Math.abs(info.volume - vol) > 0.001) call.setPeerVolume(info.userId, vol);
  if (info.locallyMuted !== muted) call.setPeerMuted(info.userId, muted);
}

/**
 * Create a fresh call for `channelId`, acquire the mic, then tell the hub.
 * `rejoin` is set when recovering after a hub reconnect (no join sound).
 */
async function startCall(channelId: string, rejoin: boolean): Promise<void> {
  const h = hub;
  const self = getApp().self;
  if (!h || !self) return;
  teardownCall();
  const gen = ++generation;
  setApp({ voiceChannelId: channelId, voiceStatus: "connecting", peers: {}, speaking: {} });

  const s = getSettings();
  const sig = makeSignaling(h);
  let c: VoiceCall;
  try {
    c = createVoiceCall({
      selfId: self.id,
      iceServers: getApp().iceServers,
      signaling: sig,
      forceRelay: s.forceRelay,
      inputDeviceId: s.inputDeviceId === "default" ? undefined : s.inputDeviceId,
      outputDeviceId: s.outputDeviceId === "default" ? undefined : s.outputDeviceId,
      inputMode: s.inputMode,
      vadThreshold: s.vadThreshold,
      noiseSuppression: s.noiseSuppression,
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGainControl,
    });
  } catch (err) {
    sig.dispose();
    failJoin(gen, err);
    return;
  }
  call = c;
  signaling = sig;
  callUnsubs.push(
    c.on("peer", (info) => {
      if (gen !== generation) return;
      setApp((st) => ({ peers: { ...st.peers, [info.userId]: info } }));
      applyStoredPeerPrefs(info);
    }),
    c.on("peerRemoved", ({ userId }) => {
      if (gen !== generation) return;
      setApp((st) => {
        const peers = { ...st.peers };
        delete peers[userId];
        const speaking = { ...st.speaking };
        delete speaking[userId];
        return { peers, speaking };
      });
    }),
    c.on("speaking", ({ userId, speaking }) => {
      if (gen !== generation) return;
      setApp((st) => {
        if (!!st.speaking[userId] === speaking) return {};
        const next = { ...st.speaking };
        if (speaking) next[userId] = true;
        else delete next[userId];
        return { speaking: next };
      });
    }),
    c.on("localLevel", ({ level }) => {
      for (const fn of levelListeners) fn(level);
    }),
    c.on("error", ({ message, cause }) => {
      if (gen !== generation) return;
      console.error("[voice] engine error:", message, cause);
      toast(message, "error");
    }),
  );

  c.setMuted(s.selfMuted);
  c.setDeafened(s.selfDeafened);
  c.setPushToTalk(getApp().pttActive);

  try {
    // Triggered from a click (or a reconnect after one), so audio autoplay is allowed.
    await c.start();
  } catch (err) {
    failJoin(gen, err);
    return;
  }
  if (gen !== generation) return; // superseded while acquiring the mic

  awaitingSelfState = true;
  if (!h.send({ type: "voice.join", channelId })) {
    // Socket dropped meanwhile; the `ready` after reconnect will rejoin.
    setApp({ voiceStatus: "connecting" });
    return;
  }
  h.send({ type: "voice.update", muted: s.selfMuted, deafened: s.selfDeafened });
  setApp({ voiceStatus: "connected" });
  if (!rejoin) playSound("join");
  syncPeers();
}

function failJoin(gen: number, err: unknown): void {
  if (gen !== generation) return;
  console.error("[voice] failed to start call", err);
  toast(describeMediaError(err), "error", 8000);
  playSound("error");
  leaveVoice({ silent: true });
}

/** Tell the engine which peers are in our channel (idempotent). */
function syncPeers(): void {
  const { voiceStates, voiceChannelId, self, voiceStatus } = getApp();
  if (!call || !voiceChannelId || !self || voiceStatus !== "connected") return;
  const ids = Object.values(voiceStates)
    .filter((v) => v.channelId === voiceChannelId && v.userId !== self.id)
    .map((v) => v.userId)
    .sort();
  const key = ids.join(",");
  if (key === lastSyncKey) return;
  lastSyncKey = key;
  call.syncPeers(ids);
}

// ---------------------------------------------------------------------------
// Public controls
// ---------------------------------------------------------------------------

export async function joinVoice(channelId: string): Promise<void> {
  const app = getApp();
  if (!hub || app.connection !== "connected") {
    toast("You're not connected to the server right now.", "error");
    return;
  }
  if (app.voiceChannelId === channelId && call) return;
  await startCall(channelId, false);
}

export function leaveVoice(opts: { silent?: boolean; notifyHub?: boolean } = {}): void {
  const app = getApp();
  const wasIn = !!app.voiceChannelId;
  // Only tell the hub if it thinks we're in voice (a failed first join never sent voice.join).
  const hubHasUs = awaitingSelfState || (!!app.self && !!app.voiceStates[app.self.id]);
  generation++;
  teardownCall();
  awaitingSelfState = false;
  if (wasIn && hubHasUs && opts.notifyHub !== false) hub?.send({ type: "voice.leave" });
  setApp({ voiceChannelId: null, voiceStatus: "idle", peers: {}, speaking: {} });
  if (wasIn && !opts.silent) playSound("leave");
}

function pushMuteState(): void {
  const s = getSettings();
  call?.setMuted(s.selfMuted);
  call?.setDeafened(s.selfDeafened);
  if (getApp().voiceChannelId) hub?.send({ type: "voice.update", muted: s.selfMuted, deafened: s.selfDeafened });
}

export function toggleMute(): void {
  const s = getSettings();
  if (s.selfDeafened) {
    // Like Discord: unmuting while deafened also undeafens.
    useSettings.getState().update({ selfDeafened: false, selfMuted: false });
    playSound("unmute");
  } else {
    const next = !s.selfMuted;
    useSettings.getState().update({ selfMuted: next });
    playSound(next ? "mute" : "unmute");
  }
  pushMuteState();
}

export function toggleDeafen(): void {
  const next = !getSettings().selfDeafened;
  useSettings.getState().update({ selfDeafened: next });
  playSound(next ? "deafen" : "undeafen");
  pushMuteState();
}

export function setPushToTalk(active: boolean): void {
  call?.setPushToTalk(active);
}

export function setPeerVolume(userId: string, volume: number): void {
  useSettings.getState().setUserVolume(userId, volume);
  call?.setPeerVolume(userId, volume);
}

export function setPeerMuted(userId: string, muted: boolean): void {
  useSettings.getState().setUserMuted(userId, muted);
  call?.setPeerMuted(userId, muted);
}

export function hasActiveCall(): boolean {
  return !!call && getApp().voiceStatus !== "idle";
}

/** Mic level of the active call (for the settings meter). */
export function onLocalLevel(fn: (level: number) => void): () => void {
  levelListeners.add(fn);
  return () => levelListeners.delete(fn);
}

// Apply setting changes live to the active call where the engine allows it.
useSettings.subscribe((s: Settings, prev: Settings) => {
  if (s.outputDeviceId !== prev.outputDeviceId) void setSoundOutputDevice(s.outputDeviceId);
  if (!call) return;
  const c = call;
  if (s.inputDeviceId !== prev.inputDeviceId) {
    c.setInputDevice(s.inputDeviceId).catch((err: unknown) =>
      toast(describeMediaError(err), "error"),
    );
  }
  if (s.outputDeviceId !== prev.outputDeviceId) {
    c.setOutputDevice(s.outputDeviceId).catch((err: unknown) =>
      toast(`Couldn't switch output device: ${err instanceof Error ? err.message : String(err)}`, "error"),
    );
  }
  if (s.inputMode !== prev.inputMode) c.setInputMode(s.inputMode);
  if (s.vadThreshold !== prev.vadThreshold) c.setVadThreshold(s.vadThreshold);
});
