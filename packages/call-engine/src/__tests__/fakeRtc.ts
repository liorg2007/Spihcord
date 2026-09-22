/**
 * A small but spec-shaped fake RTCPeerConnection for negotiation tests:
 * serialized async operations chain, signaling state machine with implicit
 * rollback, negotiation-needed flag, trickle candidates, ICE restart and a
 * per-instance DTLS fingerprint.
 */
import type { SignalData } from "@shpihcord/protocol";

type Desc = { type: RTCSdpType; sdp: string };

let fpCounter = 0;

export function parseTracks(sdp: string | undefined): string[] {
  const m = /^a=x-tracks:(.*)$/m.exec(sdp ?? "");
  return m && m[1] ? m[1].split(",") : [];
}

export function parseUfrag(sdp: string | undefined): string | undefined {
  return /^a=ice-ufrag:(.*)$/m.exec(sdp ?? "")?.[1];
}

export class FakePC {
  static instances: FakePC[] = [];

  signalingState: RTCSignalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: Desc | null = null;
  remoteDescription: Desc | null = null;
  currentLocalDescription: Desc | null = null;
  currentRemoteDescription: Desc | null = null;

  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  ontrack: ((ev: { track: unknown; streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;

  readonly fingerprint = `sha-256 AA:${++fpCounter}`;
  readonly addedCandidates: unknown[] = [];
  readonly receivedTracks: string[] = [];
  closed = false;
  config: RTCConfiguration;

  private localTracks: string[] = [];
  private iceGen = 0;
  private restartPending = false;
  private chain: Promise<unknown> = Promise.resolve();
  private pendingOps = 0;
  private negFlag = false;
  private negCheckQueued = false;
  private opDelay: () => number;

  constructor(config: RTCConfiguration, opDelay: () => number = () => 0) {
    this.config = config;
    this.opDelay = opDelay;
    FakePC.instances.push(this);
  }

  // --- API used by Peer ------------------------------------------------------

  addTrack(track: { id: string }): unknown {
    this.localTracks.push(track.id);
    this.updateNegotiationNeeded();
    return {};
  }

  addTransceiver(): unknown {
    this.localTracks.push(`anon-${this.localTracks.length}`);
    this.updateNegotiationNeeded();
    return {};
  }

  restartIce(): void {
    this.restartPending = true;
    this.updateNegotiationNeeded();
  }

  setConfiguration(config: RTCConfiguration): void {
    this.config = config;
  }

  getSenders(): unknown[] {
    return [];
  }

  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }

  close(): void {
    this.closed = true;
    this.signalingState = "closed";
    this.connectionState = "closed";
  }

  createOffer(): Promise<Desc> {
    return this.enqueue(() => ({ type: "offer" as RTCSdpType, sdp: this.makeSdp(true) }));
  }

  createAnswer(): Promise<Desc> {
    return this.enqueue(() => {
      if (this.signalingState !== "have-remote-offer") throw invalidState(`createAnswer in ${this.signalingState}`);
      return { type: "answer" as RTCSdpType, sdp: this.makeSdp(false) };
    });
  }

  setLocalDescription(desc?: Desc): Promise<void> {
    return this.enqueue(() => {
      let d = desc;
      if (!d || !d.type) {
        d =
          this.signalingState === "have-remote-offer"
            ? { type: "answer", sdp: this.makeSdp(false) }
            : { type: "offer", sdp: this.makeSdp(true) };
      }
      if (d.type === "offer") {
        if (this.signalingState !== "stable" && this.signalingState !== "have-local-offer") {
          throw invalidState(`sLD(offer) in ${this.signalingState}`);
        }
        this.localDescription = d;
        this.signalingState = "have-local-offer";
      } else if (d.type === "answer") {
        if (this.signalingState !== "have-remote-offer") throw invalidState(`sLD(answer) in ${this.signalingState}`);
        this.localDescription = d;
        this.currentLocalDescription = d;
        this.currentRemoteDescription = this.remoteDescription;
        this.becameStable();
      } else if (d.type === "rollback") {
        this.rollback();
      }
      this.trickle();
    });
  }

  setRemoteDescription(desc: Desc): Promise<void> {
    return this.enqueue(() => {
      if (desc.type === "offer") {
        if (this.signalingState === "have-local-offer") this.rollback(); // implicit rollback
        if (this.signalingState !== "stable" && this.signalingState !== "have-remote-offer") {
          throw invalidState(`sRD(offer) in ${this.signalingState}`);
        }
        const curFp = /^a=fingerprint:(.*)$/m.exec(this.currentRemoteDescription?.sdp ?? "")?.[1];
        const newFp = /^a=fingerprint:(.*)$/m.exec(desc.sdp)?.[1];
        if (curFp && newFp && curFp !== newFp) {
          throw new Error("InvalidAccessError: DTLS fingerprint changed");
        }
        this.remoteDescription = desc;
        this.signalingState = "have-remote-offer";
        this.fireTracks(desc.sdp);
      } else if (desc.type === "answer") {
        if (this.signalingState !== "have-local-offer") throw invalidState(`sRD(answer) in ${this.signalingState}`);
        this.remoteDescription = desc;
        this.currentRemoteDescription = desc;
        this.currentLocalDescription = this.localDescription;
        if (parseUfrag(this.localDescription?.sdp) === `u${this.iceGen}`) this.restartPending = false;
        this.fireTracks(desc.sdp);
        this.becameStable();
      } else if (desc.type === "rollback") {
        this.rollback();
      }
    });
  }

  addIceCandidate(candidate?: unknown): Promise<void> {
    return this.enqueue(() => {
      if (!this.remoteDescription) throw invalidState("addIceCandidate without remote description");
      this.addedCandidates.push(candidate ?? null);
    });
  }

  // --- internals -------------------------------------------------------------

  private enqueue<T>(fn: () => T): Promise<T> {
    this.pendingOps++;
    const run = this.chain.then(async () => {
      await delay(this.opDelay());
      if (this.closed) throw invalidState("closed");
      return fn();
    });
    const done = run.finally(() => {
      this.pendingOps--;
    });
    this.chain = done.catch(() => undefined);
    return done;
  }

  private makeSdp(offer: boolean): string {
    if (offer && this.restartPending) this.iceGen++;
    return [
      "v=0",
      "o=- 1 2 IN IP4 127.0.0.1",
      `a=fingerprint:${this.fingerprint}`,
      `a=ice-ufrag:u${this.iceGen}`,
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 minptime=10",
      `a=x-tracks:${this.localTracks.join(",")}`,
      "",
    ].join("\r\n");
  }

  private rollback(): void {
    this.localDescription = this.currentLocalDescription;
    this.remoteDescription = this.currentRemoteDescription;
    this.becameStable();
  }

  private becameStable(): void {
    this.signalingState = "stable";
    this.onsignalingstatechange?.();
    this.negFlag = false;
    if (this.currentLocalDescription && this.currentRemoteDescription && this.connectionState !== "connected") {
      setTimeout(() => {
        if (this.closed || this.connectionState === "connected") return;
        this.connectionState = "connected";
        this.onconnectionstatechange?.();
      }, 0);
    }
    this.updateNegotiationNeeded();
  }

  /** Test hook: drive the connection state machine. */
  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  private isNegotiationNeeded(): boolean {
    if (this.restartPending) return true;
    const negotiated = parseTracks(this.currentLocalDescription?.sdp);
    return this.localTracks.some((t) => !negotiated.includes(t));
  }

  private updateNegotiationNeeded(): void {
    if (this.negCheckQueued) return;
    this.negCheckQueued = true;
    setTimeout(() => {
      this.negCheckQueued = false;
      if (this.closed || this.negFlag) return;
      if (this.pendingOps > 0) {
        // Re-check once the operations chain drains.
        this.chain.then(() => this.updateNegotiationNeeded());
        return;
      }
      if (this.signalingState !== "stable" || !this.isNegotiationNeeded()) return;
      this.negFlag = true;
      this.onnegotiationneeded?.();
    }, 0);
  }

  private fireTracks(sdp: string): void {
    for (const id of parseTracks(sdp)) {
      if (this.receivedTracks.includes(id)) continue;
      this.receivedTracks.push(id);
      const track = { id, kind: "audio" };
      setTimeout(() => this.ontrack?.({ track, streams: [] }), 0);
    }
  }

  private trickle(): void {
    const gen = this.iceGen;
    setTimeout(() => {
      if (this.closed) return;
      const init = { candidate: `candidate:1 1 udp 1 10.0.0.1 ${5000 + gen} typ host`, sdpMid: "0", sdpMLineIndex: 0 };
      this.onicecandidate?.({ candidate: { ...init, toJSON: () => init } });
      this.onicecandidate?.({ candidate: null });
    }, 0);
  }
}

function invalidState(msg: string): Error {
  const e = new Error(`InvalidStateError: ${msg}`);
  e.name = "InvalidStateError";
  return e;
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-order (per direction) message relay with random latency, like a hub WebSocket. */
export class FakeNetwork {
  readonly log: Array<{ from: string; to: string; data: SignalData }> = [];
  private handlers = new Map<string, (from: string, data: SignalData) => void>();
  private lastDelivery = new Map<string, number>();

  constructor(private readonly latency: () => number = () => 0) {}

  register(id: string, handler: (from: string, data: SignalData) => void): void {
    this.handlers.set(id, handler);
  }

  send(from: string, to: string, data: SignalData): void {
    this.log.push({ from, to, data });
    const key = `${from}->${to}`;
    const now = Date.now();
    const at = Math.max(this.lastDelivery.get(key) ?? 0, now + this.latency());
    this.lastDelivery.set(key, at);
    // Serialize per direction with a chained timer so ordering is preserved.
    const copy = JSON.parse(JSON.stringify(data)) as SignalData;
    setTimeout(() => this.handlers.get(to)?.(from, copy), Math.max(0, at - now));
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await delay(2);
  }
}
