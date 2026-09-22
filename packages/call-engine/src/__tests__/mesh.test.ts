import { describe, expect, it } from "vitest";
import type { SignalData } from "@shpihcord/protocol";
import { SignalBuffer, diffPeers, isPolite } from "../mesh";

const cand = (n: number): SignalData => ({
  kind: "candidate",
  candidate: { candidate: `candidate:${n}`, sdpMid: "0", sdpMLineIndex: 0 },
});
const offer: SignalData = { kind: "description", description: { type: "offer", sdp: "v=0" } };

describe("diffPeers", () => {
  it("adds and removes, ignoring self and duplicates", () => {
    expect(diffPeers(["b", "c"], ["me", "c", "d", "d", ""], "me")).toEqual({ added: ["d"], removed: ["b"] });
  });
  it("no-op when equal", () => {
    expect(diffPeers(new Set(["a"]), ["a"], "me")).toEqual({ added: [], removed: [] });
  });
  it("removes everything on empty", () => {
    expect(diffPeers(["a", "b"], [], "me")).toEqual({ added: [], removed: ["a", "b"] });
  });
});

describe("isPolite", () => {
  it("is antisymmetric", () => {
    expect(isPolite("a", "b")).toBe(true);
    expect(isPolite("b", "a")).toBe(false);
  });
});

describe("SignalBuffer", () => {
  it("buffers per sender and replays in order", () => {
    const b = new SignalBuffer();
    b.push("x", offer, 0);
    b.push("x", cand(1), 1);
    b.push("y", cand(9), 1);
    expect(b.take("x", 2)).toEqual([offer, cand(1)]);
    expect(b.take("x", 2)).toEqual([]);
    expect(b.size("y")).toBe(1);
  });

  it("drops signals older than the TTL", () => {
    const b = new SignalBuffer({ ttlMs: 10_000 });
    b.push("x", offer, 0);
    b.push("x", cand(1), 5_000);
    expect(b.take("x", 12_000)).toEqual([cand(1)]);
    b.push("y", offer, 0);
    b.prune(20_000);
    expect(b.size()).toBe(0);
  });

  it("bounds the per-sender queue, keeping the newest", () => {
    const b = new SignalBuffer({ maxPerSender: 3 });
    for (let i = 0; i < 5; i++) b.push("x", cand(i), i);
    expect(b.take("x", 10)).toEqual([cand(2), cand(3), cand(4)]);
  });

  it("bounds the number of senders", () => {
    const b = new SignalBuffer({ maxSenders: 2 });
    b.push("a", offer, 0);
    b.push("b", offer, 1);
    b.push("c", offer, 2);
    expect(b.size("a")).toBe(0);
    expect(b.size("b")).toBe(1);
    expect(b.size("c")).toBe(1);
  });

  it("drop() discards a sender", () => {
    const b = new SignalBuffer();
    b.push("a", offer, 0);
    b.drop("a");
    expect(b.take("a", 0)).toEqual([]);
  });
});
