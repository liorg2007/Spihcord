/**
 * Web Audio graph (browser only).
 *
 * Local:  mic -> MediaStreamSource -> Analyser (level/VAD)
 *                                  \-> Gate GainNode -> MediaStreamDestination (track sent to all peers)
 * Remote: <audio muted> + MediaStreamSource -> Analyser (speaking) -> peer Gain -> master Gain -> ctx.destination
 * Screen: <audio muted> + MediaStreamSource -> stream Gain -> Analyser (diagnostics only) -> master Gain
 *         (separate per-user volume; never feeds the speaking indicator; deafen = master)
 */
import { rms, levelFromRms } from "./vad";

export interface MicSettings {
  deviceId?: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

interface RemoteNode {
  stream: MediaStream;
  trackId: string;
  element: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  gain: GainNode;
}

type SinkCapableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

const GATE_ATTACK_TC = 0.005; // s (time constant for setTargetAtTime)
const GATE_RELEASE_TC = 0.04;
const REMOTE_GAIN_TC = 0.02;

export class AudioEngine {
  readonly ctx: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly gate: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly master: GainNode;
  private readonly analysisBuf: Float32Array<ArrayBuffer>;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private readonly remotes = new Map<string, RemoteNode>();
  private readonly streamAudio = new Map<string, RemoteNode>();
  private gateOpen = false;
  private closed = false;
  private sinkId: string | undefined;

  constructor(private readonly onError: (message: string, cause?: unknown) => void) {
    this.ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    this.destination = this.ctx.createMediaStreamDestination();
    this.destination.channelCount = 1;
    this.gate = this.ctx.createGain();
    this.gate.gain.value = 0;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.analysisBuf = new Float32Array(this.analyser.fftSize);
    this.gate.connect(this.destination);

    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    this.ctx.onstatechange = () => {
      if (!this.closed && this.ctx.state === "suspended") void this.resume();
    };
  }

  /** The track sent to every peer. Stable for the lifetime of the engine. */
  get localTrack(): MediaStreamTrack {
    return this.destination.stream.getAudioTracks()[0];
  }

  get localStream(): MediaStream {
    return this.destination.stream;
  }

  get hasMic(): boolean {
    return !!this.micSource;
  }

  async resume(): Promise<void> {
    if (this.closed || this.ctx.state === "running") return;
    try {
      await this.ctx.resume();
    } catch (err) {
      this.onError("Failed to resume AudioContext", err);
    }
  }

  /** Acquire (or re-acquire) the microphone and connect it to the graph. */
  async setMic(settings: MicSettings): Promise<void> {
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: settings.deviceId && settings.deviceId !== "default" ? { exact: settings.deviceId } : undefined,
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        channelCount: 1,
      },
      video: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const source = this.ctx.createMediaStreamSource(stream);
    const oldSource = this.micSource;
    const oldStream = this.micStream;
    source.connect(this.analyser);
    source.connect(this.gate);
    this.micSource = source;
    this.micStream = stream;
    if (oldSource) {
      try {
        oldSource.disconnect();
      } catch {
        /* ignore */
      }
    }
    oldStream?.getTracks().forEach((t) => t.stop());
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => {
        if (!this.closed && this.micStream === stream) this.onError("Microphone disconnected");
      };
    }
  }

  /** Normalized 0..1 raw mic level (pre-gate). */
  readLocalLevel(): number {
    if (!this.micSource) return 0;
    this.analyser.getFloatTimeDomainData(this.analysisBuf);
    return levelFromRms(rms(this.analysisBuf));
  }

  /** Open/close the transmit gate with a short ramp (no renegotiation). */
  setGate(open: boolean): void {
    if (this.closed || open === this.gateOpen) return;
    this.gateOpen = open;
    const now = this.ctx.currentTime;
    const g = this.gate.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(open ? 1 : 0, now, open ? GATE_ATTACK_TC : GATE_RELEASE_TC);
  }

  /** Hard mute of the outgoing track (sends silence, no renegotiation). */
  setSendEnabled(enabled: boolean): void {
    const t = this.localTrack;
    if (t) t.enabled = enabled;
  }

  setDeafened(deafened: boolean): void {
    if (this.closed) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(deafened ? 0 : 1, now, REMOTE_GAIN_TC);
  }

  addRemote(userId: string, stream: MediaStream, gain: number): void {
    if (this.closed) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const existing = this.remotes.get(userId);
    if (existing && existing.trackId === track.id && existing.stream === stream) return;
    this.removeRemote(userId);

    // Chromium only pulls audio out of a remote WebRTC stream if it is also
    // attached to a media element; keep it muted, playback goes via Web Audio.
    const element = new Audio();
    element.muted = true;
    element.autoplay = true;
    element.srcObject = stream;
    element.play().catch(() => {
      /* muted element; failure is harmless */
    });

    const source = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    source.connect(analyser);
    analyser.connect(g);
    g.connect(this.master);
    this.remotes.set(userId, { stream, trackId: track.id, element, source, analyser, gain: g });
    void this.resume();
  }

  removeRemote(userId: string): void {
    const r = this.remotes.get(userId);
    if (!r) return;
    this.remotes.delete(userId);
    for (const n of [r.source, r.analyser, r.gain]) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    r.element.pause();
    r.element.srcObject = null;
    r.element.remove();
  }

  setRemoteGain(userId: string, gain: number): void {
    const r = this.remotes.get(userId);
    if (!r || this.closed) return;
    const now = this.ctx.currentTime;
    r.gain.gain.cancelScheduledValues(now);
    r.gain.gain.setTargetAtTime(gain, now, REMOTE_GAIN_TC);
  }

  hasRemote(userId: string): boolean {
    return this.remotes.has(userId);
  }

  /** Normalized 0..1 level of a remote stream (pre volume/mute), or 0. */
  readRemoteLevel(userId: string): number {
    const r = this.remotes.get(userId);
    if (!r) return 0;
    r.analyser.getFloatTimeDomainData(this.analysisBuf);
    return levelFromRms(rms(this.analysisBuf));
  }

  remoteUserIds(): string[] {
    return [...this.remotes.keys()];
  }

  // --- screen-share audio ----------------------------------------------------

  /** Play a remote screen share's audio track (stereo) with its own gain. */
  addStreamAudio(userId: string, track: MediaStreamTrack, gain: number): void {
    if (this.closed) return;
    const existing = this.streamAudio.get(userId);
    if (existing && existing.trackId === track.id) return;
    this.removeStreamAudio(userId);
    const stream = new MediaStream([track]);
    const element = new Audio();
    element.muted = true; // Chromium workaround, see addRemote
    element.autoplay = true;
    element.srcObject = stream;
    element.play().catch(() => {
      /* harmless */
    });
    const source = this.ctx.createMediaStreamSource(stream);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    source.connect(g);
    g.connect(this.master);
    g.connect(analyser);
    this.streamAudio.set(userId, { stream, trackId: track.id, element, source, analyser, gain: g });
    void this.resume();
  }

  removeStreamAudio(userId: string): void {
    const r = this.streamAudio.get(userId);
    if (!r) return;
    this.streamAudio.delete(userId);
    for (const n of [r.source, r.analyser, r.gain]) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    r.element.pause();
    r.element.srcObject = null;
    r.element.remove();
  }

  setStreamGain(userId: string, gain: number): void {
    const r = this.streamAudio.get(userId);
    if (!r || this.closed) return;
    const now = this.ctx.currentTime;
    r.gain.gain.cancelScheduledValues(now);
    r.gain.gain.setTargetAtTime(gain, now, REMOTE_GAIN_TC);
  }

  hasStreamAudio(userId: string): boolean {
    return this.streamAudio.has(userId);
  }

  /** Normalized 0..1 level of a remote screen share's audio after its volume (diagnostics / tests). */
  readStreamLevel(userId: string): number {
    const r = this.streamAudio.get(userId);
    if (!r) return 0;
    r.analyser.getFloatTimeDomainData(this.analysisBuf);
    return levelFromRms(rms(this.analysisBuf));
  }

  /** Route output to a device. Returns false if unsupported. */
  async setSinkId(deviceId: string): Promise<boolean> {
    this.sinkId = deviceId;
    const ctx = this.ctx as SinkCapableContext;
    if (typeof ctx.setSinkId !== "function") return false;
    await ctx.setSinkId(deviceId === "default" ? "" : deviceId);
    return true;
  }

  get currentSinkId(): string | undefined {
    return this.sinkId;
  }

  close(): void {
    if (this.closed) return;
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
    for (const id of [...this.streamAudio.keys()]) this.removeStreamAudio(id);
    this.closed = true;
    this.ctx.onstatechange = null;
    try {
      this.micSource?.disconnect();
    } catch {
      /* ignore */
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micSource = null;
    this.destination.stream.getTracks().forEach((t) => t.stop());
    this.ctx.close().catch(() => {
      /* ignore */
    });
  }
}
