/**
 * VoiceCall implementation: full-mesh WebRTC audio + opt-in screen share (browser only).
 *
 * Screen share, per peer connection:
 *  - the mic is always the first transceiver (created in the Peer constructor);
 *    on the receiving side the remote mic always lands on transceiver[0] too, so
 *    any other audio transceiver that receives is screen-share audio;
 *  - the sharer adds its screen video (+ optional audio) with addTransceiver
 *    (sendonly, own msid stream) only for peers that sent `watch`; `unwatch`
 *    sets them to inactive (replaceTrack(null) first) and a later watch reuses
 *    the same transceivers, so m-lines don't pile up.
 */
import type { IceServer, SignalData } from "@shpihcord/protocol";
import type {
  InputMode,
  PeerInfo,
  ScreenSharePreset,
  ScreenSharePresetId,
  VoiceCall,
  VoiceCallEvents,
  VoiceCallOptions,
} from "./types";
import { SCREEN_SHARE_PRESETS } from "./presets";
import { Emitter } from "./emitter";
import { AudioEngine, type MicSettings } from "./audio";
import { Peer, type ResetReason } from "./peer";
import { SignalBuffer, diffPeers, isPolite } from "./mesh";
import { parseStatsReport, parseVideoStats, type LossCounters, type VideoCounters } from "./stats";
import { DEFAULT_VAD_THRESHOLD, VadGate, clamp01 } from "./vad";
import { mungeLocalSdp, mungeOutgoingSdp } from "./sdp";
import { CpuWatch, ScreenShareIntents, isStreamSignal, screenEncoding, type StreamAction } from "./screenShare";
import { codecName, h264Rank, mediaCapabilitiesContentType, orderVideoCodecs, SCREEN_CODEC_ORDER, type CodecLike } from "./codecs";

const TICK_MS = 25; // local VAD
const LEVEL_EVERY_TICKS = 2; // ~20 Hz localLevel
const REMOTE_EVERY_TICKS = 4; // ~10 Hz remote speaking
const STATS_INTERVAL_MS = 2000;
const REMOTE_SPEAKING_THRESHOLD = 0.2; // ~ -48 dBFS; remote senders gate to silence
const REMOTE_SPEAKING_HANGOVER_MS = 400;
const SENDER_MAX_BITRATE = 64_000;
const SCREEN_AUDIO_MAX_BITRATE = 128_000;
/** Emit remoteScreen even if the video track never reports 'unmute' (UI shows a loading tile). */
const REMOTE_SCREEN_UNMUTE_FALLBACK_MS = 2_000;

/** Our outgoing screen share on one peer connection. */
interface ScreenSend {
  video: RTCRtpTransceiver;
  audio?: RTCRtpTransceiver;
  attached: boolean;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
  cpu: CpuWatch;
  chain: Promise<void>;
}

/** A remote screen share we are receiving on one peer connection. */
interface RemoteScreen {
  track: MediaStreamTrack;
  stream: MediaStream | null;
  dispose(): void;
}

interface PeerEntry {
  peer: Peer;
  info: PeerInfo;
  counters?: LossCounters;
  statsInFlight: boolean;
  speaking: boolean;
  remoteVad: VadGate;
  screenSend?: ScreenSend;
  remoteScreen?: RemoteScreen;
  videoCounters?: VideoCounters;
}

interface LocalShare {
  stream: MediaStream;
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  preset: ScreenSharePreset;
}

type AnyParams = RTCRtpSendParameters;

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

  // screen share
  private readonly intents = new ScreenShareIntents();
  private share: LocalShare | null = null;
  private shareGen = 0;
  private screenMsid: MediaStream | null = null;
  private readonly streamVolumes = new Map<string, number>();
  private lastViewers = "";
  private codecPrefs: Promise<{ recv: CodecLike[] | null; send: CodecLike[] | null }> | undefined;
  private codecPrefsResolved: { recv: CodecLike[] | null; send: CodecLike[] | null } | undefined;

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

  // ---------------------------------------------------------------------------
  // Screen share (public)

  async startScreenShare(stream: MediaStream, presetId: ScreenSharePresetId): Promise<void> {
    if (this.closed) throw new Error("Voice call is closed");
    const preset = SCREEN_SHARE_PRESETS[presetId];
    if (!preset) throw new Error(`Unknown screen share preset: ${presetId}`);
    const video = stream.getVideoTracks()[0];
    if (!video) throw new Error("Screen share stream has no video track");
    const audio = stream.getAudioTracks()[0] ?? null;
    const gen = ++this.shareGen;

    await applyVideoPreset(video, preset);
    await this.ensureCodecPrefs();
    if (this.closed || gen !== this.shareGen) {
      // Closed or superseded by a newer start/stop while we were awaiting.
      if (this.share?.stream !== stream) stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const old = this.share;
    this.share = { stream, video, audio, preset };
    this.intents.setSharing(true);
    video.onended = () => this.onLocalScreenEnded(stream);
    if (audio) {
      audio.onended = () => console.warn("[call-engine] screen share audio track ended");
    }
    if (old && old.stream !== stream) {
      old.video.onended = null;
      if (old.audio) old.audio.onended = null;
      for (const t of [...old.stream.getTracks(), old.video, ...(old.audio ? [old.audio] : [])]) {
        if (t !== video && t !== audio) t.stop();
      }
    }
    for (const e of this.peers.values()) e.screenSend?.cpu.reset();
    // Replacement keeps existing viewers: attach() uses replaceTrack on their transceivers.
    this.reconcileScreen(true);
  }

  async setScreenSharePreset(presetId: ScreenSharePresetId): Promise<void> {
    const preset = SCREEN_SHARE_PRESETS[presetId];
    if (!preset) throw new Error(`Unknown screen share preset: ${presetId}`);
    const share = this.share;
    if (!share || this.closed) return;
    share.preset = preset;
    for (const e of this.peers.values()) {
      e.screenSend?.cpu.reset();
      this.tuneScreen(e);
    }
    await applyVideoPreset(share.video, preset);
    for (const e of this.peers.values()) this.tuneScreen(e);
  }

  stopScreenShare(): void {
    this.shareGen++;
    const share = this.share;
    if (!share) return;
    this.share = null;
    this.intents.setSharing(false);
    share.video.onended = null;
    if (share.audio) share.audio.onended = null;
    for (const t of [...share.stream.getTracks(), share.video, ...(share.audio ? [share.audio] : [])]) t.stop();
    if (!this.closed) this.reconcileScreen(false);
  }

  isScreenSharing(): boolean {
    return !!this.share;
  }

  watchStream(userId: string, watching: boolean): void {
    if (this.closed || !userId || userId === this.selfId) return;
    const signal = this.intents.watch(userId, watching);
    // Without a connection yet, the intent is sent when the peer is created.
    if (this.peers.has(userId)) this.send(userId, signal);
    this.refreshRemoteScreen(userId);
  }

  setStreamVolume(userId: string, volume: number): void {
    const v = Number.isFinite(volume) ? Math.min(2, Math.max(0, volume)) : 1;
    this.streamVolumes.set(userId, v);
    if (!this.closed) this.audio.setStreamGain(userId, v);
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
    for (const e of this.peers.values()) {
      e.remoteScreen?.dispose();
      e.peer.close();
    }
    this.peers.clear();
    this.buffer.clear();
    if (this.share) {
      this.share.video.onended = null;
      this.share.stream.getTracks().forEach((t) => t.stop());
      this.share.audio?.stop();
      this.share = null;
    }
    this.intents.clear();
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
        mungeSdp: (sdp) => mungeOutgoingSdp(sdp, peer ? micMid(peer.pc) : null),
        localSdpTransform: () => {
          if (!peer || !hasScreenAudioTransceiver(peer.pc)) return null;
          const mid = micMid(peer.pc);
          return (sdp) => mungeLocalSdp(sdp, mid);
        },
        onTrack: (track, stream, transceiver) => {
          if (!isCurrent()) return;
          const isMic = !transceiver || peer!.pc.getTransceivers()[0] === transceiver;
          if (track.kind === "audio" && isMic) {
            this.audio.addRemote(userId, stream ?? new MediaStream([track]), this.effectiveGain(userId));
          } else {
            this.refreshRemoteScreen(userId);
          }
        },
        onNegotiated: () => {
          if (!isCurrent()) return;
          this.refreshRemoteScreen(userId);
          const e = this.peers.get(userId);
          if (e) this.tuneScreen(e);
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
    if (this.share && this.intents.shouldSendTo(userId)) this.attachScreen(entry);
    for (const signal of this.intents.signalsForNewPeer(userId)) this.send(userId, signal);
    for (const data of replay) {
      if (isStreamSignal(data)) this.onStreamSignal(userId, data.action);
      else void peer.handleSignal(data);
    }
  }

  private disposePeer(userId: string): PeerEntry | undefined {
    const e = this.peers.get(userId);
    if (!e) return undefined;
    this.peers.delete(userId);
    this.clearRemoteScreen(e, userId);
    e.peer.close();
    this.audio.removeRemote(userId);
    if (e.speaking) this.emitter.emit("speaking", { userId, speaking: false });
    return e;
  }

  private removePeer(userId: string): void {
    this.intents.peerLeft(userId);
    if (!this.disposePeer(userId)) return;
    this.buffer.drop(userId);
    this.emitter.emit("peerRemoved", { userId });
    this.emitViewers();
  }

  private resetPeer(userId: string, reason: ResetReason, replay: SignalData[]): void {
    if (this.closed) return;
    if (reason === "failed" || reason === "connect-timeout") {
      console.warn(`[call-engine] recreating connection to ${userId} (${reason})`);
    }
    this.disposePeer(userId);
    this.createPeer(userId, replay);
    this.emitViewers();
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
    if (!e) this.buffer.push(from, data, Date.now());
    else if (isStreamSignal(data)) this.onStreamSignal(from, data.action);
    else void e.peer.handleSignal(data);
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
          this.handleVideoStats(userId, e, report);
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
  // Screen share (internals)

  private onStreamSignal(from: string, action: StreamAction): void {
    this.intents.onRemoteSignal(from, action);
    this.reconcileScreen(false);
  }

  /** Attach/detach our share per peer to match intents; `replace` re-attaches current viewers (new share). */
  private reconcileScreen(replace: boolean): void {
    if (this.closed) return;
    for (const [userId, e] of this.peers) {
      const want = !!this.share && this.intents.shouldSendTo(userId);
      const s = e.screenSend;
      if (want && (!s?.attached || replace || s.videoTrack !== this.share!.video)) this.attachScreen(e);
      else if (!want && s?.attached) this.detachScreen(e);
    }
    this.emitViewers();
  }

  private screenMsidStream(): MediaStream {
    this.screenMsid ??= new MediaStream();
    return this.screenMsid;
  }

  private attachScreen(e: PeerEntry): void {
    const share = this.share;
    if (!share || e.peer.isClosed) return;
    const pc = e.peer.pc;
    const msid = this.screenMsidStream();
    try {
      let s = e.screenSend;
      if (!s) {
        const enc = screenEncoding(share.preset);
        const video = pc.addTransceiver(share.video, {
          direction: "sendonly",
          streams: [msid],
          sendEncodings: [
            {
              maxBitrate: enc.maxBitrate,
              maxFramerate: enc.maxFramerate,
              scaleResolutionDownBy: enc.scaleResolutionDownBy,
              priority: "high",
              networkPriority: "high",
            },
          ],
        });
        this.applyCodecPreferences(video);
        s = { video, attached: true, videoTrack: share.video, audioTrack: null, cpu: new CpuWatch(), chain: Promise.resolve() };
        e.screenSend = s;
      } else {
        if (s.videoTrack !== share.video || !s.attached) {
          void s.video.sender.replaceTrack(share.video).catch((err) => this.emitError("Failed to attach screen video", err));
        }
        if (s.video.direction !== "sendonly") s.video.direction = "sendonly";
        s.videoTrack = share.video;
      }
      if (share.audio) {
        if (!s.audio) {
          s.audio = pc.addTransceiver(share.audio, {
            direction: "sendonly",
            streams: [msid],
            sendEncodings: [{ maxBitrate: SCREEN_AUDIO_MAX_BITRATE, priority: "high", networkPriority: "high" }],
          });
        } else {
          if (s.audioTrack !== share.audio || !s.attached) {
            void s.audio.sender.replaceTrack(share.audio).catch((err) => this.emitError("Failed to attach screen audio", err));
          }
          if (s.audio.direction !== "sendonly") s.audio.direction = "sendonly";
        }
        s.audioTrack = share.audio;
      } else if (s.audio) {
        void s.audio.sender.replaceTrack(null).catch(() => undefined);
        if (s.audio.direction !== "inactive") s.audio.direction = "inactive";
        s.audioTrack = null;
      }
      s.attached = true;
      this.tuneScreen(e);
    } catch (err) {
      this.emitError(`Failed to share screen with ${e.info.userId}`, err);
    }
  }

  private detachScreen(e: PeerEntry): void {
    const s = e.screenSend;
    if (!s || !s.attached) return;
    s.attached = false;
    s.videoTrack = null;
    s.audioTrack = null;
    s.cpu.reset();
    if (e.peer.isClosed) return;
    try {
      // replaceTrack(null) stops the encoder immediately; 'inactive' tells the viewer (renegotiation).
      for (const t of [s.video, s.audio]) {
        if (!t) continue;
        void t.sender.replaceTrack(null).catch(() => undefined);
        if (t.direction !== "inactive") t.direction = "inactive";
      }
    } catch (err) {
      this.emitError(`Failed to stop sharing with ${e.info.userId}`, err);
    }
  }

  /** Apply encoding parameters to this peer's screen senders (serialized per peer). */
  private tuneScreen(e: PeerEntry): void {
    const s = e.screenSend;
    if (!s || !s.attached || !this.share || e.peer.isClosed) return;
    const preset = this.share.preset;
    s.chain = s.chain
      .then(async () => {
        if (!s.attached || e.peer.isClosed) return;
        const enc = screenEncoding(preset, s.cpu.downgrade);
        await updateSenderParams(
          s.video.sender,
          (p) => {
            for (const x of p.encodings) {
              x.active = true;
              x.maxBitrate = enc.maxBitrate;
              x.maxFramerate = enc.maxFramerate;
              x.scaleResolutionDownBy = enc.scaleResolutionDownBy;
              x.priority = "high";
              x.networkPriority = "high";
            }
          },
          enc.degradationPreference,
        );
        if (s.audio && s.audioTrack) {
          await updateSenderParams(s.audio.sender, (p) => {
            for (const x of p.encodings) {
              x.maxBitrate = SCREEN_AUDIO_MAX_BITRATE;
              x.priority = "high";
              x.networkPriority = "high";
            }
          });
        }
      })
      .catch((err) => console.warn("[call-engine] screen sender tuning failed", err));
  }

  private onLocalScreenEnded(stream: MediaStream): void {
    if (this.closed || this.share?.stream !== stream) return;
    this.stopScreenShare();
    this.emitter.emit("localScreenEnded", {});
  }

  private emitViewers(): void {
    if (this.closed) return;
    const ids = [...this.peers].filter(([, e]) => e.screenSend?.attached).map(([id]) => id).sort();
    const key = ids.join(",");
    if (key === this.lastViewers) return;
    this.lastViewers = key;
    this.emitter.emit("viewers", { userIds: ids });
  }

  /** Recompute what we receive from `userId` (screen video + audio) from the transceivers. */
  private refreshRemoteScreen(userId: string): void {
    const e = this.peers.get(userId);
    if (!e || this.closed) return;
    let video: MediaStreamTrack | undefined;
    let audio: MediaStreamTrack | undefined;
    if (this.intents.isWatching(userId) && !e.peer.isClosed) {
      const all = e.peer.pc.getTransceivers();
      for (let i = 1; i < all.length; i++) {
        const t = all[i];
        const dir = t.currentDirection;
        if (dir !== "recvonly" && dir !== "sendrecv") continue;
        const track = t.receiver.track;
        if (track?.kind === "video" && !video) video = track;
        else if (track?.kind === "audio" && !audio) audio = track;
      }
    }
    if (audio) this.audio.addStreamAudio(userId, audio, this.streamVolumes.get(userId) ?? 1);
    else this.audio.removeStreamAudio(userId);

    const current = e.remoteScreen;
    if (current && current.track === video) return;
    if (current) this.clearRemoteScreen(e, userId, false);
    if (!video) return;

    const track = video;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rs: RemoteScreen = {
      track,
      stream: null,
      dispose: () => {
        track.removeEventListener("unmute", emit);
        if (timer) clearTimeout(timer);
      },
    };
    const emit = () => {
      if (e.remoteScreen !== rs || rs.stream || this.closed) return;
      rs.dispose();
      rs.stream = new MediaStream([track]);
      this.emitter.emit("remoteScreen", { userId, stream: rs.stream });
    };
    e.remoteScreen = rs;
    if (!track.muted) {
      emit();
    } else {
      track.addEventListener("unmute", emit);
      timer = setTimeout(emit, REMOTE_SCREEN_UNMUTE_FALLBACK_MS);
    }
  }

  private clearRemoteScreen(e: PeerEntry, userId: string, withAudio = true): void {
    if (withAudio) this.audio.removeStreamAudio(userId);
    const rs = e.remoteScreen;
    if (!rs) return;
    e.remoteScreen = undefined;
    e.videoCounters = undefined;
    rs.dispose();
    if (rs.stream) this.emitter.emit("remoteScreen", { userId, stream: null });
  }

  private handleVideoStats(userId: string, e: PeerEntry, report: RTCStatsReport): void {
    const s = e.screenSend;
    const sending = !!s?.attached && !!this.share;
    const receiving = !!e.remoteScreen?.stream;
    if (!sending && !receiving) {
      e.videoCounters = undefined;
      return;
    }
    const v = parseVideoStats(report, e.videoCounters);
    e.videoCounters = v.counters;
    if (sending && v.send && this.share) {
      const { bytes: _b, ...rest } = v.send;
      this.emitter.emit("streamStats", { userId: this.selfId, direction: "send", viewerId: userId, ...rest });
      const next = s!.cpu.update(v.send.qualityLimitation, this.share.preset, Date.now());
      if (next) {
        console.warn(
          `[call-engine] encoder CPU-limited for >10s sending to ${userId} at preset ${this.share.preset.id}: ` +
            `maxFramerate x${next.fpsFactor}, scaleResolutionDownBy ${next.scale}`,
        );
        this.tuneScreen(e);
      }
    }
    if (receiving && v.recv) {
      const { bytes: _b, ...rest } = v.recv;
      this.emitter.emit("streamStats", { userId, direction: "recv", ...rest });
    }
  }

  /** Compute (once) the video codec preference order, probing hardware encoders. */
  private ensureCodecPrefs(): Promise<unknown> {
    this.codecPrefs ??= computeCodecPrefs().then((r) => {
      this.codecPrefsResolved = r;
      return r;
    });
    return this.codecPrefs;
  }

  private applyCodecPreferences(t: RTCRtpTransceiver): void {
    const prefs = this.codecPrefsResolved;
    if (!prefs || typeof t.setCodecPreferences !== "function") return;
    for (const list of [prefs.recv, prefs.send]) {
      if (!list) continue;
      try {
        t.setCodecPreferences(list as RTCRtpCodec[]);
        return;
      } catch {
        /* try the next list */
      }
    }
    console.warn("[call-engine] setCodecPreferences rejected; using the default codec order");
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

// ---------------------------------------------------------------------------
// helpers

function micMid(pc: RTCPeerConnection): string | null {
  try {
    return pc.getTransceivers()[0]?.mid ?? null;
  } catch {
    return null;
  }
}

function hasScreenAudioTransceiver(pc: RTCPeerConnection): boolean {
  try {
    return pc.getTransceivers().some((t, i) => i > 0 && t.receiver.track?.kind === "audio");
  } catch {
    return false;
  }
}

/** contentHint + applyConstraints (max values only: never upscale). */
async function applyVideoPreset(track: MediaStreamTrack, preset: ScreenSharePreset): Promise<void> {
  try {
    track.contentHint = preset.contentHint;
  } catch {
    /* ignore */
  }
  try {
    await track.applyConstraints({
      width: { max: preset.maxWidth },
      height: { max: preset.maxHeight },
      frameRate: { max: preset.frameRate, ideal: preset.frameRate },
    });
  } catch (err) {
    console.warn("[call-engine] screen track applyConstraints failed", err);
  }
}

/** getParameters -> mutate -> setParameters; retries without degradationPreference if rejected. */
async function updateSenderParams(
  sender: RTCRtpSender,
  mutate: (p: AnyParams) => void,
  degradationPreference?: RTCDegradationPreference,
): Promise<boolean> {
  for (const withPref of degradationPreference ? [true, false] : [false]) {
    const p = sender.getParameters() as AnyParams;
    if (!p.encodings || p.encodings.length === 0) return false; // not negotiated yet; retried later
    mutate(p);
    if (withPref) p.degradationPreference = degradationPreference;
    try {
      await sender.setParameters(p);
      return true;
    } catch (err) {
      if (!withPref) throw err;
    }
  }
  return false;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function computeCodecPrefs(): Promise<{ recv: CodecLike[] | null; send: CodecLike[] | null }> {
  const recvCaps = (globalThis.RTCRtpReceiver?.getCapabilities?.("video")?.codecs ?? null) as CodecLike[] | null;
  const sendCaps = (globalThis.RTCRtpSender?.getCapabilities?.("video")?.codecs ?? null) as CodecLike[] | null;
  if (!recvCaps || !sendCaps) return { recv: null, send: null };
  const sendable = new Set(sendCaps.map((c) => codecName(c.mimeType)));

  // Hardware encoders: mediaCapabilities.encodingInfo(...).powerEfficient.
  const hardware = new Set<string>();
  const mc = (globalThis.navigator as Navigator | undefined)?.mediaCapabilities;
  if (mc?.encodingInfo) {
    const best = new Map<string, CodecLike>();
    for (const c of sendCaps) {
      const name = codecName(c.mimeType);
      if (!SCREEN_CODEC_ORDER.includes(name)) continue;
      const prev = best.get(name);
      if (!prev || (name === "H264" && h264Rank(c.sdpFmtpLine) < h264Rank(prev.sdpFmtpLine))) best.set(name, c);
    }
    await Promise.all(
      [...best].map(async ([name, c]) => {
        try {
          const info = await withTimeout(
            mc.encodingInfo({
              type: "webrtc",
              video: { contentType: mediaCapabilitiesContentType(c), width: 1920, height: 1080, bitrate: 6_000_000, framerate: 60 },
            } as MediaEncodingConfiguration),
            1500,
          );
          if (info?.supported && info.powerEfficient) hardware.add(name);
        } catch {
          /* unknown -> treat as software */
        }
      }),
    );
  }
  const recv = orderVideoCodecs(recvCaps, { hardware, sendable });
  const send = orderVideoCodecs(sendCaps, { hardware, sendable });
  console.info(
    `[call-engine] screen codec order: ${recv
      .filter((c) => !/rtx|red|ulpfec|flexfec/i.test(c.mimeType))
      .map((c) => codecName(c.mimeType) + (c.sdpFmtpLine?.includes("profile-level-id") ? `(${/profile-level-id=(\w+)/.exec(c.sdpFmtpLine)?.[1]})` : ""))
      .join(" > ")}; hardware: [${[...hardware].join(",") || "none"}]`,
  );
  return { recv, send };
}
