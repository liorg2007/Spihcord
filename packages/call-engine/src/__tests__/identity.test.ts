import { afterEach, describe, expect, it } from "vitest";
import type { SignalData } from "@shpihcord/protocol";
import { computeSafetyNumber, extractSessionId, normalizeFingerprint, parseDtlsFingerprint } from "../identity";
import { Peer, type IdentityEvent, type ResetReason } from "../peer";
import { isPolite } from "../mesh";
import { FakeNetwork, FakePC, delay, fakeCertificate, fakeFingerprint, waitFor } from "./fakeRtc";

const FP1 = fakeFingerprint(1);
const FP2 = fakeFingerprint(2);

describe("parseDtlsFingerprint", () => {
  const sdp = (lines: string[]) => ["v=0", "o=- 42 2 IN IP4 127.0.0.1", ...lines, ""].join("\r\n");

  it("accepts consistent sha-256 lines and canonicalizes them", () => {
    const lower = FP1.replace("sha-256 ", "").toLowerCase();
    const r = parseDtlsFingerprint(sdp([`a=fingerprint:SHA-256 ${lower}`, "m=audio 9 UDP/TLS/RTP/SAVPF 111", `a=fingerprint:${FP1}`]));
    expect(r).toEqual({ ok: true, fingerprint: FP1 });
  });

  it("rejects missing, non-sha-256, malformed and disagreeing fingerprints", () => {
    expect(parseDtlsFingerprint(sdp([])).ok).toBe(false);
    expect(parseDtlsFingerprint(undefined).ok).toBe(false);
    expect(parseDtlsFingerprint(sdp(["a=fingerprint:sha-1 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33"])).ok).toBe(false);
    expect(parseDtlsFingerprint(sdp(["a=fingerprint:sha-256 AB:CD"])).ok).toBe(false);
    const two = parseDtlsFingerprint(sdp([`a=fingerprint:${FP1}`, "m=audio 9 UDP/TLS/RTP/SAVPF 111", `a=fingerprint:${FP2}`]));
    expect(two).toEqual({ ok: false, reason: "a=fingerprint lines disagree" });
    // A sha-256 line next to a sha-512 one is still rejected (only sha-256 is pinned).
    expect(parseDtlsFingerprint(sdp([`a=fingerprint:${FP1}`, "a=fingerprint:sha-512 AA:BB"])).ok).toBe(false);
  });

  it("normalizes RTCDtlsFingerprint objects and reads the o= session id", () => {
    const [algorithm, value] = FP1.split(" ");
    expect(normalizeFingerprint({ algorithm, value: value.toLowerCase() })).toBe(FP1);
    expect(normalizeFingerprint({ algorithm: "sha-1", value })).toBeUndefined();
    expect(extractSessionId("v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n")).toBe("4611731400430051336");
  });
});

describe("computeSafetyNumber", () => {
  it("is identical on both sides, formatted and key-dependent", async () => {
    const ab = await computeSafetyNumber(FP1, FP2);
    const ba = await computeSafetyNumber(FP2, FP1);
    expect(ab).toBe(ba);
    expect(ab).toMatch(/^\d{5} \d{5} \d{5} \d{5} \d{5}$/);
    // Case/format of the input doesn't matter.
    expect(await computeSafetyNumber(FP1.toLowerCase(), FP2)).toBe(ab);
    expect(await computeSafetyNumber(FP1, fakeFingerprint(3))).not.toBe(ab);
  });
});

// ---------------------------------------------------------------------------
// Peer + verifyFingerprint

interface Side {
  id: string;
  peer: Peer;
  pc: FakePC;
  errors: string[];
  resets: Array<{ reason: ResetReason; replay?: SignalData[] }>;
  identity: IdentityEvent[];
  tracks: string[];
}

const created: Peer[] = [];
afterEach(() => {
  for (const p of created.splice(0)) p.close();
});

/** A TOFU pin store like the desktop's: pin on first sight, then require a match. */
function pinStore() {
  const pins = new Map<string, string>();
  return {
    pins,
    verify: (userId: string, fp: string) => {
      const pinned = pins.get(userId);
      if (!pinned) {
        pins.set(userId, fp);
        return { trusted: true as const };
      }
      return pinned === fp ? { trusted: true as const } : { trusted: false as const, expected: pinned };
    },
  };
}

function makeSide(
  net: FakeNetwork,
  id: string,
  remote: string,
  cert: RTCCertificate,
  store: ReturnType<typeof pinStore>,
  onReset?: (reason: ResetReason, replay?: SignalData[]) => void,
): Side {
  let pc!: FakePC;
  const side = { id, errors: [], resets: [], identity: [], tracks: [] } as unknown as Side;
  const peer = new Peer({
    userId: remote,
    polite: isPolite(id, remote),
    config: { iceServers: [], certificates: [cert] },
    createPc: (config) => {
      pc = new FakePC(config);
      return pc as unknown as RTCPeerConnection;
    },
    localTrack: { id: `track-${id}`, kind: "audio" } as unknown as MediaStreamTrack,
    send: (data) => net.send(id, remote, data),
    onTrack: (track) => side.tracks.push(track.id),
    onError: (m) => side.errors.push(m),
    onReset: (reason, replay) => {
      side.resets.push({ reason, replay });
      onReset?.(reason, replay);
    },
    verifyFingerprint: (fp) => store.verify(remote, fp),
    onIdentity: (ev) => side.identity.push(ev),
    timings: { connectTimeoutMs: 60_000, failedTeardownMs: 60_000, disconnectedGraceMs: 20, politeInitialOfferDelayMs: 0 },
  });
  created.push(peer);
  side.peer = peer;
  side.pc = pc;
  net.register(id, (_from, data) => void side.peer.handleSignal(data));
  return side;
}

const connected = (a: Side, b: Side) =>
  a.pc.connectionState === "connected" && b.pc.connectionState === "connected" && a.pc.signalingState === "stable" && b.pc.signalingState === "stable";

describe("Peer identity pinning", () => {
  it("pins on first use, uses the long-term certificate and reports the trusted fingerprint", async () => {
    const net = new FakeNetwork(() => 2);
    const sa = pinStore();
    const sb = pinStore();
    const a = makeSide(net, "a", "b", fakeCertificate(10), sa);
    const b = makeSide(net, "b", "a", fakeCertificate(11), sb);
    await waitFor(() => connected(a, b), 2000, "connected");
    expect(a.pc.fingerprint).toBe(fakeFingerprint(10));
    expect(sa.pins.get("b")).toBe(fakeFingerprint(11));
    expect(sb.pins.get("a")).toBe(fakeFingerprint(10));
    expect(a.identity).toEqual([{ status: "trusted", fingerprint: fakeFingerprint(11) }]);
    expect(a.peer.remoteFingerprint).toBe(fakeFingerprint(11));
    expect(a.errors.concat(b.errors)).toEqual([]);
  });

  it("blocks a substituted fingerprint: nothing is applied and no connection forms", async () => {
    const net = new FakeNetwork(() => 2);
    const sa = pinStore();
    sa.pins.set("b", fakeFingerprint(11)); // pinned earlier
    const a = makeSide(net, "a", "b", fakeCertificate(10), sa);
    const b = makeSide(net, "b", "a", fakeCertificate(66), pinStore()); // attacker's key
    await waitFor(() => a.identity.length > 0, 2000, "mismatch");
    await delay(50);
    expect(a.identity[0]).toEqual({ status: "mismatch", expected: fakeFingerprint(11), received: fakeFingerprint(66), reason: "changed" });
    expect(a.peer.isBlocked).toBe(true);
    expect(a.pc.currentRemoteDescription).toBeNull();
    expect(a.pc.connectionState).not.toBe("connected");
    expect(b.pc.connectionState).not.toBe("connected");
    expect(a.pc.addedCandidates).toEqual([]); // candidates are held back too
    const held = a.peer.takeBlocked();
    expect(held?.description.kind).toBe("description");
    expect(held?.candidates.length).toBeGreaterThan(0);
  });

  it("rejects disagreeing fingerprint lines as invalid", async () => {
    const net = new FakeNetwork(() => 1);
    const a = makeSide(net, "a", "b", fakeCertificate(10), pinStore());
    net.register("b", () => undefined);
    const sdp = ["v=0", "o=- 5 2 IN IP4 127.0.0.1", `a=fingerprint:${FP1}`, "m=audio 9 UDP/TLS/RTP/SAVPF 111", `a=fingerprint:${FP2}`, ""].join("\r\n");
    await a.peer.handleSignal({ kind: "description", description: { type: "offer", sdp } });
    expect(a.identity).toEqual([{ status: "mismatch", expected: "", received: "a=fingerprint lines disagree", reason: "invalid" }]);
    expect(a.pc.remoteDescription).toBeNull();
  });

  it("a remote restart with the same long-term key is detected by the o= session id and reconnects", async () => {
    const net = new FakeNetwork(() => 2);
    const sa = pinStore();
    const aSides: Side[] = [];
    let a!: Side;
    const spawnA = (replay: SignalData[] = []) => {
      a = makeSide(net, "a", "b", fakeCertificate(10), sa, (_r, rp) => {
        a.peer.close();
        spawnA(rp ?? []);
      });
      aSides.push(a);
      for (const s of replay) void a.peer.handleSignal(s);
    };
    spawnA();
    const certB = fakeCertificate(11);
    let b = makeSide(net, "b", "a", certB, pinStore());
    await waitFor(() => connected(a, b), 2000, "initial");
    b.peer.close();
    b = makeSide(net, "b", "a", certB, pinStore());
    await waitFor(() => connected(a, b), 3000, "reconnected");
    expect(aSides[0].resets[0]?.reason).toBe("remote-restarted");
    expect(aSides.flatMap((s) => s.identity).every((e) => e.status === "trusted")).toBe(true);
  });

  it("a mid-call key change goes through the reset path and ends up blocked (no silent switch)", async () => {
    const net = new FakeNetwork(() => 2);
    const sa = pinStore();
    const aSides: Side[] = [];
    let a!: Side;
    const spawnA = (replay: SignalData[] = []) => {
      a = makeSide(net, "a", "b", fakeCertificate(10), sa, (_r, rp) => {
        a.peer.close();
        spawnA(rp ?? []);
      });
      aSides.push(a);
      for (const s of replay) void a.peer.handleSignal(s);
    };
    spawnA();
    let b = makeSide(net, "b", "a", fakeCertificate(11), pinStore());
    await waitFor(() => connected(a, b), 2000, "initial");
    b.peer.close();
    b = makeSide(net, "b", "a", fakeCertificate(77), pinStore()); // new key mid-call
    await waitFor(() => a.identity.some((e) => e.status === "mismatch"), 3000, "blocked");
    await delay(50);
    expect(aSides[0].resets[0]?.reason).toBe("remote-restarted");
    expect(a.peer.isBlocked).toBe(true);
    expect(a.pc.connectionState).not.toBe("connected");
    expect(a.identity.at(-1)).toMatchObject({ status: "mismatch", expected: fakeFingerprint(11), received: fakeFingerprint(77) });

    // "Trust new key": update the pin, recreate with the held-back offer replayed.
    sa.pins.set("b", fakeFingerprint(77));
    const held = a.peer.takeBlocked()!;
    a.peer.close();
    spawnA([held.description, ...held.candidates]);
    await waitFor(() => connected(a, b), 3000, "reconnected after trust");
    expect(a.peer.remoteFingerprint).toBe(fakeFingerprint(77));
  });

  it("setConfiguration keeps working when passed the same certificate object", () => {
    const net = new FakeNetwork(() => 1);
    const cert = fakeCertificate(10);
    const a = makeSide(net, "a", "b", cert, pinStore());
    a.peer.setConfiguration({ iceServers: [{ urls: "stun:x" }], certificates: [cert] });
    expect(a.errors).toEqual([]);
    a.peer.setConfiguration({ iceServers: [], certificates: [fakeCertificate(10)] });
    expect(a.errors.length).toBe(1); // a different object is rejected, like Chromium
  });
});
