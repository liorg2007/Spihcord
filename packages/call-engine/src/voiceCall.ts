/**
 * VoiceCall implementation: full-mesh WebRTC audio (browser only).
 */
import type { IceServer, SignalData } from "@shpihcord/protocol";
import type {
  InputMode,
  PeerInfo,
  VoiceCall,
  VoiceCallEvents,
  VoiceCallOptions,
} from "./types";
import { Emitter } from "./emitter";
import { AudioEngine, type MicSettings } from "./audio";
import { Peer, type ResetReason } from "./peer";
import { SignalBuffer, diffPeers, isPolite } from "./mesh";
import { parseStatsReport, type LossCounters } from "./stats";
import { DEFAULT_VAD_THRESHOLD, VadGate, clamp01 } from "./vad";

const TICK_MS = 25; // local VAD
const LEVEL_EVERY_TICKS = 2; // ~20 Hz localLevel
const REMOTE_EVERY_TICKS = 4; // ~10 Hz remote speaking
const STATS_INTERVAL_MS = 2000;
const REMOTE_SPEAKING_THRESHOLD = 0.2; // ~ -48 dBFS; remote senders gate to silence
const REMOTE_SPEAKING_HANGOVER_MS = 400;
const SENDER_MAX_BITRATE = 64_000;

interface PeerEntry {
  peer: Peer;
  info: PeerInfo;
  counters?: LossCounters;
  statsInFlight: boolean;
  speaking: boolean;
  remoteVad: VadGate;
}

type Timer = ReturnType<typeof setInterval>;

export class VoiceCallImpl implements VoiceCall {
  private readonly selfId: string;
  private readonly emitter = new Emitter<VoiceCallEvents>((err) => console.error("[call-engine] event handler threw", err));
  private readonly audio: AudioEngine;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly prefs = new Map<string, { volume: number; muted: boolean }>();
  private readonly buffer = new SignalBuffer({ ttlMs: 10_000, maxPerSender: 100 });
  private readonly vad: VadGate;
  private readonly mic: MicSettings;

  private iceServers: IceServer[];
  private readonly forceRelay: boolean;
  private muted = false;
  private deafened = false;
  private mode: InputMode;
  private pttActive = false;
  private selfSpeaking = false;

  private startPromise: Promise<void> | undefined;
  private started = false;
  private closed = false;
  private tickTimer: Timer | undefined;
  private statsTimer: Timer | undefined;
  private tickCount = 0;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly options: VoiceCallOptions) {
    this.selfId = options.selfId;
    this.iceServers = options.iceServers;
    this.forceRelay = !!options.forceRelay;
    this.mode = options.inputMode ?? "voice-activity";
    this.vad = new VadGate({ threshold: options.vadThreshold ?? DEFAULT_VAD_THRESHOLD });
    this.mic = {
      deviceId: options.inputDeviceId,
      echoCancellation: options.echoCancellation ?? true,
      noiseSuppression: options.noiseSuppression ?? true,
      autoGainControl: options.autoGainControl ?? true,
    };

    this.audio = new AudioEngine((message, cause) => this.emitError(message, cause));
    this.audio.setSendEnabled(false);

    this.cleanups.push(options.signaling.onSignal((from, data) => this.onSignal(from, data)));
    this.installGestureResume();

    this.statsTimer = setInterval(() => this.pollStats(), STATS_INTERVAL_MS);

    if (options.outputDeviceId) {
      this.setOutputDevice(options.outputDeviceId).catch((err) =>
        this.emitError("Failed to select output device", err),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public API

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Voice call is closed"));
    if (this.startPromise) return this.startPromise;
    const p = (async () => {
      void this.audio.resume();
      try {
        await this.audio.setMic(this.mic);
      } catch (err) {
        this.startPromise = undefined;
        throw err;
      }
      if (this.closed) return;
      void this.audio.resume();
      this.started = true;
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
      this.applyTransmitState();
    })();
    this.startPromise = p;
    return p;
  }

  syncPeers(userIds: string[]): void {
    if (this.closed) return;
    const { added, removed } = diffPeers(this.peers.keys(), userIds, this.selfId);
    for (const id of removed) this.removePeer(id);
    const now = Date.now();
    for (const id of added) this.createPeer(id, this.buffer.take(id, now));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyTransmitState();
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    if (!this.closed) this.audio.setDeafened(deafened);
    this.applyTransmitState();
  }

  setInputMode(mode: InputMode): void {
    this.mode = mode;
    this.applyTransmitState();
  }

  setPushToTalk(active: boolean): void {
    this.pttActive = active;
    this.applyTransmitState();
  }

  setVadThreshold(threshold: number): void {
    this.vad.setThreshold(threshold);
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.mic.deviceId = deviceId;
    if (this.closed || !this.started) return;
    await this.audio.setMic(this.mic);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    if (this.closed) return;
    const ok = await this.audio.setSinkId(deviceId);
    if (!ok) this.emitError("Output device selection is not supported by this runtime");
  }

  setPeerVolume(userId: string, volume: number): void {
    const v = Number.isFinite(volume) ? Math.min(2, Math.max(0, volume)) : 1;
    const p = this.pref(userId);
    p.volume = v;
    this.applyPeerGain(userId);
    this.updateInfo(userId, { volume: v });
  }

  setPeerMuted(userId: string, muted: boolean): void {
    const p = this.pref(userId);
    p.muted = muted;
    this.applyPeerGain(userId);
    this.updateInfo(userId, { locallyMuted: muted });
  }

  setIceServers(iceServers: IceServer[]): void {
    this.iceServers = iceServers;
    if (this.closed) return;
    const config = this.rtcConfig();
    for (const e of this.peers.values()) e.peer.setConfiguration(config);
  }

  getPeers(): PeerInfo[] {
    return [...this.peers.values()].map((e) => ({ ...e.info }));
  }

  on<K extends keyof VoiceCallEvents>(event: K, handler: (payload: VoiceCallEvents[K]) => void): () => void {
    return this.emitter.on(event, handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.tickTimer = this.statsTimer = undefined;
    for (const c of this.cleanups.splice(0)) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
    for (const e of this.peers.values()) e.peer.close();
    this.peers.clear();
    this.buffer.clear();
    this.audio.close();
    this.emitter.clear();
  }

  // ---------------------------------------------------------------------------
  // Peers

  private pref(userId: string): { volume: number; muted: boolean } {
    let p = this.prefs.get(userId);
    if (!p) {
      p = { volume: 1, muted: false };
      this.prefs.set(userId, p);
    }
    return p;
  }

  private rtcConfig(): RTCConfiguration {
    return {
      iceServers: this.iceServers.map((s) => ({
        urls: s.urls,
        ...(s.username !== undefined ? { username: s.username } : {}),
        ...(s.credential !== undefined ? { credential: s.credential } : {}),
      })),
      iceTransportPolicy: this.forceRelay ? "relay" : "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    };
  }

  private createPeer(userId: string, replay: SignalData[]): void {
    const pref = this.pref(userId);
    let peer: Peer | undefined;
    const isCurrent = () => !!peer && this.peers.get(userId)?.peer === peer;
    try {
      peer = new Peer({
        userId,
        polite: isPolite(this.selfId, userId),
        config: this.rtcConfig(),
        createPc: (config) => new RTCPeerConnection(config),
        localTrack: this.audio.localTrack,
        localStreams: [this.audio.localStream],
        senderTuning: { maxBitrate: SENDER_MAX_BITRATE, priority: "high" },
        send: (data) => this.send(userId, data),
        onTrack: (track, stream) => {
          if (!isCurrent() || track.kind !== "audio") return;
          this.audio.addRemote(userId, stream ?? new MediaStream([track]), this.effectiveGain(userId));
        },
        onConnectionState: (state) => {
          if (isCurrent()) this.updateInfo(userId, { connectionState: state });
        },
        onError: (message, cause) => {
          if (isCurrent()) this.emitError(message, cause);
        },
        onReset: (reason, signals) => {
          if (isCurrent()) this.resetPeer(userId, reason, signals ?? []);
        },
      });
    } catch (err) {
      this.emitError(`Failed to create connection to ${userId}`, err);
      return;
    }
    const entry: PeerEntry = {
      peer,
      info: {
        userId,
        connectionState: peer.connectionState,
        route: "unknown",
        volume: pref.volume,
        locallyMuted: pref.muted,
      },
      statsInFlight: false,
      speaking: false,
      remoteVad: new VadGate({ threshold: REMOTE_SPEAKING_THRESHOLD, hangoverMs: REMOTE_SPEAKING_HANGOVER_MS }),
    };
    this.peers.set(userId, entry);
    this.emitter.emit("peer", { ...entry.info });
    for (const data of replay) void peer.handleSignal(data);
  }

  private disposePeer(userId: string): PeerEntry | undefined {
    const e = this.peers.get(userId);
    if (!e) return undefined;
    this.peers.delete(userId);
    e.peer.close();
    this.audio.removeRemote(userId);
    if (e.speaking) this.emitter.emit("speaking", { userId, speaking: false });
    return e;
  }

  private removePeer(userId: string): void {
    if (!this.disposePeer(userId)) return;
    this.buffer.drop(userId);
    this.emitter.emit("peerRemoved", { userId });
  }

  private resetPeer(userId: string, reason: ResetReason, replay: SignalData[]): void {
    if (this.closed) return;
    if (reason === "failed" || reason === "connect-timeout") {
      console.warn(`[call-engine] recreating connection to ${userId} (${reason})`);
    }
    this.disposePeer(userId);
    this.createPeer(userId, replay);
  }

  private send(to: string, data: SignalData): void {
    if (this.closed) return;
    try {
      this.options.signaling.send(to, data);
    } catch (err) {
      this.emitError("Failed to send signal", err);
    }
  }

  private onSignal(from: string, data: SignalData): void {
    if (this.closed || from === this.selfId) return;
    const e = this.peers.get(from);
    if (e) void e.peer.handleSignal(data);
    else this.buffer.push(from, data, Date.now());
  }

  private effectiveGain(userId: string): number {
    const p = this.pref(userId);
    return p.muted ? 0 : p.volume;
  }

  private applyPeerGain(userId: string): void {
    if (!this.closed) this.audio.setRemoteGain(userId, this.effectiveGain(userId));
  }

  private updateInfo(userId: string, patch: Partial<PeerInfo>): void {
    const e = this.peers.get(userId);
    if (!e || this.closed) return;
    let changed = false;
    for (const [k, v] of Object.entries(patch) as Array<[keyof PeerInfo, unknown]>) {
      if (e.info[k] !== v) {
        (e.info as unknown as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (changed) this.emitter.emit("peer", { ...e.info });
  }

  private pollStats(): void {
    if (this.closed) return;
    for (const [userId, e] of this.peers) {
      if (e.statsInFlight || e.peer.isClosed) continue;
      e.statsInFlight = true;
      e.peer
        .getStats()
        .then((report) => {
          if (this.peers.get(userId) !== e) return;
          const parsed = parseStatsReport(report, e.counters);
          if (parsed.counters) e.counters = parsed.counters;
          this.updateInfo(userId, {
            route: parsed.route === "unknown" ? e.info.route : parsed.route,
            rttMs: parsed.rttMs ?? e.info.rttMs,
            lossPct: parsed.lossPct ?? e.info.lossPct,
          });
        })
        .catch(() => {
          /* stats are best effort */
        })
        .finally(() => {
          e.statsInFlight = false;
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Local audio

  private tick(): void {
    if (this.closed) return;
    const now = performance.now();
    const level = this.audio.readLocalLevel();
    this.vad.update(level, now);
    this.applyTransmitState();
    this.tickCount++;
    if (this.tickCount % LEVEL_EVERY_TICKS === 0) {
      this.emitter.emit("localLevel", { level: clamp01(level) });
    }
    if (this.tickCount % REMOTE_EVERY_TICKS === 0) {
      for (const [userId, e] of this.peers) {
        const speaking = e.remoteVad.update(this.audio.readRemoteLevel(userId), now);
        if (speaking !== e.speaking) {
          e.speaking = speaking;
          this.emitter.emit("speaking", { userId, speaking });
        }
      }
    }
  }

  private applyTransmitState(): void {
    if (this.closed) return;
    const canSend = this.started && !this.muted && !this.deafened;
    const ptt = this.mode === "push-to-talk";
    const open = canSend && (ptt ? this.pttActive : this.vad.isActive);
    this.audio.setGate(open);
    this.audio.setSendEnabled(canSend);
    const speaking = canSend && this.vad.isActive && (!ptt || this.pttActive);
    if (speaking !== this.selfSpeaking) {
      this.selfSpeaking = speaking;
      this.emitter.emit("speaking", { userId: this.selfId, speaking });
    }
  }

  private installGestureResume(): void {
    if (typeof window === "undefined") return;
    const handler = () => {
      if (this.audio.ctx.state !== "running") void this.audio.resume();
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ["pointerdown", "keydown"] as const) window.addEventListener(type, handler, opts);
    this.cleanups.push(() => {
      for (const type of ["pointerdown", "keydown"] as const) window.removeEventListener(type, handler, opts);
    });
  }

  private emitError(message: string, cause?: unknown): void {
    if (this.closed) return;
    this.emitter.emit("error", { message, cause });
  }
}
