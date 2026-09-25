/**
 * Browser-side security harness (bundled by run.cjs with esbuild, loaded in a hidden
 * Electron window). Uses the REAL call-engine Peer class + SDP munging, with an
 * in-memory signaling relay standing in for the hub (the hub only relays SDP/ICE
 * verbatim, so this is the same trust model).
 *
 * Modes (location.hash): #live  #mitm  #cert
 */
import { Peer } from "../../packages/call-engine/src/peer";
import { mungeOutgoingSdp, mungeLocalSdp, extractFingerprint } from "../../packages/call-engine/src/sdp";

type Sig = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: any = { mode: location.hash.slice(1), log: [] as string[] };
const log = (s: string) => out.log.push(`${performance.now().toFixed(0)} ${s}`);
(window as any).__result = null;

// ---------------------------------------------------------------- fake media
const ac = new AudioContext();
function fakeAudio(freq: number): MediaStreamTrack {
  const o = ac.createOscillator();
  o.frequency.value = freq;
  const d = ac.createMediaStreamDestination();
  o.connect(d);
  o.start();
  return d.stream.getAudioTracks()[0];
}
function fakeVideo(label: string, w = 640, h = 360): MediaStreamTrack {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  let n = 0;
  setInterval(() => {
    g.fillStyle = `hsl(${n++ % 360},80%,50%)`;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff";
    g.font = "40px sans-serif";
    g.fillText(`${label} ${n}`, 20, 60);
  }, 33);
  return (c as any).captureStream(30).getVideoTracks()[0];
}
async function audioLevel(track: MediaStreamTrack): Promise<number> {
  const src = ac.createMediaStreamSource(new MediaStream([track]));
  const an = ac.createAnalyser();
  src.connect(an);
  // Chromium needs the remote track attached to a sink to decode.
  const el = new Audio();
  el.srcObject = new MediaStream([track]);
  el.muted = true;
  void el.play().catch(() => {});
  let max = 0;
  const buf = new Float32Array(an.fftSize);
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    an.getFloatTimeDomainData(buf);
    for (const v of buf) max = Math.max(max, Math.abs(v));
  }
  return max;
}

const RTC_CONFIG: RTCConfiguration = { iceServers: [], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" };

function micMid(pc: RTCPeerConnection): string | null {
  return pc.getTransceivers()[0]?.mid ?? null;
}
function hasScreenAudio(pc: RTCPeerConnection): boolean {
  return pc.getTransceivers().some((t, i) => i > 0 && t.receiver.track?.kind === "audio");
}

// ---------------------------------------------------------------- mesh helper
interface Node {
  id: string;
  peers: Map<string, Peer>;
  mic: MediaStreamTrack;
  resets: string[];
  errors: string[];
  sdps: { dir: string; type: string; sdp: string }[];
}

type Relay = (from: string, to: string, data: Sig) => void;

function makePeer(self: Node, remote: string, relay: Relay, replay: Sig[] = []): Peer {
  let peer: Peer | undefined;
  peer = new Peer({
    userId: remote,
    polite: self.id > remote,
    config: RTC_CONFIG,
    createPc: (c) => new RTCPeerConnection(c),
    localTrack: self.mic,
    localStreams: [new MediaStream([self.mic])],
    send: (d) => {
      if (d.kind === "description") self.sdps.push({ dir: `${self.id}->${remote}`, type: d.description.type, sdp: d.description.sdp });
      relay(self.id, remote, JSON.parse(JSON.stringify(d)));
    },
    mungeSdp: (sdp) => mungeOutgoingSdp(sdp, peer ? micMid(peer.pc) : null),
    localSdpTransform: () => {
      if (!peer || !hasScreenAudio(peer.pc)) return null;
      const mid = micMid(peer.pc);
      return (sdp) => mungeLocalSdp(sdp, mid);
    },
    onError: (m, c) => self.errors.push(`${m}: ${c}`),
    onReset: (reason, sigs) => {
      self.resets.push(`${remote}:${reason}`);
      log(`${self.id}: peer ${remote} reset (${reason}) -> recreated silently`);
      self.peers.get(remote)?.close();
      self.peers.set(remote, makePeer(self, remote, relay, sigs ?? []));
    },
    timings: { politeInitialOfferDelayMs: 500 },
  });
  for (const s of replay) void peer.handleSignal(s);
  return peer;
}

function newNode(id: string, freq: number): Node {
  return { id, peers: new Map(), mic: fakeAudio(freq), resets: [], errors: [], sdps: [] };
}

async function waitConnected(peers: Peer[], ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (peers.every((p) => p.connectionState === "connected")) return true;
    await sleep(200);
  }
  return false;
}

async function statsSummary(pc: RTCPeerConnection) {
  const rep = await pc.getStats();
  const all: any[] = [];
  rep.forEach((s: any) => all.push(s));
  const byId = new Map(all.map((s) => [s.id, s]));
  const transports = all.filter((s) => s.type === "transport").map((t) => ({
    id: t.id,
    dtlsState: t.dtlsState,
    tlsVersion: t.tlsVersion,
    dtlsCipher: t.dtlsCipher,
    srtpCipher: t.srtpCipher,
    dtlsRole: t.dtlsRole,
    iceState: t.iceState,
    localCert: byId.get(t.localCertificateId),
    remoteCert: byId.get(t.remoteCertificateId),
  }));
  const rtp = all
    .filter((s) => s.type === "inbound-rtp" || s.type === "outbound-rtp")
    .map((s) => ({
      type: s.type,
      kind: s.kind,
      mid: s.mid,
      ssrc: s.ssrc,
      transportId: s.transportId,
      bytes: s.bytesReceived ?? s.bytesSent,
      packets: s.packetsReceived ?? s.packetsSent,
      codec: byId.get(s.codecId)?.mimeType,
    }));
  const pair = all.find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
  const lc = pair && byId.get(pair.localCandidateId);
  const sdp = pc.currentLocalDescription?.sdp ?? "";
  const rsdp = pc.currentRemoteDescription?.sdp ?? "";
  return {
    transports,
    rtp,
    selectedPair: pair && { protocol: lc?.protocol, candidateType: lc?.candidateType },
    sdp: {
      bundle: /^a=group:BUNDLE (.*)$/m.exec(sdp)?.[1],
      mLines: (sdp.match(/^m=.*$/gm) || []).map((l) => l.split(" ").slice(0, 3).join(" ")),
      remoteMLines: (rsdp.match(/^m=.*$/gm) || []).map((l) => l.split(" ").slice(0, 3).join(" ")),
      localFingerprint: extractFingerprint(sdp),
      remoteFingerprint: extractFingerprint(rsdp),
      setup: (sdp.match(/^a=setup:.*$/gm) || []).filter((v, i, a) => a.indexOf(v) === i),
    },
  };
}

// ---------------------------------------------------------------- live: 3-peer mesh, voice + screen + camera
async function live() {
  const nodes = [newNode("alice", 440), newNode("bob", 550), newNode("carol", 660)];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const relay: Relay = (from, to, d) => setTimeout(() => void byId.get(to)!.peers.get(from)?.handleSignal(d), 5);
  for (const n of nodes) for (const m of nodes) if (n !== m) n.peers.set(m.id, makePeer(n, m.id, relay));
  const all = () => nodes.flatMap((n) => [...n.peers.values()]);
  out.voiceConnected = await waitConnected(all());
  log(`voice connected=${out.voiceConnected}`);

  // alice: screen share (video + system audio), bob: camera, as the engine does (extra transceivers, renegotiation)
  const scr = fakeVideo("screen", 1280, 720);
  const scrAudio = fakeAudio(880);
  const cam = fakeVideo("cam");
  for (const p of byId.get("alice")!.peers.values()) {
    p.pc.addTransceiver(scr, { direction: "sendonly" });
    p.pc.addTransceiver(scrAudio, { direction: "sendonly" });
  }
  for (const p of byId.get("bob")!.peers.values()) p.pc.addTransceiver(cam, { direction: "sendonly" });
  await sleep(6000);
  out.allConnected = await waitConnected(all());
  out.pairs = {};
  for (const n of nodes) for (const [r, p] of n.peers) out.pairs[`${n.id}->${r}`] = await statsSummary(p.pc);
  out.resets = nodes.flatMap((n) => n.resets);
  out.errors = nodes.flatMap((n) => n.errors);
  out.capturedSdps = nodes.flatMap((n) => n.sdps);
  // raw local descriptions (pre-munging) too, for the fuzz corpus
  out.rawLocal = all().map((p) => p.pc.localDescription?.sdp);
  for (const p of all()) p.close();
}

// ---------------------------------------------------------------- mitm: malicious hub
async function mitm() {
  const A = newNode("alice", 440);
  const B = newNode("bob", 550);
  const nodes = new Map([["alice", A], ["bob", B]]);
  // The relay's own PeerConnections: mA faces alice (pretending to be bob), mB faces bob.
  const mCert = await RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256" } as any);
  const mk = () => new RTCPeerConnection({ ...RTC_CONFIG, certificates: [mCert] });
  const facing = new Map<string, RTCPeerConnection>([["alice", mk()], ["bob", mk()]]);
  const other = (id: string) => (id === "alice" ? "bob" : "alice");
  const intercepted: Record<string, MediaStreamTrack[]> = { alice: [], bob: [] };
  const toVictim = (victim: string, d: Sig) =>
    setTimeout(() => void nodes.get(victim)!.peers.get(other(victim))?.handleSignal(d), 5);

  for (const [victim, pc] of facing) {
    pc.onicecandidate = (e) => toVictim(victim, { kind: "candidate", candidate: e.candidate ? e.candidate.toJSON() : null });
    pc.ontrack = (e) => {
      intercepted[victim].push(e.track);
      log(`MITM: got plaintext ${e.track.kind} track from ${victim}`);
      // forward it to the other victim
      const fwd = facing.get(other(victim))!;
      const t = fwd.getTransceivers().find((x) => x.receiver.track.kind === e.track.kind && !(x.sender.track));
      if (t) void t.sender.replaceTrack(e.track);
    };
  }
  let chain = Promise.resolve();
  const evil: Relay = (from, _to, d) => {
    chain = chain.then(async () => {
      const pc = facing.get(from)!;
      try {
        if (d.kind === "candidate") {
          if (d.candidate) await pc.addIceCandidate(d.candidate);
          return;
        }
        if (d.kind !== "description") return;
        if (d.description.type === "offer") {
          await pc.setRemoteDescription(d.description);
          for (const t of pc.getTransceivers()) {
            t.direction = "sendrecv";
            const tr = intercepted[other(from)].find((x) => x.kind === t.receiver.track.kind);
            if (tr && !t.sender.track) await t.sender.replaceTrack(tr); // signalled in the answer
          }
          await pc.setLocalDescription();
          log(`MITM: answered ${from}'s offer with relay fingerprint`);
          toVictim(from, { kind: "description", description: { type: "answer", sdp: pc.localDescription!.sdp } });
        } else {
          await pc.setRemoteDescription(d.description);
        }
      } catch (err) {
        log(`MITM relay error: ${err}`);
      }
    });
  };
  // The relay never offers; both victims eventually offer (the polite side after its fallback delay).
  A.peers.set("bob", makePeer(A, "bob", evil));
  B.peers.set("alice", makePeer(B, "alice", evil));
  const pa = A.peers.get("bob")!, pb = B.peers.get("alice")!;
  out.connected = await waitConnected([pa, pb]);
  await sleep(1500);
  // forward late tracks
  for (const [victim, tracks] of Object.entries(intercepted)) {
    const fwd = facing.get(other(victim))!;
    for (const tr of tracks) {
      const t = fwd.getTransceivers().find((x) => x.receiver.track.kind === tr.kind);
      if (t) await t.sender.replaceTrack(tr);
    }
  }
  await sleep(2500);
  const sa = await statsSummary(pa.pc), sb = await statsSummary(pb.pc);
  out.alice = { localFp: sa.sdp.localFingerprint, remoteFpSeenAsBob: sa.sdp.remoteFingerprint, transports: sa.transports.map(({ localCert, remoteCert, ...t }) => t) };
  out.bob = { localFp: sb.sdp.localFingerprint, remoteFpSeenAsAlice: sb.sdp.remoteFingerprint, transports: sb.transports.map(({ localCert, remoteCert, ...t }) => t) };
  out.relayFingerprint = extractFingerprint(facing.get("alice")!.localDescription!.sdp);
  out.aliceSeesRelayInsteadOfBob = out.alice.remoteFpSeenAsBob === out.relayFingerprint && out.alice.remoteFpSeenAsBob !== out.bob.localFp;
  out.bobSeesRelayInsteadOfAlice = out.bob.remoteFpSeenAsAlice === out.relayFingerprint && out.bob.remoteFpSeenAsAlice !== out.alice.localFp;
  // Proof of plaintext access at the relay: decoded audio level of alice's mic.
  out.relayDecodedAliceAudioPeak = intercepted.alice[0] ? await audioLevel(intercepted.alice[0]) : null;
  // Bob actually receives (relayed) audio.
  out.bobInboundAudio = sb.rtp.filter((r) => r.type === "inbound-rtp");
  out.bobReceivedAudioPeak = await audioLevel(pb.pc.getReceivers()[0].track);
  out.bobInboundAfter = (await statsSummary(pb.pc)).rtp;
  out.relayTowardsBob = (await statsSummary(facing.get("bob")!)).rtp;
  out.relayTransceiversTowardsBob = facing.get("bob")!.getTransceivers().map((t) => ({ mid: t.mid, dir: t.currentDirection, hasTrack: !!t.sender.track }));
  out.errors = [...A.errors, ...B.errors];
  out.resets = [...A.resets, ...B.resets];

  // ---- mid-call key change: relay swaps in a brand-new identity for "bob" towards alice
  const fresh = new RTCPeerConnection(RTC_CONFIG);
  fresh.addTransceiver("audio");
  await fresh.setLocalDescription();
  out.midCallNewFingerprint = extractFingerprint(fresh.localDescription!.sdp);
  const resetsBefore = A.resets.length;
  await pa.handleSignal({ kind: "description", description: { type: "offer", sdp: fresh.localDescription!.sdp } });
  await sleep(500);
  out.midCallKeyChange = { resetsTriggered: A.resets.slice(resetsBefore), errorsRaised: A.errors.length, note: "offer with a different fingerprint -> Peer.onReset('remote-restarted') -> owner recreates peer and replays the attacker offer; no user-visible signal" };
  const np = A.peers.get("bob")!;
  await sleep(300);
  out.midCallNewPeerRemoteFp = extractFingerprint(np.pc.remoteDescription?.sdp);
  fresh.close();
  for (const p of [...A.peers.values(), ...B.peers.values()]) p.close();
}

// ---------------------------------------------------------------- cert: TOFU feasibility + default cert
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open("sec-cert", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("k");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(db: IDBDatabase, k: string): Promise<any> {
  return new Promise((res, rej) => {
    const r = db.transaction("k").objectStore("k").get(k);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(db: IDBDatabase, k: string, v: any) {
  return new Promise<void>((res, rej) => {
    const tx = db.transaction("k", "readwrite");
    tx.objectStore("k").put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function cert() {
  const db = await idb();
  let c: RTCCertificate | undefined = await idbGet(db, "cert");
  out.loadedFromIdb = !!c;
  if (!c) {
    c = await RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256", expires: 365 * 86400e3 } as any);
    await idbPut(db, "cert", c);
  }
  out.expires = new Date(c.expires).toISOString();
  out.certFingerprints = (c as any).getFingerprints?.();
  const pc = new RTCPeerConnection({ certificates: [c] });
  pc.addTransceiver("audio");
  await pc.setLocalDescription();
  out.sdpFingerprint = extractFingerprint(pc.localDescription!.sdp);
  // default (engine) certificate for comparison: fresh every RTCPeerConnection
  const fps: string[] = [];
  for (let i = 0; i < 2; i++) {
    const d = new RTCPeerConnection(RTC_CONFIG);
    d.addTransceiver("audio");
    await d.setLocalDescription();
    fps.push(extractFingerprint(d.localDescription!.sdp)!);
    d.close();
  }
  out.defaultFingerprints = fps;
  // RSA also possible; check generateCertificate acceptance of weak params
  try {
    await RTCPeerConnection.generateCertificate({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as any);
    out.rsa1024Accepted = true;
  } catch (e) {
    out.rsa1024Accepted = `rejected: ${e}`;
  }
  pc.close();
  // Downgrade attempts: can a remote description disable DTLS-SRTP?
  const src = new RTCPeerConnection(RTC_CONFIG);
  src.addTransceiver("audio");
  await src.setLocalDescription();
  const base = src.localDescription!.sdp;
  const variants: Record<string, string> = {
    noFingerprint: base.replace(/^a=fingerprint:.*\r\n/gm, ""),
    plainRtpAvp: base.replace(/UDP\/TLS\/RTP\/SAVPF/g, "RTP/AVP"),
    sdesCrypto: base.replace(/^a=fingerprint:.*\r\n/gm, "").replace(/UDP\/TLS\/RTP\/SAVPF/g, "RTP/SAVPF") + "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:WVNfX19zZW1jdGwgKCkgewkyMjA7fQp9CnVubGVzcyAoZ||2^20|1:32\r\n",
    sha1Fingerprint: base.replace(/^a=fingerprint:sha-256 .*$/m, "a=fingerprint:sha-1 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33"),
  };
  out.downgrade = {};
  for (const [k, v] of Object.entries(variants)) {
    const r = new RTCPeerConnection(RTC_CONFIG);
    try {
      await r.setRemoteDescription({ type: "offer", sdp: v });
      out.downgrade[k] = "ACCEPTED";
    } catch (e) {
      out.downgrade[k] = `rejected: ${String(e).slice(0, 160)}`;
    }
    r.close();
  }
  src.close();
}

(async () => {
  try {
    if (out.mode === "live") await live();
    else if (out.mode === "mitm") await mitm();
    else if (out.mode === "cert") await cert();
  } catch (e: any) {
    out.fatal = String(e?.stack || e);
  }
  (window as any).__result = out;
})();
