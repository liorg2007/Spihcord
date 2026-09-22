/**
 * Public API of the call engine. The desktop app codes against this file only;
 * the implementation lives in the rest of this package.
 */
import type { IceServer, SignalData } from "@shpihcord/protocol";

/** How the engine sends/receives WebRTC signals (backed by the hub WebSocket). */
export interface SignalingTransport {
  send(to: string, data: SignalData): void;
  /** Subscribe to incoming signals. Returns an unsubscribe function. */
  onSignal(handler: (from: string, data: SignalData) => void): () => void;
}

export interface VoiceCallOptions {
  selfId: string;
  iceServers: IceServer[];
  signaling: SignalingTransport;
  /** Force TURN relay to hide the local IP from peers. */
  forceRelay?: boolean;
  inputDeviceId?: string;
  outputDeviceId?: string;
  inputMode?: InputMode;
  /** 0..1, threshold on the normalized mic level for voice activity. */
  vadThreshold?: number;
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
}

export type InputMode = "voice-activity" | "push-to-talk";

export type PeerRoute = "direct" | "relay" | "unknown";

export interface PeerInfo {
  userId: string;
  /** RTCPeerConnection.connectionState */
  connectionState: RTCPeerConnectionState;
  route: PeerRoute;
  /** Round-trip time in ms (from the selected ICE candidate pair), if known. */
  rttMs?: number;
  /** Inbound audio packet loss percentage over the last stats window. */
  lossPct?: number;
  /** 0..2 playback volume set by the local user (1 = 100%). */
  volume: number;
  locallyMuted: boolean;
}

export interface VoiceCallEvents {
  /** Any change to a peer's connection info or stats. */
  peer: PeerInfo;
  peerRemoved: { userId: string };
  /** Speaking indicator, including the local user (selfId). */
  speaking: { userId: string; speaking: boolean };
  /** Local mic level 0..1, ~20 Hz, for the settings meter. */
  localLevel: { level: number };
  error: { message: string; cause?: unknown };
}

export interface VoiceCall {
  /** Acquire the mic and start the audio pipeline. Must be called before peers connect. */
  start(): Promise<void>;
  /**
   * Declaratively set the other users currently in our voice channel.
   * The engine creates/tears down peer connections to match.
   */
  syncPeers(userIds: string[]): void;

  setMuted(muted: boolean): void;
  /** Deafen mutes all incoming audio (and implies mute). */
  setDeafened(deafened: boolean): void;
  setInputMode(mode: InputMode): void;
  /** Push-to-talk key state; ignored in voice-activity mode. */
  setPushToTalk(active: boolean): void;
  setVadThreshold(threshold: number): void;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  setPeerVolume(userId: string, volume: number): void;
  setPeerMuted(userId: string, muted: boolean): void;
  /** Swap ICE servers (e.g. after ice.refresh); applies to new connections and ICE restarts. */
  setIceServers(iceServers: IceServer[]): void;

  getPeers(): PeerInfo[];

  on<K extends keyof VoiceCallEvents>(event: K, handler: (payload: VoiceCallEvents[K]) => void): () => void;

  /** Hang up: close all peer connections, stop the mic, release audio resources. */
  close(): void;
}

export type CreateVoiceCall = (options: VoiceCallOptions) => VoiceCall;
