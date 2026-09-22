import { afterEach, describe, expect, it } from "vitest";
import type { SignalData } from "@shpihcord/protocol";
import { Peer, type PeerOptions, type ResetReason } from "../peer";
import { isPolite } from "../mesh";
import { FakeNetwork, FakePC, mulberry32, parseUfrag, waitFor, delay } from "./fakeRtc";

interface Side {
  id: string;
  peer: Peer;
  pc: FakePC;
  errors: string[];
  resets: Array<{ reason: ResetReason; replay?: SignalData[] }>;
  tracks: string[];
}

const created: Peer[] = [];

function makeSide(
  net: FakeNetwork,
  id: string,
  remote: string,
  opts: { opDelay?: () => number; onReset?: PeerOptions["onReset"]; register?: boolean } = {},
): Side {
  let pc!: FakePC;
  const side = { id, errors: [], resets: [], tracks: [] } as unknown as Side;
  const peer = new Peer({
    userId: remote,
    polite: isPolite(id, remote),
    config: { iceServers: [] },
    createPc: (config) => {
      pc = new FakePC(config, opts.opDelay);
      return pc as unknown as RTCPeerConnection;
    },
    localTrack: { id: `track-${id}`, kind: "audio" } as unknown as MediaStreamTrack,
    send: (data) => net.send(id, remote, data),
    onTrack: (track) => side.tracks.push(track.id),
    onError: (m) => side.errors.push(m),
    onReset: (reason, replay) => {
      side.resets.push({ reason, replay });
      opts.onReset?.(reason, replay);
    },
    // politeInitialOfferDelayMs: 0 keeps both sides offering at once, so glare is still exercised.
    timings: { connectTimeoutMs: 60_000, failedTeardownMs: 60_000, disconnectedGraceMs: 20, politeInitialOfferDelayMs: 0 },
  });
  created.push(peer);
  side.peer = peer;
  side.pc = pc;
  if (opts.register !== false) net.register(id, (_from, data) => void side.peer.handleSignal(data));
  return side;
}

function settled(a: Side, b: Side): boolean {
  return (
    a.pc.connectionState === "connected" &&
    b.pc.connectionState === "connected" &&
    a.pc.signalingState === "stable" &&
    b.pc.signalingState === "stable" &&
    a.tracks.includes(`track-${b.id}`) &&
    b.tracks.includes(`track-${a.id}`)
  );
}

afterEach(() => {
  for (const p of created.splice(0)) p.close();
});

describe("Peer perfect negotiation", () => {
  it("connects when both sides negotiate simultaneously (glare)", async () => {
    const net = new FakeNetwork(() => 3);
    const a = makeSide(net, "alice", "bob");
    const b = makeSide(net, "bob", "alice");
    await waitFor(() => settled(a, b), 3000, "connected");

    // Both sides really did send an offer, i.e. there was a collision.
    const offers = net.log.filter((m) => m.data.kind === "description" && m.data.description.type === "offer");
    expect(new Set(offers.map((o) => o.from))).toEqual(new Set(["alice", "bob"]));
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(a.pc.addedCandidates.length).toBeGreaterThan(0);

    // Outgoing SDP is munged for voice.
    for (const m of net.log) {
      if (m.data.kind === "description") expect(m.data.description.sdp).toContain("usedtx=1");
    }

    // Quiescent afterwards: no negotiation loop.
    const count = net.log.length;
    await delay(50);
    expect(net.log.filter((m) => m.data.kind === "description").length).toBe(
      net.log.slice(0, count).filter((m) => m.data.kind === "description").length,
    );
  });

  it("converges under randomized latencies and operation delays", async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed);
      const net = new FakeNetwork(() => Math.floor(rnd() * 8));
      const opDelay = () => Math.floor(rnd() * 3);
      const a = makeSide(net, "a-user", "b-user", { opDelay });
      if (rnd() < 0.5) await delay(Math.floor(rnd() * 6));
      const b = makeSide(net, "b-user", "a-user", { opDelay });
      await waitFor(() => settled(a, b), 4000, `connected (seed ${seed})`);
      expect(a.errors, `seed ${seed}`).toEqual([]);
      expect(b.errors, `seed ${seed}`).toEqual([]);
      a.peer.close();
      b.peer.close();
    }
  });

  it("impolite side restarts ICE on failure and renegotiates", async () => {
    const net = new FakeNetwork(() => 1);
    const a = makeSide(net, "a", "b"); // polite
    const b = makeSide(net, "b", "a"); // impolite
    await waitFor(() => settled(a, b));
    const ufragBefore = parseUfrag(b.pc.currentLocalDescription?.sdp);

    a.pc.setConnectionState("failed");
    b.pc.setConnectionState("failed");
    await waitFor(
      () => parseUfrag(b.pc.currentLocalDescription?.sdp) !== ufragBefore && a.pc.signalingState === "stable",
      3000,
      "ice restart",
    );
    // Only the impolite side initiated the restart.
    expect(parseUfrag(a.pc.currentLocalDescription?.sdp)).toBe("u0");
    expect(a.errors.concat(b.errors)).toEqual([]);
  });

  it("restarts ICE after a prolonged 'disconnected' (impolite side only)", async () => {
    const net = new FakeNetwork(() => 1);
    const a = makeSide(net, "a", "b");
    const b = makeSide(net, "b", "a");
    await waitFor(() => settled(a, b));
    b.pc.setConnectionState("disconnected");
    await waitFor(() => parseUfrag(b.pc.currentLocalDescription?.sdp) === "u1", 3000, "restart after grace");
  });

  it("requests a reset when the remote side comes back with a new session", async () => {
    const net = new FakeNetwork(() => 1);
    let a!: Side;
    const aSides: Side[] = [];
    const spawnA = (replay: SignalData[] = []) => {
      a = makeSide(net, "a", "b", {
        onReset: (_r, signals) => {
          a.peer.close();
          spawnA(signals ?? []);
        },
      });
      aSides.push(a);
      for (const s of replay) void a.peer.handleSignal(s);
    };
    spawnA();
    let b = makeSide(net, "b", "a");
    await waitFor(() => settled(a, b));

    // B "reloads": its old connection vanishes and a fresh one negotiates.
    b.peer.close();
    b = makeSide(net, "b", "a");
    await waitFor(() => settled(a, b), 3000, "reconnected");
    expect(aSides[0].resets[0]?.reason).toBe("remote-restarted");
    expect(aSides.length).toBe(2);
  });

  it("ignores stale candidates without surfacing errors", async () => {
    const net = new FakeNetwork(() => 1);
    const a = makeSide(net, "a", "b", { register: false });
    await a.peer.handleSignal({
      kind: "candidate",
      candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 9 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    });
    await a.peer.handleSignal({ kind: "candidate", candidate: null });
    expect(a.errors).toEqual([]);
  });
});
