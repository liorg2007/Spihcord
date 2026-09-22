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

// ---------------------------------------------------------------------------
// Screen share
// ---------------------------------------------------------------------------

export type ScreenSharePresetId = "text" | "balanced" | "gaming" | "source";

export interface ScreenSharePreset {
  id: ScreenSharePresetId;
  label: string;
  /** Max capture size; the source is never upscaled. */
  maxWidth: number;
  maxHeight: number;
  frameRate: number;
  /** Per-viewer video bitrate cap, bits/s. */
  maxBitrate: number;
  contentHint: "motion" | "detail" | "text";
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** How much of a remote camera the viewer wants (drives the sender's per-viewer encoding). */
export type CameraPreference = "off" | "low" | "high";

export interface StreamStats {
  /** The sharer (for "recv", the remote user; for "send", selfId). */
  userId: string;
  direction: "send" | "recv";
  /** Which video this is. Omitted = "screen" (backwards compatible). */
  kind?: "screen" | "camera";
  /** For "send": which viewer this encoding goes to. */
  viewerId?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  /** e.g. "AV1", "H264", "VP9", "VP8". */
  codec?: string;
  /** RTCOutboundRtpStreamStats.qualityLimitationReason ("send" only). */
  qualityLimitation?: "none" | "cpu" | "bandwidth" | "other";
}

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

  /**
   * A remote screen share we are watching became available (stream != null) or went
   * away (null). The stream holds the video track (attach to a <video muted>);
   * its audio is played by the engine (see setStreamVolume), never by the element.
   */
  remoteScreen: { userId: string; stream: MediaStream | null };
  /** Our local share stopped on its own (e.g. the captured window closed / OS "Stop sharing"). */
  localScreenEnded: Record<string, never>;
  /** Users currently receiving our screen share. */
  viewers: { userIds: string[] };
  /** ~every 2s per active screen or camera stream (sent or received). */
  streamStats: StreamStats;

  /**
   * A remote user's camera became available (stream != null, video-only, attach to
   * <video muted>) or went away / was turned off (null).
   */
  remoteCamera: { userId: string; stream: MediaStream | null };
  /** Local camera preview (null when off). Same track that is sent; render mirrored. */
  localCamera: { stream: MediaStream | null };
  /** Our local camera stopped on its own (device unplugged / permission revoked). */
  localCameraEnded: Record<string, never>;
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

  /**
   * Start sharing a captured screen/window. The app obtains `stream` (video track
   * + optional system-audio track) via getDisplayMedia; the engine takes ownership
   * (stops the tracks on stopScreenShare/close). Nothing is sent until a peer
   * calls watch; then video+audio tracks are added to that peer only.
   * Replaces a previous share if one is active.
   */
  startScreenShare(stream: MediaStream, preset: ScreenSharePresetId): Promise<void>;
  /** Change quality live (applyConstraints + sender parameters for all viewers). */
  setScreenSharePreset(preset: ScreenSharePresetId): Promise<void>;
  stopScreenShare(): void;
  isScreenSharing(): boolean;
  /** Ask a sharer in our channel to start/stop sending us their screen. */
  watchStream(userId: string, watching: boolean): void;
  /** 0..2 playback volume of a remote screen share's audio. */
  setStreamVolume(userId: string, volume: number): void;

  /**
   * Turn the camera on (getUserMedia inside the engine) and send it to every peer.
   * Rejects on permission/device errors. No-op if already on with the same device.
   */
  startCamera(deviceId?: string): Promise<void>;
  /** Turn the camera off and release the capture device (camera light goes off). */
  stopCamera(): void;
  isCameraOn(): boolean;
  /** Switch camera device live (no renegotiation); remembered for the next startCamera. */
  setCameraDevice(deviceId: string): Promise<void>;
  /** Tell a sender how much of their camera we want. Default "high". Remembered per user. */
  setCameraPreference(userId: string, preference: CameraPreference): void;

  on<K extends keyof VoiceCallEvents>(event: K, handler: (payload: VoiceCallEvents[K]) => void): () => void;

  /** Hang up: close all peer connections, stop the mic, release audio resources. */
  close(): void;
}

export type CreateVoiceCall = (options: VoiceCallOptions) => VoiceCall;
