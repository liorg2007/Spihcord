/**
 * Browser side of the voice e2e test. A minimal hub client (HTTP auth, WS auth,
 * pong, voice.join/leave, rtc.signal relay) driving the real call engine.
 * The Electron main process drives it through `window.harness`.
 */
import { createVoiceCall, type PeerInfo, type VoiceCall } from "@shpihcord/call-engine";
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
const sigDesc = (d: SignalData) => (d.kind === "description" ? `desc:${d.description.type}` : d.candidate ? "cand" : "cand:end");

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
const sdpSender = new Map<string, string>();

const NativePc = window.RTCPeerConnection;
class TrackingPc extends NativePc {
  __id = ++pcSeq;
  constructor(config?: RTCConfiguration) {
    super(config);
    allPcs.push(this);
    this.addEventListener("track", (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      if (ev.track.kind === "audio") meterRemote(this as TrackedPc, stream);
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

async function init(opts: { hubUrl: string; username: string; password: string; invite: string }) {
  hubUrl = opts.hubUrl;
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
    signaling: {
      send: (to, data) => {
        sigLog.push(`${ms()} -> ${to} ${sigDesc(data)}`);
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
    report.forEach((s: any) => {
      if (s.type === "inbound-rtp" && (s.kind ?? s.mediaType) === "audio") {
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

(window as any).harness = { glareRepro, debugPcs, init, join, leave, setMuted, peers, inbound, sampleAudio, takeEvents, state };
(window as any).harnessLoaded = true;
