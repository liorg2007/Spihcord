import { describe, expect, it } from "vitest";
import { codecName, h264Rank, mediaCapabilitiesContentType, orderVideoCodecs, type CodecLike } from "../codecs";

// Shape of Chromium 152 RTCRtpReceiver.getCapabilities('video').codecs
const caps: CodecLike[] = [
  { mimeType: "video/VP8", clockRate: 90000 },
  { mimeType: "video/rtx", clockRate: 90000 },
  { mimeType: "video/VP9", clockRate: 90000, sdpFmtpLine: "profile-id=0" },
  { mimeType: "video/VP9", clockRate: 90000, sdpFmtpLine: "profile-id=2" },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f" },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f" },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f" },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f" },
  { mimeType: "video/AV1", clockRate: 90000, sdpFmtpLine: "level-idx=5;profile=0;tier=0" },
  { mimeType: "video/red", clockRate: 90000 },
  { mimeType: "video/ulpfec", clockRate: 90000 },
  { mimeType: "video/flexfec-03", clockRate: 90000, sdpFmtpLine: "repair-window=10000000" },
];

const label = (c: CodecLike) => {
  const plid = /profile-level-id=(\w+)/.exec(c.sdpFmtpLine ?? "")?.[1];
  const pm = /packetization-mode=(\d)/.exec(c.sdpFmtpLine ?? "")?.[1];
  const vp9 = /profile-id=(\d)/.exec(c.sdpFmtpLine ?? "")?.[1];
  return codecName(c.mimeType) + (plid ? `:${plid}/${pm}` : "") + (vp9 ? `:${vp9}` : "");
};

describe("orderVideoCodecs", () => {
  it("software only: H264 (best profile first) > VP9 > VP8 > AV1, aux codecs last", () => {
    const out = orderVideoCodecs(caps).map(label);
    expect(out).toEqual([
      "H264:640c1f/1",
      "H264:4d001f/1",
      "H264:42e01f/1",
      "H264:42e01f/0",
      "H264:42001f/1",
      "VP9:0",
      "VP9:2",
      "VP8",
      "AV1",
      "RTX",
      "RED",
      "ULPFEC",
      "FLEXFEC-03",
    ]);
    expect(out.length).toBe(caps.length);
  });

  it("hardware AV1 goes first; hardware codecs precede software ones", () => {
    const out = orderVideoCodecs(caps, { hardware: new Set(["AV1", "H264"]) }).map(label);
    expect(out.slice(0, 2)).toEqual(["H264:640c1f/1", "H264:4d001f/1"]);
    const hwAv1 = orderVideoCodecs(caps, { hardware: new Set(["AV1"]) }).map(label);
    expect(hwAv1[0]).toBe("AV1");
    expect(hwAv1[1]).toBe("H264:640c1f/1");
    const hwVp9 = orderVideoCodecs(caps, { hardware: new Set(["VP9"]) }).map(label);
    expect(hwVp9.slice(0, 3)).toEqual(["VP9:0", "VP9:2", "H264:640c1f/1"]);
  });

  it("respects a custom order and does not promote codecs we cannot send", () => {
    const out = orderVideoCodecs(caps, { order: ["VP9", "VP8", "H264"], sendable: new Set(["VP8", "H264"]) }).map(label);
    expect(out[0]).toBe("VP8");
    expect(out[1]).toBe("H264:640c1f/1");
    expect(out.indexOf("VP9:0")).toBeGreaterThan(out.indexOf("H264:42001f/1"));
    expect(out.slice(-4)).toEqual(["RTX", "RED", "ULPFEC", "FLEXFEC-03"]);
  });

  it("ranks H264 profiles and builds mediaCapabilities content types", () => {
    expect(h264Rank("profile-level-id=64001f;packetization-mode=1")).toBeLessThan(h264Rank("profile-level-id=4d001f;packetization-mode=1"));
    expect(h264Rank("profile-level-id=42e01f;packetization-mode=1")).toBeLessThan(h264Rank("profile-level-id=42e01f;packetization-mode=0"));
    expect(h264Rank("profile-level-id=f4001f;packetization-mode=1")).toBeGreaterThan(h264Rank("profile-level-id=42001f;packetization-mode=0"));
    expect(mediaCapabilitiesContentType(caps[7])).toBe("video/H264;profile-level-id=4d001f");
    expect(mediaCapabilitiesContentType(caps[9])).toBe("video/AV1");
  });
});
