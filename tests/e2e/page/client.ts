/**
 * Browser side of the voice e2e test. A minimal hub client (HTTP auth, WS auth,
 * pong, voice.join/leave, rtc.signal relay) driving the real call engine.
 * The Electron main process drives it through `window.harness`.
 */
import { certificateFingerprint, createVoiceCall, type PeerInfo, type ScreenSharePresetId, type VoiceCall } from "@shpihcord/call-engine";
import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type AuthResponse,
  type Channel,
  type ClientMessage,
  type ServerMessage,
  type SignalData,
  type VoiceState,
} from "@shpihcord/protocol";

// ---------------------------------------------------------------------------
// Track every RTCPeerConnection the engine creates and learn which remote user
// it belongs to (from the remote description, which only arrives via our
// signaling adapter, so we can map sdp -> sender).

type TrackedPc = RTCPeerConnection & { __remoteUser?: string; __id?: number };
let pcSeq = 0;
/** Debug trail of signaling (sent/received) and pc state changes. */
const sigLog: string[] = [];
const ms = () => Math.round(performance.now());
const sigDesc = (d: SignalData) =>
  d.kind === "description"
    ? `desc:${d.description.type}`
    : d.kind === "stream"
      ? `stream:${d.action}`
      : d.kind === "video-pref"
        ? `video-pref:${d.camera}`
        : d.candidate
          ? "cand"
          : "cand:end";
/** Offers sent + received (renegotiation counter). */
let offerCount = 0;

// Independent level meter per remote user (own AudioContext, analyser only, not played).
let meterCtx: AudioContext | null = null;
const meters = new Map<string, { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> }>();
const pendingMeters = new Map<TrackedPc, MediaStream>();
function meterRemote(pc: TrackedPc, stream: MediaStream): void {
  if (!pc.__remoteUser) {
    pendingMeters.set(pc, stream);
    return;
  }
  meterCtx ??= new AudioContext();
  void meterCtx.resume();
  const src = meterCtx.createMediaStreamSource(stream);
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  meters.set(pc.__remoteUser, { analyser, buf: new Float32Array(analyser.fftSize) });
}
function readMeter(userId: string): number {
  const m = meters.get(userId);
  if (!m) return -1;
  m.analyser.getFloatTimeDomainData(m.buf);
  let peak = 0;
  for (const v of m.buf) peak = Math.max(peak, Math.abs(v));
  return peak;
}
const allPcs: TrackedPc[] = [];
/** receiver track id -> msid stream ids seen in its track event */
const trackStreams = new Map<string, string[]>();
const sdpSender = new Map<string, string>();

const NativePc = window.RTCPeerConnection;
class TrackingPc extends NativePc {
  __id = ++pcSeq;
  constructor(config?: RTCConfiguration) {
    super(config);
    allPcs.push(this);
    this.addEventListener("track", (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      trackStreams.set(ev.track.id, ev.streams.map((s) => s.id));
      // Only the mic (first transceiver) feeds the voice meter; screen audio is measured separately.
      const isMic = this.getTransceivers()[0] === ev.transceiver;
      if (ev.track.kind === "audio" && isMic) meterRemote(this as TrackedPc, stream);
    });
    this.addEventListener("signalingstatechange", () => sigLog.push(`${ms()} pc${this.__id}(${(this as TrackedPc).__remoteUser ?? "?"}) signaling=${this.signalingState}`));
    this.addEventListener("connectionstatechange", () => sigLog.push(`${ms()} pc${this.__id}(${(this as TrackedPc).__remoteUser ?? "?"}) conn=${this.connectionState}`));
  }
  override setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    const who = desc?.sdp ? sdpSender.get(desc.sdp) : undefined;
    if (who) (this as TrackedPc).__remoteUser = who;
    const pending = pendingMeters.get(this as TrackedPc);
    if (who && pending) {
      pendingMeters.delete(this as TrackedPc);
      meterRemote(this as TrackedPc, pending);
    }
    return super.setRemoteDescription(desc);
  }
}
(window as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection = TrackingPc;

// ---------------------------------------------------------------------------

interface LogEvent {
  t: number;
  type: string;
  [k: string]: unknown;
}

let hubUrl = "";
let ws: WebSocket | null = null;
let selfId = "";
let call: VoiceCall | null = null;
let channels: Channel[] = [];
const voiceStates = new Map<string, VoiceState>();
const signalHandlers = new Set<(from: string, data: SignalData) => void>();
const events: LogEvent[] = [];
const t0 = performance.now();

function log(type: string, extra: Record<string, unknown> = {}): void {
  events.push({ t: Math.round(performance.now() - t0), type, ...extra });
  if (events.length > 5000) events.splice(0, 1000);
}

function wsSend(msg: ClientMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("ws not open");
  ws.send(JSON.stringify(msg));
}

function myChannel(): string | undefined {
  return voiceStates.get(selfId)?.channelId;
}

/** Declaratively tell the engine who else is in our voice channel. */
function syncPeers(): void {
  if (!call) return;
  const ch = myChannel();
  const ids = ch ? [...voiceStates.values()].filter((v) => v.channelId === ch && v.userId !== selfId).map((v) => v.userId) : [];
  call.syncPeers(ids);
}

function onServer(msg: ServerMessage): void {
  switch (msg.type) {
    case "ping":
      wsSend({ type: "pong" });
      return;
    case "voice.state":
      sigLog.push(`${ms()} voice.state ${msg.voiceState.userId} ${msg.voiceState.channelId}`);
      voiceStates.set(msg.voiceState.userId, msg.voiceState);
      syncPeers();
      return;
    case "voice.left":
      sigLog.push(`${ms()} voice.left ${msg.userId}`);
      voiceStates.delete(msg.userId);
      syncPeers();
      return;
    case "rtc.signal":
      if (msg.data.kind === "description" && msg.data.description.sdp) sdpSender.set(msg.data.description.sdp, msg.from);
      if (msg.data.kind === "description" && msg.data.description.type === "offer") offerCount++;
      sigLog.push(`${ms()} <- ${msg.from} ${sigDesc(msg.data)}`);
      for (const h of signalHandlers) h(msg.from, msg.data);
      return;
    case "error":
      log("hubError", { code: msg.code, message: msg.message });
      return;
    default:
      return;
  }
}

async function http(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------------------
// Identity pinning (like the desktop app: long-term cert + TOFU pins in memory)

let certificate: RTCCertificate | undefined;
const pins = new Map<string, string>();
const lastMismatch = new Map<string, string>();

function genCert(): Promise<RTCCertificate> {
  return RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256", expires: 365 * 86400e3 } as EcKeyGenParams);
}

function verifyFingerprint(userId: string, fp: string) {
  const pinned = pins.get(userId);
  if (!pinned) {
    pins.set(userId, fp);
    return { trusted: true as const };
  }
  return pinned === fp ? { trusted: true as const } : { trusted: false as const, expected: pinned };
}

async function init(opts: { hubUrl: string; username: string; password: string; invite: string; pinning?: boolean }) {
  hubUrl = opts.hubUrl;
  if (opts.pinning !== false) certificate = await genCert();
  let r = await http("/api/register", { username: opts.username, password: opts.password, inviteCode: opts.invite });
  if (r.status === 409) r = await http("/api/login", { username: opts.username, password: opts.password });
  if (r.status >= 300) throw new Error(`auth failed ${r.status} ${JSON.stringify(r.json)}`);
  const auth = r.json as AuthResponse;
  selfId = auth.user.id;

  const wsUrl = hubUrl.replace(/^http/, "ws") + "/ws";
  const ready = await new Promise<ServerMessage & { type: "ready" }>((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    ws = sock;
    let isReady = false;
    sock.onopen = () => sock.send(JSON.stringify({ type: "auth", token: auth.token, protocolVersion: PROTOCOL_VERSION }));
    sock.onerror = () => reject(new Error("ws error"));
    sock.onclose = (ev) => {
      log("wsClose", { code: ev.code, reason: ev.reason });
      if (!isReady) reject(new Error(`ws closed ${ev.code}`));
    };
    sock.onmessage = (ev) => {
      const parsed = ServerMessageSchema.safeParse(JSON.parse(String(ev.data)));
      if (!parsed.success) {
        log("badServerMessage", { raw: String(ev.data).slice(0, 200) });
        return;
      }
      const msg = parsed.data;
      if (msg.type === "ready") {
        isReady = true;
        resolve(msg);
        return;
      }
      onServer(msg);
    };
  });
  channels = ready.channels;
  for (const v of ready.voiceStates) voiceStates.set(v.userId, v);

  call = createVoiceCall({
    selfId,
    iceServers: ready.iceServers,
    ...(certificate ? { certificate, verifyFingerprint } : {}),
    signaling: {
      send: (to, data) => {
        sigLog.push(`${ms()} -> ${to} ${sigDesc(data)}`);
        if (data.kind === "description" && data.description.type === "offer") offerCount++;
        wsSend({ type: "rtc.signal", to, data });
      },
      onSignal: (h) => {
        signalHandlers.add(h);
        return () => signalHandlers.delete(h);
      },
    },
  });
  call.on("peer", (p) => log("peer", { userId: p.userId, state: p.connectionState, route: p.route }));
  call.on("peerRemoved", (p) => log("peerRemoved", { userId: p.userId }));
  call.on("speaking", (s) => log("speaking", { userId: s.userId, speaking: s.speaking }));
  call.on("error", (e) => log("error", { message: e.message, cause: String(e.cause ?? "") }));
  call.on("remoteScreen", ({ userId, stream }) => {
    remoteScreens.set(userId, stream);
    const v = stream?.getVideoTracks()[0];
    log("remoteScreen", {
      userId,
      stream: !!stream,
      tracks: stream ? stream.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted ? "muted" : "live"}`).join(",") : "",
      videoTrackId: v?.id ?? null,
    });
  });
  call.on("identityMismatch", (m) => {
    lastMismatch.set(m.userId, m.received);
    log("identityMismatch", { ...m });
  });
  call.on("viewers", ({ userIds }) => log("viewers", { userIds }));
  call.on("streamStats", (st) => log("streamStats", { ...st }));
  call.on("localScreenEnded", () => log("localScreenEnded"));
  call.on("remoteCamera", ({ userId, stream }) => {
    remoteCameras.set(userId, stream);
    const v = stream?.getVideoTracks()[0];
    log("remoteCamera", { userId, stream: !!stream, tracks: stream ? stream.getTracks().map((t) => `${t.kind}:${t.readyState}`).join(",") : "", videoTrackId: v?.id ?? null, streamId: stream?.id ?? null });
  });
  call.on("localCamera", ({ stream }) => {
    if (stream) localCamTracks.push(stream.getVideoTracks()[0]);
    log("localCamera", { stream: !!stream });
  });
  call.on("localCameraEnded", () => log("localCameraEnded"));
  let maxLocal = 0;
  call.on("localLevel", ({ level }) => {
    if (level > maxLocal) maxLocal = level;
  });
  (window as any).__maxLocal = () => {
    const m = maxLocal;
    maxLocal = 0;
    return m;
  };
  await call.start();
  return { userId: selfId, iceServers: ready.iceServers, channels };
}

function join(channelId: string): void {
  wsSend({ type: "voice.join", channelId });
}

function leave(): void {
  wsSend({ type: "voice.leave" });
}

function setMuted(muted: boolean): void {
  call?.setMuted(muted);
  if (myChannel()) wsSend({ type: "voice.update", muted, deafened: false });
}

function peers(): PeerInfo[] {
  return call ? call.getPeers() : [];
}

interface Inbound {
  bytesReceived: number;
  packetsReceived: number;
  audioLevel: number;
  totalAudioEnergy: number;
  totalSamplesDuration: number;
}

/** inbound-rtp audio stats per remote user (live connections only). */
async function inbound(): Promise<Record<string, Inbound>> {
  const out: Record<string, Inbound> = {};
  for (const pc of allPcs) {
    if (pc.connectionState === "closed" || pc.signalingState === "closed" || !pc.__remoteUser) continue;
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      continue;
    }
    const micMid = pc.getTransceivers()[0]?.mid;
    report.forEach((s: any) => {
      // Mic only (first transceiver); screen-share audio has its own m-line.
      if (s.type === "inbound-rtp" && (s.kind ?? s.mediaType) === "audio" && (s.mid === undefined || s.mid === micMid)) {
        out[pc.__remoteUser!] = {
          bytesReceived: s.bytesReceived ?? 0,
          packetsReceived: s.packetsReceived ?? 0,
          audioLevel: s.audioLevel ?? 0,
          totalAudioEnergy: s.totalAudioEnergy ?? 0,
          totalSamplesDuration: s.totalSamplesDuration ?? 0,
        };
      }
    });
  }
  return out;
}

/**
 * Sample inbound stats for `ms`. Per remote: bytes delta, max instantaneous
 * audioLevel, and RMS level over the window from totalAudioEnergy.
 */
async function sampleAudio(durationMs: number) {
  const start = await inbound();
  const maxLevel: Record<string, number> = {};
  const meterPeak: Record<string, number> = {};
  const speakingOn: Record<string, number> = {};
  const offSpeaking = call!.on("speaking", (s) => {
    if (s.speaking) speakingOn[s.userId] = (speakingOn[s.userId] ?? 0) + 1;
  });
  const buckets: Record<string, number[]> = {};
  const tStart = performance.now();
  const meterTimer = setInterval(() => {
    const b = Math.floor((performance.now() - tStart) / 250);
    for (const u of meters.keys()) {
      const v = readMeter(u);
      meterPeak[u] = Math.max(meterPeak[u] ?? 0, v);
      const arr = (buckets[u] ??= []);
      while (arr.length <= b) arr.push(0);
      arr[b] = Math.max(arr[b], v);
    }
  }, 10);
  const end = performance.now() + durationMs;
  let last = start;
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    last = await inbound();
    for (const [u, s] of Object.entries(last)) maxLevel[u] = Math.max(maxLevel[u] ?? 0, s.audioLevel);
  }
  clearInterval(meterTimer);
  offSpeaking();
  const out: Record<string, { bytes: number; packets: number; maxLevel: number; rmsLevel: number; samplesDur: number; meterPeak: number; speakingOn: number; timeline: string }> = {};
  for (const [u, s] of Object.entries(last)) {
    const a = start[u];
    const dE = s.totalAudioEnergy - (a?.totalAudioEnergy ?? 0);
    const dT = s.totalSamplesDuration - (a?.totalSamplesDuration ?? 0);
    out[u] = {
      bytes: s.bytesReceived - (a?.bytesReceived ?? 0),
      packets: s.packetsReceived - (a?.packetsReceived ?? 0),
      maxLevel: Math.round((maxLevel[u] ?? 0) * 10000) / 10000,
      rmsLevel: dT > 0 ? Math.round(Math.sqrt(Math.max(0, dE) / dT) * 10000) / 10000 : 0,
      samplesDur: Math.round(dT * 100) / 100,
      meterPeak: Math.round((meterPeak[u] ?? -1) * 10000) / 10000,
      speakingOn: speakingOn[u] ?? 0,
      timeline: (buckets[u] ?? []).map((v) => v.toFixed(2)).join(" "),
    };
  }
  return out;
}

function takeEvents(): LogEvent[] {
  return events.splice(0);
}

function openPcCount(): number {
  return allPcs.filter((pc) => pc.connectionState !== "closed" && pc.signalingState !== "closed").length;
}

function state() {
  return { selfId, channel: myChannel() ?? null, voiceStates: [...voiceStates.values()], openPcs: openPcCount() };
}

function debugPcs() {
  return {
    pcs: allPcs.map((pc) => ({
      id: pc.__id,
      remote: pc.__remoteUser ?? null,
      signaling: pc.signalingState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
      conn: pc.connectionState,
      hasLocal: !!pc.localDescription,
      hasRemote: !!pc.remoteDescription,
    })),
    sigLog: sigLog.slice(-300),
  };
}

/**
 * Engine-free repro: `pairs` pairs of raw RTCPeerConnections in this page, both
 * sides offer at once (glare), polite side does an implicit rollback, local
 * trickle. Returns how many pairs connected and how many stalled in ICE 'new'.
 */
async function glareRepro(pairs: number, delayMs: number, timeoutMs = 6000) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const dst = ctx.createMediaStreamDestination();
  osc.connect(dst);
  osc.start();
  const track = dst.stream.getAudioTracks()[0];
  const one = async () => {
    const polite = new NativePc({ bundlePolicy: "max-bundle" });
    const impolite = new NativePc({ bundlePolicy: "max-bundle" });
    polite.addTrack(track, dst.stream);
    impolite.addTrack(track, dst.stream);
    polite.onicecandidate = (e) => void impolite.addIceCandidate(e.candidate ?? undefined).catch(() => {});
    impolite.onicecandidate = (e) => void polite.addIceCandidate(e.candidate ?? undefined).catch(() => {});
    await Promise.all([polite.setLocalDescription(), impolite.setLocalDescription()]);
    await new Promise((r) => setTimeout(r, delayMs));
    // impolite ignores polite's offer; polite rolls back and answers.
    await polite.setRemoteDescription(impolite.localDescription!);
    await polite.setLocalDescription();
    await impolite.setRemoteDescription(polite.localDescription!);
    const t = performance.now();
    while (performance.now() - t < timeoutMs && !(polite.connectionState === "connected" && impolite.connectionState === "connected")) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const res = { polite: `${polite.connectionState}/${polite.iceGatheringState}`, impolite: `${impolite.connectionState}/${impolite.iceGatheringState}` };
    polite.close();
    impolite.close();
    return res;
  };
  const results = await Promise.all(Array.from({ length: pairs }, one));
  osc.stop();
  void ctx.close();
  const ok = results.filter((r) => r.polite.startsWith("connected") && r.impolite.startsWith("connected")).length;
  return { pairs, delayMs, connected: ok, stuck: results.filter((r) => !r.polite.startsWith("connected")) };
}


// ---------------------------------------------------------------------------
// Screen share

const remoteScreens = new Map<string, MediaStream | null>();
let fake: { stream: MediaStream; stop(): void } | null = null;

/**
 * Fake screen: a 1920x1080 canvas redrawn at 60 fps (moving shapes, scrolling
 * text, frame counter) via captureStream(60), plus a stereo tone
 * (L = 1000 Hz, R = 1500 Hz) from OscillatorNodes -> MediaStreamAudioDestination.
 */
function makeFakeScreen(opts: { width?: number; height?: number; fps?: number; audio?: boolean; leftHz?: number; rightHz?: number } = {}) {
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const fps = opts.fps ?? 60;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    frame++;
    const t = frame / fps;
    g.fillStyle = `hsl(${(frame * 2) % 360} 40% 18%)`;
    g.fillRect(0, 0, width, height);
    g.strokeStyle = "#445";
    g.lineWidth = 1;
    for (let x = (frame * 4) % 80; x < width; x += 80) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
    }
    for (let i = 0; i < 6; i++) {
      const x = ((Math.sin(t * (1 + i * 0.3)) + 1) / 2) * (width - 200);
      const y = ((Math.cos(t * (0.7 + i * 0.2)) + 1) / 2) * (height - 200);
      g.fillStyle = `hsl(${i * 60} 80% 55%)`;
      g.fillRect(x, y, 200, 200);
    }
    g.fillStyle = "#fff";
    g.font = "28px monospace";
    for (let line = 0; line < 12; line++) {
      g.fillText(`frame ${frame} line ${line} const x = compute(${(frame + line) % 997}); // shpihcord screen share e2e`, 40, 60 + line * 40 - ((frame * 2) % 40));
    }
    g.font = "bold 96px sans-serif";
    g.fillText(String(frame), width - 400, height - 80);
  };
  // captureStream(0) + requestFrame() after every draw: in a hidden window the
  // automatic capture (captureStream(fps)) only yields ~38 fps.
  const stream = canvas.captureStream(0);
  const vtrack = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const tick = () => {
    draw();
    vtrack.requestFrame?.();
  };
  tick();
  const timer = setInterval(tick, 1000 / fps);
  (window as any).__drawCount = () => frame;
  let ctx: AudioContext | null = null;
  if (opts.audio !== false) {
    ctx = new AudioContext({ sampleRate: 48000 });
    void ctx.resume();
    const merger = ctx.createChannelMerger(2);
    const dst = ctx.createMediaStreamDestination();
    dst.channelCount = 2;
    for (const [hz, ch] of [
      [opts.leftHz ?? 1000, 0],
      [opts.rightHz ?? 1500, 1],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      osc.connect(gain).connect(merger, 0, ch);
      osc.start();
    }
    merger.connect(dst);
    stream.addTrack(dst.stream.getAudioTracks()[0]);
  }
  return {
    stream,
    stop() {
      clearInterval(timer);
      void ctx?.close();
    },
  };
}

async function startShare(preset: ScreenSharePresetId, opts: { audio?: boolean } = {}) {
  const prev = fake;
  fake = makeFakeScreen(opts);
  await call!.startScreenShare(fake.stream, preset);
  prev?.stop();
  const v = fake.stream.getVideoTracks()[0];
  return { settings: v.getSettings(), contentHint: v.contentHint, tracks: fake.stream.getTracks().map((t) => t.kind) };
}

function stopShare() {
  call!.stopScreenShare();
  fake?.stop();
  fake = null;
}

/** Simulate the OS ending the capture (e.g. "Stop sharing" bar): fire 'ended' on the video track. */
function endShareExternally() {
  const v = fake?.stream.getVideoTracks()[0];
  v?.dispatchEvent(new Event("ended"));
  fake?.stop();
  fake = null;
}

async function setPreset(preset: ScreenSharePresetId) {
  await call!.setScreenSharePreset(preset);
  return fake?.stream.getVideoTracks()[0]?.getSettings() ?? null;
}

function watch(userId: string, watching: boolean) {
  call!.watchStream(userId, watching);
}

function setStreamVolume(userId: string, v: number) {
  call!.setStreamVolume(userId, v);
}

function livePcFor(userId: string): TrackedPc | undefined {
  return allPcs.filter((pc) => pc.__remoteUser === userId && pc.connectionState !== "closed" && pc.signalingState !== "closed").pop();
}

function codecOf(report: RTCStatsReport, s: any): string | undefined {
  const c = s.codecId ? (report.get(s.codecId) as any) : undefined;
  return c ? `${c.mimeType}${c.sdpFmtpLine ? " " + c.sdpFmtpLine : ""}` : undefined;
}

/** Video/screen-audio RTP stats with remote user attribution. */
async function mediaStats() {
  const out: Record<string, any> = {};
  for (const pc of allPcs) {
    if (pc.connectionState === "closed" || pc.signalingState === "closed" || !pc.__remoteUser) continue;
    const report = await pc.getStats();
    const tr = pc.getTransceivers();
    const micMid = tr[0]?.mid;
    const m = engineMids(pc.__remoteUser);
    const row: any = { videoIn: null, videoOut: null, screenAudioOut: null, screenAudioIn: null, transceivers: tr.map((t) => `${t.mid}:${t.receiver.track.kind}:${t.direction}/${t.currentDirection}`).join(" ") };
    report.forEach((s: any) => {
      const kind = s.kind ?? s.mediaType;
      if (s.type === "inbound-rtp" && kind === "video" && (m.scrIn ? s.mid === m.scrIn : s.mid !== m.camIn)) {
        row.videoIn = { bytes: s.bytesReceived, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, framesDecoded: s.framesDecoded, codec: codecOf(report, s), decoder: s.decoderImplementation, ts: s.timestamp };
      } else if (s.type === "outbound-rtp" && kind === "video" && (m.scrOut ? s.mid === m.scrOut : s.mid !== m.camOut)) {
        row.videoOut = { bytes: s.bytesSent, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, framesSent: s.framesSent, codec: codecOf(report, s), encoder: s.encoderImplementation, powerEfficient: s.powerEfficientEncoder, qlr: s.qualityLimitationReason, target: s.targetBitrate, ts: s.timestamp };
      } else if (s.type === "media-source" && kind === "video" && !row.videoSource) {
        row.videoSource = { w: s.width, h: s.height, fps: s.framesPerSecond, frames: s.frames };
      } else if (s.type === "outbound-rtp" && kind === "audio" && s.mid !== micMid) {
        row.screenAudioOut = { bytes: s.bytesSent, codec: codecOf(report, s), target: s.targetBitrate, ts: s.timestamp, mid: s.mid };
      } else if (s.type === "inbound-rtp" && kind === "audio" && s.mid !== micMid) {
        row.screenAudioIn = { bytes: s.bytesReceived, codec: codecOf(report, s), ts: s.timestamp, mid: s.mid };
      }
    });
    const vs = tr.find((t, i) => i > 0 && t.sender.track?.kind === "video" && t.mid !== m.camOut);
    if (vs) {
      const p = vs.sender.getParameters() as any;
      row.videoSenderParams = { enc: p.encodings?.[0], degradationPreference: p.degradationPreference };
    }
    out[pc.__remoteUser] = row;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Camera

const remoteCameras = new Map<string, MediaStream | null>();
const localCamTracks: MediaStreamTrack[] = [];

/** mids of the screen/camera transceivers on our connection to `userId` (engine internals). */
function engineMids(userId: string) {
  const e = (call as any)?.peers?.get(userId);
  return {
    scrOut: (e?.screenSend?.video?.mid ?? null) as string | null,
    scrIn: (e?.remoteScreen?.mid ?? null) as string | null,
    camOut: (e?.camSend?.transceiver?.mid ?? null) as string | null,
    camIn: (e?.remoteCam?.transceiver?.mid ?? null) as string | null,
  };
}

async function startCamera(deviceId?: string) {
  await call!.startCamera(deviceId);
  const t = localCamTracks[localCamTracks.length - 1];
  return { on: call!.isCameraOn(), settings: t?.getSettings() ?? null, contentHint: t?.contentHint };
}

function stopCamera() {
  call!.stopCamera();
  return { on: call!.isCameraOn(), lastTrackState: localCamTracks[localCamTracks.length - 1]?.readyState ?? null };
}

async function setCameraDevice(deviceId: string) {
  await call!.setCameraDevice(deviceId);
  return localCamTracks.map((t) => t.readyState);
}

async function cameraDevices() {
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput").map((d) => ({ id: d.deviceId, label: d.label }));
}

function setCameraPreference(userId: string, pref: "off" | "low" | "high") {
  call!.setCameraPreference(userId, pref);
}

/** Camera RTP stats per remote user (only the camera mids), plus our sender parameters. */
async function cameraStats() {
  const out: Record<string, any> = {};
  for (const pc of allPcs) {
    if (pc.connectionState === "closed" || pc.signalingState === "closed" || !pc.__remoteUser) continue;
    const m = engineMids(pc.__remoteUser);
    const report = await pc.getStats();
    const row: any = { in: null, out: null, params: null, mids: m };
    report.forEach((s: any) => {
      if ((s.kind ?? s.mediaType) !== "video") return;
      if (s.type === "inbound-rtp" && m.camIn && s.mid === m.camIn) {
        row.in = { bytes: s.bytesReceived ?? 0, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, framesDecoded: s.framesDecoded ?? 0, codec: codecOf(report, s), ts: s.timestamp };
      } else if (s.type === "outbound-rtp" && m.camOut && s.mid === m.camOut) {
        row.out = { bytes: s.bytesSent ?? 0, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, codec: codecOf(report, s), qlr: s.qualityLimitationReason, active: s.active, ts: s.timestamp };
      }
    });
    const t = pc.getTransceivers().find((x) => x.mid === m.camOut);
    if (t) {
      const p = t.sender.getParameters() as any;
      row.params = { enc: p.encodings?.[0], degradationPreference: p.degradationPreference };
    }
    out[pc.__remoteUser] = row;
  }
  return out;
}

/** What we receive from `userId`: camera vs screen streams and their msid stream ids. */
function identify(userId: string) {
  const cam = remoteCameras.get(userId) ?? null;
  const scr = remoteScreens.get(userId) ?? null;
  const pc = livePcFor(userId);
  const tr = pc?.getTransceivers() ?? [];
  const camT = cam?.getVideoTracks()[0];
  const scrT = scr?.getVideoTracks()[0];
  const m = engineMids(userId);
  return {
    cameraTrack: camT?.id ?? null,
    screenTrack: scrT?.id ?? null,
    distinct: !!camT && !!scrT && camT !== scrT,
    cameraMsid: camT ? trackStreams.get(camT.id) ?? [] : [],
    screenMsid: scrT ? trackStreams.get(scrT.id) ?? [] : [],
    micMsid: tr[0] ? trackStreams.get(tr[0].receiver.track.id) ?? [] : [],
    screenAudioMsid: tr.filter((t, i) => i > 0 && t.receiver.track.kind === "audio").map((t) => trackStreams.get(t.receiver.track.id) ?? []),
    mids: m,
    cameraMidMatches: !!camT && tr.find((t) => t.mid === m.camIn)?.receiver.track === camT,
    screenMidMatches: !!scrT && tr.find((t) => t.mid === m.scrIn)?.receiver.track === scrT,
  };
}

async function pcSummary() {
  const out: string[] = [];
  for (const pc of allPcs) {
    let micIn = -1;
    let micOut = -1;
    const extra: string[] = [];
    try {
      const r = await pc.getStats();
      const mid = pc.getTransceivers()[0]?.mid;
      r.forEach((s: any) => {
        if (s.type === "inbound-rtp" && (s.kind ?? s.mediaType) === "audio" && s.mid === mid) micIn = s.bytesReceived;
        if (s.type === "outbound-rtp" && (s.kind ?? s.mediaType) === "audio" && s.mid === mid) micOut = s.bytesSent;
        if (s.type === "outbound-rtp" && (s.kind ?? s.mediaType) === "audio") extra.push(`out(mid=${s.mid} ssrc=${s.ssrc} bytes=${s.bytesSent} active=${s.active})`);
      });
    } catch {}
    out.push(`pc${pc.__id}(${pc.__remoteUser ?? "?"}) ${pc.connectionState}/${pc.signalingState} micIn=${micIn} micOut=${micOut} ${extra.join(" ")} micSender=${pc.signalingState === "closed" ? "-" : JSON.stringify({ track: pc.getTransceivers()[0]?.sender.track?.readyState, enc: pc.getTransceivers()[0]?.sender.getParameters().encodings })} tr=${pc.signalingState === "closed" ? "-" : pc.getTransceivers().map((t) => `${t.mid}:${t.receiver.track.kind}:${t.currentDirection}`).join(" ")}`);
  }
  return out;
}

function cameraState() {
  return {
    on: call?.isCameraOn() ?? false,
    offers: offerCount,
    localTracks: localCamTracks.map((t) => t.readyState),
    remote: [...remoteCameras].map(([u, s]) => [u, !!s]),
  };
}

function dominantHz(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): { hz: number; db: number } {
  analyser.getFloatFrequencyData(buf);
  let best = 0;
  for (let i = 1; i < buf.length; i++) if (buf[i] > buf[best]) best = i;
  return { hz: Math.round((best * analyser.context.sampleRate) / analyser.fftSize), db: Math.round(buf[best]) };
}

/**
 * Analyse what we receive from `userId` for `ms`: the screen-audio track (split
 * L/R, dominant frequency) vs the mic track, plus the engine's own screen-audio
 * level (after the per-stream volume) and speaking events for that user.
 */
async function analyseScreenAudio(userId: string, durationMs: number) {
  const pc = livePcFor(userId);
  if (!pc) return { error: "no pc" };
  const tr = pc.getTransceivers();
  const mic = tr[0]?.receiver.track;
  const screenT = tr.find((t, i) => i > 0 && t.receiver.track.kind === "audio" && (t.currentDirection === "recvonly" || t.currentDirection === "sendrecv"));
  const scrMid = engineMids(userId).scrIn;
  const video = tr.find((t, i) => i > 0 && t.receiver.track.kind === "video" && (scrMid ? t.mid === scrMid : true) && (t.currentDirection === "recvonly" || t.currentDirection === "sendrecv"));
  if (!screenT) return { error: "no screen audio transceiver", transceivers: tr.map((t) => `${t.mid}:${t.receiver.track.kind}:${t.currentDirection}`) };
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  const mk = () => {
    const a = ctx.createAnalyser();
    a.fftSize = 4096;
    a.smoothingTimeConstant = 0.5;
    return a;
  };
  const src = ctx.createMediaStreamSource(new MediaStream([screenT.receiver.track]));
  const split = ctx.createChannelSplitter(2);
  const aL = mk();
  const aR = mk();
  src.connect(split);
  split.connect(aL, 0);
  split.connect(aR, 1);
  const micSrc = ctx.createMediaStreamSource(new MediaStream([mic]));
  const aM = mk();
  micSrc.connect(aM);
  const buf = new Float32Array(aL.frequencyBinCount);
  const tbuf = new Float32Array(aL.fftSize);
  const rmsOf = (a: AnalyserNode) => {
    a.getFloatTimeDomainData(tbuf);
    let s = 0;
    for (const v of tbuf) s += v * v;
    return Math.sqrt(s / tbuf.length);
  };
  const L: number[] = [];
  const R: number[] = [];
  const M: number[] = [];
  const rmsL: number[] = [];
  const rmsR: number[] = [];
  let engineMax = 0;
  let speakingOn = 0;
  const off = call!.on("speaking", (s) => {
    if (s.userId === userId && s.speaking) speakingOn++;
  });
  const audio = (call as any).audio;
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    L.push(dominantHz(aL, buf).hz);
    R.push(dominantHz(aR, buf).hz);
    const m = dominantHz(aM, buf);
    if (m.db > -70) M.push(m.hz);
    rmsL.push(rmsOf(aL));
    rmsR.push(rmsOf(aR));
    engineMax = Math.max(engineMax, audio?.readStreamLevel?.(userId) ?? -1);
  }
  off();
  void ctx.close();
  const mode = (xs: number[]) => {
    const c = new Map<number, number>();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
  };
  const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 1000) / 1000;
  const vidStreams = video ? trackStreams.get(video.receiver.track.id) ?? [] : [];
  const scrStreams = trackStreams.get(screenT.receiver.track.id) ?? [];
  const micStreams = trackStreams.get(mic.id) ?? [];
  return {
    leftHz: mode(L),
    rightHz: mode(R),
    micHz: mode(M),
    rmsL: avg(rmsL),
    rmsR: avg(rmsR),
    engineStreamLevelMax: Math.round(engineMax * 1000) / 1000,
    speakingOn,
    msid: { screenAudio: scrStreams, screenVideo: vidStreams, mic: micStreams },
    screenAudioSameMsidAsVideo: scrStreams.length > 0 && scrStreams[0] === vidStreams[0],
    micMsidDiffers: micStreams[0] !== scrStreams[0],
    screenTrackMuted: screenT.receiver.track.muted,
  };
}

/** Attach the latest remoteScreen stream to a <video muted> and report what it renders. */
async function probeRemoteVideo(userId: string, ms = 1500) {
  const stream = remoteScreens.get(userId);
  if (!stream) return { stream: false };
  const el = document.createElement("video");
  el.muted = true;
  el.autoplay = true;
  el.playsInline = true;
  el.srcObject = stream;
  document.body.appendChild(el);
  await el.play().catch(() => undefined);
  const q0 = el.getVideoPlaybackQuality?.();
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  const q1 = el.getVideoPlaybackQuality?.();
  const res = {
    stream: true,
    videoWidth: el.videoWidth,
    videoHeight: el.videoHeight,
    trackState: stream.getVideoTracks()[0]?.readyState,
    renderedFps: q0 && q1 ? Math.round(((q1.totalVideoFrames - q0.totalVideoFrames) * 1000) / (performance.now() - t0)) : null,
    audioTracksInStream: stream.getAudioTracks().length,
  };
  el.srcObject = null;
  el.remove();
  return res;
}

function screenState() {
  return { sharing: call?.isScreenSharing() ?? false, remote: [...remoteScreens].map(([u, s]) => [u, !!s]) };
}

/** Test hook: recreate our RTCPeerConnection to `userId` as if it had failed (engine internals). */
function forceReset(userId: string) {
  (call as any).resetPeer(userId, "failed", []);
}

function identity() {
  return { fingerprint: certificateFingerprint(certificate) ?? null, pins: Object.fromEntries(pins) };
}

async function safetyNumber(userId: string) {
  return call!.getSafetyNumber(userId);
}

/**
 * Test hook for the MITM scenario: from now on this client presents a different
 * DTLS key (as a relay substituting its own certificate would) on new connections.
 */
async function swapCertificate() {
  certificate = await genCert();
  (call as any).certificate = certificate;
  return certificateFingerprint(certificate);
}

/** "Trust new key": re-pin to what was presented and retry the blocked connection. */
function trustPeer(userId: string) {
  const fp = lastMismatch.get(userId);
  if (fp) pins.set(userId, fp);
  call!.retryPeer(userId);
  return fp ?? null;
}

function setDeafened(d: boolean) {
  call?.setDeafened(d);
}

(window as any).harness = {
  glareRepro,
  debugPcs,
  init,
  join,
  leave,
  setMuted,
  setDeafened,
  peers,
  inbound,
  sampleAudio,
  takeEvents,
  state,
  startShare,
  stopShare,
  endShareExternally,
  setPreset,
  watch,
  setStreamVolume,
  mediaStats,
  analyseScreenAudio,
  probeRemoteVideo,
  screenState,
  forceReset,
  identity,
  safetyNumber,
  swapCertificate,
  trustPeer,
  startCamera,
  stopCamera,
  setCameraDevice,
  cameraDevices,
  setCameraPreference,
  cameraStats,
  identify,
  cameraState,
  pcSummary,
};
(window as any).harnessLoaded = true;
