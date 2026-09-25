import { afterEach, describe, expect, it } from "vitest";
import {
  CameraPrefs,
  CameraSender,
  cameraEncoding,
  cameraGroupCap,
  kindOfStreamId,
  labelSdpMsids,
  receiverKind,
  sectionKinds,
  type MediaLabel,
} from "../camera";
import { Peer } from "../peer";
import { isPolite } from "../mesh";
import { mungeOutgoingSdp } from "../sdp";
import { CAMERA_CODEC_ORDER, codecName, orderCameraCodecs } from "../codecs";
import { FakeNetwork, FakePC, FakeTransceiver, delay, waitFor } from "./fakeRtc";

const SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "a=msid-semantic: WMS micStream camStream scrStream",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:0",
  "a=msid:micStream micTrack",
  "a=rtpmap:111 opus/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:1",
  "a=msid:camStream camTrack",
  "a=rtpmap:96 VP8/90000",
  "a=ssrc:111 msid:camStream camTrack",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:2",
  "a=msid:scrStream scrTrack",
  "a=rtpmap:96 VP8/90000",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:3",
  "a=msid:scrStream scrAudio",
  "a=rtpmap:111 opus/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:4",
  "a=recvonly",
  "a=rtpmap:96 VP8/90000",
  "",
].join("\r\n");

const labels = new Map<string, MediaLabel>([
  ["micStream", "mic"],
  ["camStream", "camera"],
  ["scrStream", "screen"],
]);

describe("msid kind labelling", () => {
  it("rewrites msid / ssrc msid / msid-semantic and classifies by mid", () => {
    const out = labelSdpMsids(SDP, labels);
    expect(out).toContain("a=msid:cam-camStream camTrack");
    expect(out).toContain("a=ssrc:111 msid:cam-camStream camTrack");
    expect(out).toContain("a=msid:scr-scrStream scrAudio");
    expect(out).toContain("a=msid:mic-micStream micTrack");
    expect(out).toContain("WMS mic-micStream cam-camStream scr-scrStream");
    const kinds = sectionKinds(out);
    expect([...kinds]).toEqual([
      ["0", "mic"],
      ["1", "camera"],
      ["2", "screen"],
      ["3", "screen"],
    ]);
    expect(receiverKind("1", kinds)).toBe("camera");
    expect(receiverKind("2", kinds)).toBe("screen");
    expect(receiverKind("4", kinds)).toBe("screen"); // unlabelled -> legacy (screen)
    expect(receiverKind(null, kinds)).toBe("screen");
  });

  it("is idempotent and deterministic (same output on every renegotiation)", () => {
    const once = labelSdpMsids(SDP, labels);
    expect(labelSdpMsids(once, labels)).toBe(once);
    expect(labelSdpMsids(SDP, labels)).toBe(once);
    // Labels applied after the call munging keep the per-section fmtp work intact.
    const munged = labelSdpMsids(mungeOutgoingSdp(SDP, "0", new Set(["1"])), labels);
    expect(sectionKinds(munged).get("1")).toBe("camera");
  });

  it("unlabelled SDP (older client) gives no kinds; unknown ids are kept", () => {
    expect(sectionKinds(SDP).size).toBe(0);
    expect(labelSdpMsids(SDP, new Map())).toBe(SDP);
    expect(kindOfStreamId("cam-x")).toBe("camera");
    expect(kindOfStreamId("scr-x")).toBe("screen");
    expect(kindOfStreamId("abc")).toBeUndefined();
  });

  it("camera m-lines get their own bitrate hints, screen keeps the screen hints", () => {
    const sdp = SDP.replace(/a=rtpmap:96 VP8\/90000/g, "a=rtpmap:96 VP8/90000\r\na=fmtp:96 x=1");
    const out = mungeOutgoingSdp(sdp, "0", new Set(["1"]));
    const sec = out.split(/(?=^m=)/m);
    expect(sec[2]).toContain("x-google-start-bitrate=1000");
    expect(sec[2]).not.toContain("x-google-min-bitrate");
    expect(sec[3]).toContain("x-google-min-bitrate=1000");
  });
});

describe("camera quality", () => {
  it("group-size cap tiers", () => {
    expect(cameraGroupCap(2)).toMatchObject({ height: 720, maxFramerate: 30, maxBitrate: 1_500_000 });
    expect(cameraGroupCap(3).height).toBe(720);
    expect(cameraGroupCap(4)).toMatchObject({ height: 480, maxFramerate: 30, maxBitrate: 800_000 });
    expect(cameraGroupCap(5).height).toBe(480);
    expect(cameraGroupCap(6)).toMatchObject({ height: 360, maxFramerate: 24, maxBitrate: 400_000 });
    expect(cameraGroupCap(8).height).toBe(360);
  });

  it("preference -> encoding, scaled from the capture height", () => {
    expect(cameraEncoding(720, 3, "high")).toEqual({ active: true, scaleResolutionDownBy: 1, maxFramerate: 30, maxBitrate: 1_500_000 });
    expect(cameraEncoding(720, 5, "high")).toEqual({ active: true, scaleResolutionDownBy: 1.5, maxFramerate: 30, maxBitrate: 800_000 });
    expect(cameraEncoding(1080, 7, "high")).toEqual({ active: true, scaleResolutionDownBy: 3, maxFramerate: 24, maxBitrate: 400_000 });
    expect(cameraEncoding(720, 3, "low")).toEqual({ active: true, scaleResolutionDownBy: 4, maxFramerate: 15, maxBitrate: 150_000 });
    expect(cameraEncoding(480, 3, "off").active).toBe(false);
    // Never upscale; unknown capture height assumes 720p.
    expect(cameraEncoding(360, 2, "high").scaleResolutionDownBy).toBe(1);
    expect(cameraEncoding(undefined, 4, "high").scaleResolutionDownBy).toBe(1.5);
  });

  it("camera codec order: H264 > VP9 > VP8, AV1 only with hardware", () => {
    const caps = ["video/VP8", "video/AV1", "video/rtx", "video/VP9", "video/H264"].map((mimeType) => ({ mimeType, clockRate: 90000 }));
    const names = (hw: string[]) => orderCameraCodecs(caps, new Set(hw)).map((c) => codecName(c.mimeType));
    expect(names([])).toEqual(["H264", "VP9", "VP8", "AV1", "RTX"]);
    expect(names(["AV1", "H264"])).toEqual(["H264", "VP9", "VP8", "AV1", "RTX"]);
    expect(CAMERA_CODEC_ORDER[0]).toBe("H264");
  });
});

describe("CameraPrefs", () => {
  it("viewer side: remembers, dedupes and re-sends on a new connection", () => {
    const p = new CameraPrefs();
    expect(p.signalsForNewPeer("alice")).toEqual([]);
    expect(p.setLocal("alice", "high")).toBeNull(); // default already
    expect(p.setLocal("alice", "off")).toEqual({ kind: "video-pref", camera: "off" });
    expect(p.setLocal("alice", "off")).toBeNull();
    expect(p.signalsForNewPeer("alice")).toEqual([{ kind: "video-pref", camera: "off" }]); // reset / reconnect
    p.peerLeft("alice"); // we keep what we asked for
    expect(p.local("alice")).toBe("off");
    expect(p.setLocal("alice", "high")).toEqual({ kind: "video-pref", camera: "high" });
    expect(p.signalsForNewPeer("alice")).toEqual([]);
  });

  it("sender side: default high, forgotten when the viewer leaves", () => {
    const p = new CameraPrefs();
    expect(p.remote("bob")).toBe("high");
    expect(p.onRemote("bob", "low")).toBe(true);
    expect(p.onRemote("bob", "low")).toBe(false);
    expect(p.remote("bob")).toBe("low");
    p.peerLeft("bob");
    expect(p.remote("bob")).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Renegotiation behaviour with the fake RTCPeerConnection

const created: Peer[] = [];
afterEach(() => {
  for (const p of created.splice(0)) p.close();
});

function side(net: FakeNetwork, id: string, remote: string) {
  let pc!: FakePC;
  const tracks: string[] = [];
  const peer = new Peer({
    userId: remote,
    polite: isPolite(id, remote),
    config: { iceServers: [] },
    createPc: (config) => (pc = new FakePC(config)) as unknown as RTCPeerConnection,
    localTrack: { id: `mic-${id}`, kind: "audio" } as unknown as MediaStreamTrack,
    send: (data) => net.send(id, remote, data),
    onTrack: (t) => tracks.push(t.id),
    timings: { connectTimeoutMs: 60_000, failedTeardownMs: 60_000, disconnectedGraceMs: 20, politeInitialOfferDelayMs: 0 },
  });
  created.push(peer);
  net.register(id, (_f, d) => void peer.handleSignal(d));
  return { peer, pc: () => pc, tracks };
}

const offers = (net: FakeNetwork) => net.log.filter((m) => m.data.kind === "description" && m.data.description.type === "offer").length;
const stable = (...pcs: FakePC[]) => pcs.every((p) => p.signalingState === "stable" && p.connectionState === "connected");

describe("CameraSender renegotiation", () => {
  it("first enable adds a transceiver (one renegotiation); off/on and device switch use replaceTrack only", async () => {
    const net = new FakeNetwork(() => 2);
    const a = side(net, "alice", "bob");
    const b = side(net, "bob", "alice");
    await waitFor(() => stable(a.pc(), b.pc()) && b.tracks.includes("mic-alice"), 3000, "connected");
    await delay(30);
    const before = offers(net);

    const cam1 = { id: "cam-track-1", kind: "video" } as unknown as MediaStreamTrack;
    const cam2 = { id: "cam-track-2", kind: "video" } as unknown as MediaStreamTrack;
    const sender = new CameraSender({ pc: a.pc() as unknown as RTCPeerConnection, msid: { id: "camStream" } as MediaStream });
    const enc = cameraEncoding(720, 3, "high");
    sender.attach(cam1, enc);
    await waitFor(() => b.tracks.includes("cam-track-1") && stable(a.pc(), b.pc()), 3000, "camera negotiated");
    await delay(30);
    const afterAdd = offers(net);
    expect(afterAdd).toBeGreaterThan(before);
    const t = sender.transceiver as unknown as FakeTransceiver;
    expect(t.direction).toBe("sendonly");
    expect(a.pc().transceivers).toHaveLength(1);

    // off -> on -> device switch -> off: no new offers, same transceiver
    sender.detach();
    sender.attach(cam1, enc);
    sender.attach(cam2, enc);
    sender.detach();
    await sender.tune(cameraEncoding(720, 3, "off"));
    await delay(50);
    expect(offers(net)).toBe(afterAdd);
    expect(a.pc().transceivers).toHaveLength(1);
    expect(t.sender.replaceCalls).toEqual([null, cam1, cam2, null]);
    expect(t.direction).toBe("sendonly");
    expect(t.sender.params.encodings[0]).toMatchObject({ active: false });
    expect(t.sender.params.degradationPreference).toBe("balanced");
    expect(sender.isAttached).toBe(false);
  });

  it("preference changes are serialized setParameters (last one wins)", async () => {
    const pc = new FakePC({});
    const sender = new CameraSender({ pc: pc as unknown as RTCPeerConnection, msid: { id: "s" } as MediaStream });
    sender.attach({ id: "c" } as MediaStreamTrack, cameraEncoding(720, 3, "high"));
    void sender.tune(cameraEncoding(720, 3, "low"));
    void sender.tune(cameraEncoding(720, 3, "off"));
    await sender.tune(cameraEncoding(720, 5, "high"));
    const t = sender.transceiver as unknown as FakeTransceiver;
    expect(t.sender.params.encodings[0]).toMatchObject({ active: true, maxBitrate: 800_000, scaleResolutionDownBy: 1.5, maxFramerate: 30 });
    pc.close();
  });
});
