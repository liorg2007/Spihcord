import { describe, expect, it } from "vitest";
import { extractFingerprint, mungeCodecFmtp, mungeOpusForVoice, parseFmtp } from "../sdp";

const BASE = [
  "v=0",
  "o=- 123 2 IN IP4 127.0.0.1",
  "a=fingerprint:sha-256 AB:CD:EF",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "a=rtpmap:9 G722/8000",
  "",
].join("\r\n");

function fmtpFor(sdp: string, pt: string): string | undefined {
  return new RegExp(`^a=fmtp:${pt} (.*)$`, "m").exec(sdp)?.[1]?.replace(/\r$/, "");
}

describe("sdp munging", () => {
  it("adds voice params while keeping existing ones, without duplicates", () => {
    const out = mungeOpusForVoice(BASE);
    const params = parseFmtp(fmtpFor(out, "111")!);
    expect(params).toEqual([
      ["minptime", "10"],
      ["useinbandfec", "1"],
      ["usedtx", "1"],
      ["stereo", "0"],
      ["maxaveragebitrate", "64000"],
    ]);
    expect(out.match(/a=fmtp:111/g)).toHaveLength(1);
  });

  it("is idempotent", () => {
    const once = mungeOpusForVoice(BASE);
    expect(mungeOpusForVoice(once)).toBe(once);
  });

  it("overrides conflicting values and removes duplicate keys", () => {
    const sdp = BASE.replace("a=fmtp:111 minptime=10;useinbandfec=1", "a=fmtp:111 stereo=1; usedtx=0;stereo=1;minptime=10");
    const params = parseFmtp(fmtpFor(mungeOpusForVoice(sdp), "111")!);
    expect(params).toEqual([
      ["stereo", "0"],
      ["usedtx", "1"],
      ["minptime", "10"],
      ["useinbandfec", "1"],
      ["maxaveragebitrate", "64000"],
    ]);
  });

  it("does not touch other codecs and preserves CRLF + trailing newline", () => {
    const out = mungeOpusForVoice(BASE);
    expect(fmtpFor(out, "63")).toBe("111/111");
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out.split("\r\n").length).toBe(BASE.split("\r\n").length);
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it("inserts an fmtp line after rtpmap when missing, for every opus payload type", () => {
    const sdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=rtcp-fb:111 nack",
      "m=audio 9 UDP/TLS/RTP/SAVPF 109",
      "a=rtpmap:109 OPUS/48000/2",
      "a=fmtp:109 minptime=20",
    ].join("\n");
    const out = mungeOpusForVoice(sdp);
    const lines = out.split("\n");
    expect(lines[3]).toBe("a=fmtp:111 useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=64000");
    expect(fmtpFor(out, "109")).toBe("minptime=20;useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=64000");
    expect(out.endsWith("\n")).toBe(false);
  });

  it("returns the input unchanged when there is no opus", () => {
    const sdp = "v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n";
    expect(mungeCodecFmtp(sdp, { usedtx: 1 })).toBe(sdp);
  });

  it("extracts fingerprints", () => {
    expect(extractFingerprint(BASE)).toBe("sha-256 ab:cd:ef");
    expect(extractFingerprint("v=0")).toBeUndefined();
    expect(extractFingerprint(undefined)).toBeUndefined();
  });
});
