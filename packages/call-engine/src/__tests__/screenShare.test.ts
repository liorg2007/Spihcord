import { describe, expect, it } from "vitest";
import { CpuWatch, ScreenShareIntents, isHighPreset, isStreamSignal, screenEncoding } from "../screenShare";
import { SCREEN_SHARE_PRESETS } from "../presets";

describe("ScreenShareIntents (sharer side)", () => {
  it("remembers a watch that arrives before the share starts", () => {
    const s = new ScreenShareIntents();
    s.onRemoteSignal("bob", "watch");
    expect(s.shouldSendTo("bob")).toBe(false);
    expect(s.targets(["bob", "carol"])).toEqual([]);
    s.setSharing(true);
    expect(s.shouldSendTo("bob")).toBe(true);
    expect(s.targets(["bob", "carol"])).toEqual(["bob"]);
  });

  it("unwatch stops sending; only present peers are targets", () => {
    const s = new ScreenShareIntents();
    s.setSharing(true);
    s.onRemoteSignal("bob", "watch");
    s.onRemoteSignal("carol", "watch");
    expect(s.targets(["carol", "bob"])).toEqual(["bob", "carol"]);
    expect(s.targets(["bob"])).toEqual(["bob"]);
    s.onRemoteSignal("bob", "unwatch");
    expect(s.targets(["bob", "carol"])).toEqual(["carol"]);
  });

  it("keeps watchers across a stop/restart (and a replacement share)", () => {
    const s = new ScreenShareIntents();
    s.setSharing(true);
    s.onRemoteSignal("bob", "watch");
    s.setSharing(false);
    expect(s.targets(["bob"])).toEqual([]);
    expect(s.hasWatcher("bob")).toBe(true);
    s.setSharing(true);
    expect(s.targets(["bob"])).toEqual(["bob"]);
  });

  it("forgets intent when the peer leaves the channel (not on a connection reset)", () => {
    const s = new ScreenShareIntents();
    s.setSharing(true);
    s.onRemoteSignal("bob", "watch");
    // A reset keeps the entry: nothing to call, the next connection is attached again.
    expect(s.shouldSendTo("bob")).toBe(true);
    s.peerLeft("bob");
    expect(s.shouldSendTo("bob")).toBe(false);
    expect(s.targets(["bob"])).toEqual([]);
  });
});

describe("ScreenShareIntents (viewer side)", () => {
  it("produces watch/unwatch signals and resends watch for a recreated connection", () => {
    const s = new ScreenShareIntents();
    expect(s.signalsForNewPeer("alice")).toEqual([]);
    expect(s.watch("alice", true)).toEqual({ kind: "stream", action: "watch" });
    expect(s.isWatching("alice")).toBe(true);
    // peer reset / reconnect -> the new connection re-sends the intent
    expect(s.signalsForNewPeer("alice")).toEqual([{ kind: "stream", action: "watch" }]);
    expect(s.watch("alice", false)).toEqual({ kind: "stream", action: "unwatch" });
    expect(s.signalsForNewPeer("alice")).toEqual([]);
  });

  it("clears the viewer intent when the sharer leaves", () => {
    const s = new ScreenShareIntents();
    s.watch("alice", true);
    s.peerLeft("alice");
    expect(s.isWatching("alice")).toBe(false);
    expect(s.signalsForNewPeer("alice")).toEqual([]);
  });

  it("recognizes stream signals", () => {
    expect(isStreamSignal({ kind: "stream", action: "watch" })).toBe(true);
    expect(isStreamSignal({ kind: "candidate", candidate: null })).toBe(false);
  });
});

describe("screenEncoding", () => {
  it("maps presets to sender parameters", () => {
    expect(screenEncoding(SCREEN_SHARE_PRESETS.gaming)).toEqual({
      maxBitrate: 12_000_000,
      maxFramerate: 60,
      scaleResolutionDownBy: 1,
      degradationPreference: "maintain-framerate",
    });
    expect(screenEncoding(SCREEN_SHARE_PRESETS.text)).toMatchObject({
      maxFramerate: 15,
      degradationPreference: "maintain-resolution",
    });
    expect(screenEncoding(SCREEN_SHARE_PRESETS.gaming, { fpsFactor: 0.5, scale: 1 }).maxFramerate).toBe(30);
  });

  it("classifies high presets", () => {
    expect(isHighPreset(SCREEN_SHARE_PRESETS.gaming)).toBe(true);
    expect(isHighPreset(SCREEN_SHARE_PRESETS.source)).toBe(true);
    expect(isHighPreset(SCREEN_SHARE_PRESETS.text)).toBe(true); // 4K
    expect(isHighPreset({ ...SCREEN_SHARE_PRESETS.balanced, frameRate: 30 })).toBe(false);
  });
});

describe("CpuWatch", () => {
  const gaming = SCREEN_SHARE_PRESETS.gaming;
  it("downgrades only after >10s of sustained cpu limitation", () => {
    const w = new CpuWatch(10_000);
    expect(w.update("cpu", gaming, 0)).toBeUndefined();
    expect(w.update("cpu", gaming, 6_000)).toBeUndefined();
    expect(w.update("none", gaming, 8_000)).toBeUndefined(); // interrupted
    expect(w.update("cpu", gaming, 9_000)).toBeUndefined();
    expect(w.update("cpu", gaming, 18_000)).toBeUndefined();
    expect(w.update("cpu", gaming, 19_000)).toEqual({ fpsFactor: 0.5, scale: 1 });
    // next step needs another sustained period
    expect(w.update("cpu", gaming, 25_000)).toBeUndefined();
    expect(w.update("cpu", gaming, 29_000)).toEqual({ fpsFactor: 0.5, scale: 1.5 });
    w.reset();
    expect(w.downgrade).toEqual({ fpsFactor: 1, scale: 1 });
  });

  it("scales resolution for detail content and ignores low presets", () => {
    const w = new CpuWatch(1000);
    w.update("cpu", SCREEN_SHARE_PRESETS.text, 0);
    expect(w.update("cpu", SCREEN_SHARE_PRESETS.text, 1000)).toEqual({ fpsFactor: 1, scale: 1.5 });
    const low = new CpuWatch(1000);
    const lowPreset = { ...SCREEN_SHARE_PRESETS.balanced, frameRate: 30 };
    low.update("cpu", lowPreset, 0);
    expect(low.update("cpu", lowPreset, 5000)).toBeUndefined();
  });
});
