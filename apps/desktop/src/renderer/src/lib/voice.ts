/**
 * Glue between the hub, the call engine and the store: joins/leaves voice
 * channels, keeps the mesh in sync with voice states, and applies local
 * controls (mute/deafen/PTT/devices) to the active call.
 */
import {
  createVoiceCall,
  SCREEN_SHARE_PRESETS,
  type PeerInfo,
  type ScreenSharePresetId,
  type SignalingTransport,
  type StreamStats,
  type VoiceCall,
} from "@shpihcord/call-engine";
import type { ServerMessage, SignalData, VoiceState } from "@shpihcord/protocol";
import type { ScreenAudioMode, ScreenAudioSupport } from "../../../shared/ipc";
import { getApp, setApp, toast, type AppState } from "../store/app";
import { getSettings, useSettings, type Settings } from "../store/settings";
import type { HubClient } from "./hub";
import { bridge } from "./bridge";
import { setCameraPrefSender } from "./cameraPrefs";
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
/** Bumped on every Go Live attempt / stop; a stale getDisplayMedia result is discarded. */
let shareSeq = 0;
/** Bumped on every camera start / stop; a stale startCamera result is discarded. */
let cameraSeq = 0;
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
      // The sharer we're watching stopped streaming or left: back to the grid.
      if (app.focusedStream === vs.userId && (!vs.streaming || vs.channelId !== myChannel)) stopWatching(vs.userId);
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
      if (app.focusedStream === msg.userId) stopWatching(msg.userId);
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
  setCameraPrefSender(null);
  // call.close() stopped our share, our camera and all received streams.
  shareSeq++;
  cameraSeq++;
  setApp({
    localShare: null,
    focusedStream: null,
    remoteStreams: {},
    streamStats: {},
    goLiveOpen: false,
    cameraStatus: "off",
    localCamera: null,
    remoteCameras: {},
  });
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
        const patch: Partial<AppState> = { peers, speaking };
        if (st.remoteCameras[userId]) {
          const remoteCameras = { ...st.remoteCameras };
          delete remoteCameras[userId];
          patch.remoteCameras = remoteCameras;
        }
        const camKeys = [`cam:send:${userId}`, `cam:recv:${userId}`].filter((k) => st.streamStats[k]);
        if (camKeys.length) {
          const streamStats = { ...st.streamStats };
          for (const k of camKeys) delete streamStats[k];
          patch.streamStats = streamStats;
        }
        return patch;
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
    c.on("remoteScreen", ({ userId, stream }) => {
      if (gen !== generation) return;
      setApp((st) => {
        const remoteStreams = { ...st.remoteStreams };
        if (stream) remoteStreams[userId] = stream;
        else delete remoteStreams[userId];
        return { remoteStreams, focusedStream: !stream && st.focusedStream === userId ? null : st.focusedStream };
      });
      if (stream) c.setStreamVolume(userId, getSettings().streamVolumes[userId] ?? 1);
    }),
    c.on("localScreenEnded", () => {
      if (gen !== generation) return;
      stopScreenShare("ended");
    }),
    c.on("viewers", ({ userIds }) => {
      if (gen !== generation) return;
      setApp((st) => {
        if (!st.localShare) return {};
        // Drop send stats of viewers that left.
        const streamStats = { ...st.streamStats };
        for (const key of Object.keys(streamStats)) {
          if (key.startsWith("send:") && !userIds.includes(key.slice(5))) delete streamStats[key];
        }
        return { localShare: { ...st.localShare, viewers: [...userIds] }, streamStats };
      });
    }),
    c.on("streamStats", (stats) => {
      if (gen !== generation) return;
      const key = statsKey(stats);
      setApp((st) => ({ streamStats: { ...st.streamStats, [key]: stats } }));
    }),
    c.on("remoteCamera", ({ userId, stream }) => {
      if (gen !== generation) return;
      setApp((st) => {
        if (stream ? st.remoteCameras[userId] === stream : !st.remoteCameras[userId]) return {};
        const remoteCameras = { ...st.remoteCameras };
        if (stream) remoteCameras[userId] = stream;
        else delete remoteCameras[userId];
        const patch: Partial<AppState> = { remoteCameras };
        if (!stream && st.streamStats[`cam:recv:${userId}`]) {
          const streamStats = { ...st.streamStats };
          delete streamStats[`cam:recv:${userId}`];
          patch.streamStats = streamStats;
        }
        return patch;
      });
    }),
    c.on("localCamera", ({ stream }) => {
      if (gen !== generation) return;
      setApp({ localCamera: stream });
    }),
    c.on("localCameraEnded", () => {
      if (gen !== generation) return;
      stopCamera("ended");
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
  setCameraPrefSender((userId, pref) => {
    if (gen === generation && call === c) c.setCameraPreference(userId, pref);
  });

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
  // Camera is always off on join.
  h.send({ type: "voice.update", muted: s.selfMuted, deafened: s.selfDeafened, video: false });
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
  if (s.videoDeviceId !== prev.videoDeviceId && c.isCameraOn()) void switchCameraDevice(c, s.videoDeviceId);
  if (s.inputMode !== prev.inputMode) c.setInputMode(s.inputMode);
  if (s.vadThreshold !== prev.vadThreshold) c.setVadThreshold(s.vadThreshold);
});

// ---------------------------------------------------------------------------
// Screen share ("Go Live")
// ---------------------------------------------------------------------------

/** Screen: `send:<viewer>` / `recv:<user>`; camera: the same prefixed with `cam:`. */
export function statsKey(s: StreamStats): string {
  const base = s.direction === "send" ? `send:${s.viewerId ?? ""}` : `recv:${s.userId}`;
  return s.kind === "camera" ? `cam:${base}` : base;
}

let audioSupport: Promise<ScreenAudioSupport> | null = null;
export function getScreenAudioSupport(): Promise<ScreenAudioSupport> {
  audioSupport ??= bridge.screen.audioSupport().catch(() => ({ system: false, excludesOwnAudio: false, appAudio: false }));
  return audioSupport;
}

/** Audio constraints for getDisplayMedia: raw (no voice processing), and without our own playback. */
function displayAudioConstraints(mode: ScreenAudioMode): MediaTrackConstraints | false {
  if (mode === "none") return false;
  return {
    // Electron >= 43.4/44 maps "loopback" + restrictOwnAudio to Chromium's
    // "loopbackWithoutChrome" (system audio minus this app's process tree).
    // Not in TS's DOM lib yet, hence the cast.
    ...(mode === "system" ? { restrictOwnAudio: true } : {}),
    suppressLocalAudioPlayback: false,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 2,
  } as MediaTrackConstraints;
}

/** Inspect the captured audio track; returns what is really shared and a warning if needed. */
function checkShareAudio(
  stream: MediaStream,
  granted: ScreenAudioMode,
  support: ScreenAudioSupport,
): { audio: ScreenAudioMode; warning: string | null } {
  if (granted === "none") return { audio: "none", warning: null };
  const track = stream.getAudioTracks()[0];
  if (!track) return { audio: "none", warning: "Couldn't capture audio on this system, so your stream has no sound." };
  if (granted === "app") return { audio: "app", warning: null };
  const st = track.getSettings() as MediaTrackSettings & { restrictOwnAudio?: boolean };
  const excluded = st.restrictOwnAudio === true || st.deviceId === "loopbackWithoutChrome";
  if (excluded) return { audio: "system", warning: null };
  return {
    audio: "system",
    warning:
      support.note && !support.excludesOwnAudio
        ? support.note
        : "Your stream audio includes voice chat, so friends may hear themselves. Turn off stream audio if that's a problem.",
  };
}

function describeCaptureError(err: unknown): string {
  const name = err instanceof Error || err instanceof DOMException ? (err as Error).name : "";
  switch (name) {
    case "NotAllowedError":
      return bridge.platform === "darwin"
        ? "Screen recording isn't allowed. Enable Shpihcord in System Settings → Privacy & Security → Screen & System Audio Recording."
        : "Screen capture was blocked.";
    case "AbortError":
    case "NotReadableError":
      return "Couldn't capture that screen or window. It may have closed; pick another one.";
    default:
      return `Couldn't go live: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function sendStreaming(streaming: boolean): void {
  const s = getSettings();
  if (getApp().voiceChannelId) hub?.send({ type: "voice.update", muted: s.selfMuted, deafened: s.selfDeafened, streaming });
}

export interface GoLiveOptions {
  sourceId: string;
  sourceName: string;
  preset: ScreenSharePresetId;
  audio: ScreenAudioMode;
}

/** Capture the chosen source and start sharing it. Resolves true when live. */
export async function startScreenShare(opts: GoLiveOptions): Promise<boolean> {
  const c = call;
  if (!c || !hub || getApp().voiceStatus !== "connected") {
    toast("Join a voice channel to go live.", "error");
    return false;
  }
  const gen = generation;
  const seq = ++shareSeq;
  const stale = () => gen !== generation || seq !== shareSeq || call !== c;
  const prev = getApp().localShare;
  if (!prev) {
    setApp({
      localShare: {
        status: "starting",
        preset: opts.preset,
        sourceName: opts.sourceName,
        audio: opts.audio,
        audioWarning: null,
        stream: null,
        viewers: [],
      },
    });
  }

  let stream: MediaStream | null = null;
  try {
    const support = await getScreenAudioSupport();
    const sel = await bridge.screen.select({ sourceId: opts.sourceId, audio: opts.audio });
    if (!sel.ok) throw new Error(sel.reason ?? "that source isn't available");
    if (sel.reason) toast(sel.reason, "info");
    const p = SCREEN_SHARE_PRESETS[opts.preset];
    // Without an explicit frameRate Chromium captures the desktop at 30 fps.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: p.frameRate, max: p.frameRate },
        width: { max: p.maxWidth },
        height: { max: p.maxHeight },
      },
      audio: displayAudioConstraints(sel.audio),
    });
    if (stale()) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    const { audio, warning } = checkShareAudio(stream, sel.audio, support);
    await c.startScreenShare(stream, opts.preset);
    if (stale()) {
      if (call === c) c.stopScreenShare();
      return false;
    }
    sendStreaming(true);
    setApp((st) => ({
      localShare: {
        status: "live",
        preset: opts.preset,
        sourceName: opts.sourceName,
        audio,
        audioWarning: warning,
        stream,
        viewers: st.localShare?.viewers ?? [],
      },
    }));
    if (warning) toast(warning, "info", 9000);
    return true;
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    if (stale()) return false;
    console.error("[screen] go live failed", err);
    toast(describeCaptureError(err), "error", 8000);
    // Keep a previous live share running if this was a source switch.
    if (!prev) setApp({ localShare: null });
    else if (call === c && !c.isScreenSharing()) stopScreenShare();
    return false;
  }
}

export function stopScreenShare(reason?: "ended"): void {
  shareSeq++;
  const had = getApp().localShare;
  if (!had) return;
  try {
    call?.stopScreenShare();
  } catch (err) {
    console.warn("[screen] stop failed", err);
  }
  const selfId = getApp().self?.id;
  setApp((st) => {
    const streamStats = { ...st.streamStats };
    for (const key of Object.keys(streamStats)) if (key.startsWith("send:")) delete streamStats[key];
    return { localShare: null, focusedStream: st.focusedStream === selfId ? null : st.focusedStream, streamStats };
  });
  if (had.status === "live") sendStreaming(false);
  if (reason === "ended") toast("Your stream ended (the shared window or screen went away).", "info");
}

export async function setScreenSharePreset(preset: ScreenSharePresetId): Promise<void> {
  useSettings.getState().update({ screenPreset: preset });
  const share = getApp().localShare;
  if (!call || !share || share.status !== "live" || share.preset === preset) return;
  const before = share.preset;
  setApp((st) => (st.localShare ? { localShare: { ...st.localShare, preset } } : {}));
  try {
    await call.setScreenSharePreset(preset);
  } catch (err) {
    setApp((st) => (st.localShare ? { localShare: { ...st.localShare, preset: before } } : {}));
    toast(`Couldn't change stream quality: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

/** Focus a stream: start receiving a remote share, or show our own preview. */
export function watchStream(userId: string): void {
  const app = getApp();
  if (userId === app.self?.id) {
    if (app.localShare) setApp({ focusedStream: userId });
    return;
  }
  if (!call) return;
  const prev = app.focusedStream;
  if (prev === userId) return;
  if (prev && prev !== app.self?.id) stopWatching(prev);
  call.watchStream(userId, true);
  call.setStreamVolume(userId, getSettings().streamVolumes[userId] ?? 1);
  setApp({ focusedStream: userId });
}

export function stopWatching(userId?: string): void {
  const app = getApp();
  const id = userId ?? app.focusedStream;
  if (!id) return;
  if (id !== app.self?.id) {
    try {
      call?.watchStream(id, false);
    } catch (err) {
      console.warn("[screen] unwatch failed", err);
    }
  }
  setApp((st) => {
    const patch: Partial<AppState> = {};
    if (st.remoteStreams[id]) {
      const remoteStreams = { ...st.remoteStreams };
      delete remoteStreams[id];
      patch.remoteStreams = remoteStreams;
    }
    if (st.streamStats[`recv:${id}`]) {
      const streamStats = { ...st.streamStats };
      delete streamStats[`recv:${id}`];
      patch.streamStats = streamStats;
    }
    if (st.focusedStream === id) patch.focusedStream = null;
    return patch;
  });
}

export function setStreamVolume(userId: string, volume: number): void {
  useSettings.getState().setStreamVolume(userId, volume);
  call?.setStreamVolume(userId, Math.min(2, Math.max(0, volume)));
}

export function openGoLive(): void {
  if (!call || getApp().voiceStatus !== "connected") {
    toast("Join a voice channel to go live.", "error");
    return;
  }
  setApp({ goLiveOpen: true });
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

function describeCameraError(err: unknown): string {
  const name = err instanceof Error || err instanceof DOMException ? (err as Error).name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return bridge.platform === "darwin"
        ? "Camera access was denied. Allow Shpihcord in System Settings → Privacy & Security → Camera."
        : "Camera access was denied. Allow camera access for Shpihcord and try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found. Plug one in or pick another camera in Settings → Voice & Video.";
    case "OverconstrainedError":
      return "The selected camera isn't available. Pick another camera in Settings → Voice & Video.";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "Couldn't open the camera. It may be in use by another application.";
    default:
      return `Couldn't turn on the camera: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function cameraDeviceArg(id: string): string | undefined {
  return id && id !== "default" ? id : undefined;
}

function sendVideo(video: boolean): void {
  const s = getSettings();
  if (getApp().voiceChannelId) hub?.send({ type: "voice.update", muted: s.selfMuted, deafened: s.selfDeafened, video });
}

function clearCameraSendStats(): Partial<AppState> | null {
  const st = getApp().streamStats;
  const keys = Object.keys(st).filter((k) => k.startsWith("cam:send:"));
  if (!keys.length) return null;
  const streamStats = { ...st };
  for (const k of keys) delete streamStats[k];
  return { streamStats };
}

/** Turn our camera on. Resolves true when it's on. */
export async function startCamera(): Promise<boolean> {
  const c = call;
  if (!c || !hub || getApp().voiceStatus !== "connected") {
    toast("Join a voice channel to turn on your camera.", "error");
    return false;
  }
  if (getApp().cameraStatus !== "off") return getApp().cameraStatus === "on";
  const gen = generation;
  const seq = ++cameraSeq;
  const stale = () => gen !== generation || seq !== cameraSeq || call !== c;
  setApp({ cameraStatus: "starting" });
  try {
    await c.startCamera(cameraDeviceArg(getSettings().videoDeviceId));
  } catch (err) {
    if (stale()) return false;
    console.error("[camera] start failed", err);
    try {
      c.stopCamera();
    } catch {
      /* nothing to stop */
    }
    setApp({ cameraStatus: "off", localCamera: null });
    toast(describeCameraError(err), "error", 8000);
    playSound("error");
    return false;
  }
  if (stale()) {
    // Turned off / left while the device was opening.
    if (call === c) c.stopCamera();
    return false;
  }
  setApp({ cameraStatus: "on" });
  sendVideo(true);
  return true;
}

/** Turn our camera off and release the device. */
export function stopCamera(reason?: "ended"): void {
  cameraSeq++;
  const was = getApp().cameraStatus;
  if (was === "off") return;
  try {
    call?.stopCamera();
  } catch (err) {
    console.warn("[camera] stop failed", err);
  }
  setApp({ cameraStatus: "off", localCamera: null, ...clearCameraSendStats() });
  // "starting" never told the hub video:true, but it's harmless and keeps it consistent.
  sendVideo(false);
  if (reason === "ended") toast("Your camera stopped (it was unplugged or access was revoked).", "info", 7000);
}

export function toggleCamera(): void {
  if (getApp().cameraStatus === "off") void startCamera();
  else stopCamera();
}

async function switchCameraDevice(c: VoiceCall, deviceId: string): Promise<void> {
  let id = cameraDeviceArg(deviceId);
  if (!id) {
    // "Default" = the first camera the system lists.
    try {
      id = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "videoinput" && d.deviceId)?.deviceId;
    } catch {
      id = undefined;
    }
    if (!id) return;
  }
  if (call !== c || !c.isCameraOn()) return;
  try {
    await c.setCameraDevice(id);
  } catch (err) {
    if (call !== c) return;
    console.error("[camera] device switch failed", err);
    toast(describeCameraError(err), "error", 8000);
  }
}

/** Local "Hide video" for one user (persisted); the preference manager turns their camera off. */
export function setVideoHidden(userId: string, hidden: boolean): void {
  useSettings.getState().setVideoHidden(userId, hidden);
}
