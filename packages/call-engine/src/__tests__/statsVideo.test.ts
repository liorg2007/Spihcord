import { describe, expect, it } from "vitest";
import { parseVideoStats } from "../stats";

type S = Record<string, unknown> & { id: string; type: string };
const report = (...stats: S[]) => new Map(stats.map((s) => [s.id, s]));

const codecs: S[] = [
  { id: "COT01_103", type: "codec", mimeType: "video/H264", payloadType: 103 },
  { id: "CIT01_45", type: "codec", mimeType: "video/AV1", payloadType: 45 },
  { id: "COT01_111", type: "codec", mimeType: "audio/opus", payloadType: 111 },
];

describe("parseVideoStats", () => {
  it("parses outbound video (send) with codec, fps, resolution, limitation and bitrate delta", () => {
    const r1 = report(
      ...codecs,
      { id: "OT01V", type: "outbound-rtp", kind: "video", bytesSent: 1_000_000, timestamp: 10_000, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 59, codecId: "COT01_103", qualityLimitationReason: "none" },
      { id: "OT01A", type: "outbound-rtp", kind: "audio", bytesSent: 5_000_000, timestamp: 10_000, codecId: "COT01_111" },
    );
    const a = parseVideoStats(r1);
    expect(a.send).toEqual({ width: 1920, height: 1080, fps: 59, bitrateKbps: undefined, codec: "H264", qualityLimitation: "none", bytes: 1_000_000 });
    expect(a.recv).toBeUndefined();

    const r2 = report(
      ...codecs,
      { id: "OT01V", type: "outbound-rtp", kind: "video", bytesSent: 3_500_000, timestamp: 12_000, frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, codecId: "COT01_103", qualityLimitationReason: "cpu" },
    );
    const b = parseVideoStats(r2, a.counters);
    expect(b.send?.bitrateKbps).toBe(10_000); // 2.5 MB in 2 s
    expect(b.send?.qualityLimitation).toBe("cpu");
    expect(b.send?.width).toBe(1280);
  });

  it("parses inbound video (recv) and ignores audio", () => {
    const prev = { inBytes: 0, inTs: 0 };
    const r = report(
      ...codecs,
      { id: "IT01V", type: "inbound-rtp", kind: "video", bytesReceived: 1_500_000, timestamp: 2000, frameWidth: 2560, frameHeight: 1440, framesPerSecond: 60, codecId: "CIT01_45" },
      { id: "IT01A", type: "inbound-rtp", kind: "audio", bytesReceived: 99_999_999, timestamp: 2000 },
    );
    const p = parseVideoStats(r, prev);
    expect(p.recv).toEqual({ width: 2560, height: 1440, fps: 60, bitrateKbps: 6000, codec: "AV1", bytes: 1_500_000 });
    expect(p.send).toBeUndefined();
  });

  it("handles counter resets, missing fields and unknown limitation reasons", () => {
    const r = report({ id: "OT", type: "outbound-rtp", mediaType: "video", bytesSent: 10, timestamp: 5000, qualityLimitationReason: "weird" });
    const p = parseVideoStats(r, { outBytes: 1000, outTs: 1000 });
    expect(p.send).toEqual({ width: undefined, height: undefined, fps: undefined, bitrateKbps: undefined, codec: undefined, qualityLimitation: undefined, bytes: 10 });
    expect(parseVideoStats(report()).counters).toEqual({});
  });

  it("picks the busiest stream when several exist", () => {
    const r = report(
      { id: "A", type: "outbound-rtp", kind: "video", bytesSent: 10, timestamp: 1, frameWidth: 320 },
      { id: "B", type: "outbound-rtp", kind: "video", bytesSent: 1000, timestamp: 1, frameWidth: 1920 },
    );
    expect(parseVideoStats(r).send?.width).toBe(1920);
  });
});
