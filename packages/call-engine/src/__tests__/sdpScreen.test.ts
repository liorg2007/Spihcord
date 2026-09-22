import { describe, expect, it } from "vitest";
import {
  hasScreenAudioSection,
  mungeCallSdp,
  mungeLocalSdp,
  mungeOutgoingSdp,
  parseFmtp,
  splitSdpSections,
} from "../sdp";

// Trimmed Chromium SDP: mic (mid 0), screen video (mid 1), screen audio (mid 2).
const SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "a=group:BUNDLE 0 1 2",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=mid:0",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97 103 104",
  "a=mid:1",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  "a=rtpmap:103 H264/90000",
  "a=fmtp:103 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
  "a=rtpmap:104 rtx/90000",
  "a=fmtp:104 apt=103",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:2",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "",
].join("\r\n");

function section(sdp: string, mid: string): string {
  return splitSdpSections(sdp).find((s) => s.mid === mid)!.text;
}
function fmtp(text: string, pt: string): Record<string, string> {
  const line = new RegExp(`^a=fmtp:${pt} (.*)$`, "m").exec(text)?.[1]?.replace(/\r$/, "");
  return Object.fromEntries(parseFmtp(line ?? ""));
}

describe("per-section SDP munging", () => {
  it("splits into session + media sections and round-trips", () => {
    const sections = splitSdpSections(SDP);
    expect(sections.map((s) => [s.kind, s.mid])).toEqual([
      [undefined, undefined],
      ["audio", "0"],
      ["video", "1"],
      ["audio", "2"],
    ]);
    expect(sections.map((s) => s.text).join("")).toBe(SDP);
  });

  it("outgoing: mic stays mono/DTX 64k, screen audio stereo 128k no DTX, video gets bitrate hints", () => {
    const out = mungeOutgoingSdp(SDP, "0");
    expect(fmtp(section(out, "0"), "111")).toMatchObject({ stereo: "0", usedtx: "1", maxaveragebitrate: "64000", useinbandfec: "1" });
    expect(fmtp(section(out, "2"), "111")).toMatchObject({
      stereo: "1",
      "sprop-stereo": "1",
      maxaveragebitrate: "128000",
      usedtx: "0",
      minptime: "10",
    });
    const video = section(out, "1");
    // VP8 had no fmtp line: inserted right after its rtpmap.
    expect(video).toContain("a=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=4000;x-google-min-bitrate=1000;x-google-max-bitrate=25000\r\n");
    expect(fmtp(video, "103")).toMatchObject({ "profile-level-id": "4d001f", "x-google-start-bitrate": "4000" });
    // RTX / RED untouched
    expect(fmtp(video, "97")).toEqual({ apt: "96" });
    expect(fmtp(section(out, "0"), "63")).toEqual({ "111/111": "" });
    // idempotent
    expect(mungeOutgoingSdp(out, "0")).toBe(out);
    expect(out.endsWith("\r\n")).toBe(true);
  });

  it("identifies the mic by mid, falling back to the first audio m-line", () => {
    const byMid = mungeCallSdp(SDP, { micMid: "2", voiceOpus: { stereo: 0 }, screenOpus: { stereo: 1 } });
    expect(fmtp(section(byMid, "2"), "111").stereo).toBe("0");
    expect(fmtp(section(byMid, "0"), "111").stereo).toBe("1");
    const fallback = mungeCallSdp(SDP, { micMid: null, voiceOpus: { stereo: 0 }, screenOpus: { stereo: 1 } });
    expect(fmtp(section(fallback, "0"), "111").stereo).toBe("0");
    expect(fmtp(section(fallback, "2"), "111").stereo).toBe("1");
    const unknownMid = mungeCallSdp(SDP, { micMid: "9", voiceOpus: { stereo: 0 }, screenOpus: { stereo: 1 } });
    expect(fmtp(section(unknownMid, "0"), "111").stereo).toBe("0");
  });

  it("local munging only touches screen-audio m-lines (decoder stereo)", () => {
    const local = mungeLocalSdp(SDP, "0");
    expect(section(local, "0")).toBe(section(SDP, "0"));
    expect(section(local, "1")).toBe(section(SDP, "1"));
    expect(fmtp(section(local, "2"), "111")).toMatchObject({ stereo: "1", "sprop-stereo": "1" });
  });

  it("detects a screen-audio m-line", () => {
    expect(hasScreenAudioSection(SDP, "0")).toBe(true);
    const voiceOnly = SDP.split(/(?=^m=)/m).slice(0, 2).join("");
    expect(hasScreenAudioSection(voiceOnly, "0")).toBe(false);
    expect(hasScreenAudioSection(voiceOnly, null)).toBe(false);
  });

  it("leaves a voice-only SDP's single audio m-line as voice", () => {
    const voiceOnly = SDP.split(/(?=^m=)/m).slice(0, 2).join("");
    const out = mungeOutgoingSdp(voiceOnly, null);
    expect(fmtp(out, "111")).toMatchObject({ stereo: "0", usedtx: "1" });
  });
});
