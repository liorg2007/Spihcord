/**
 * Property/fuzz tests: every SDP transform used by the call engine must leave the
 * security-relevant lines byte-identical and never touch the transport proto.
 * Corpus: real SDPs captured from a live 3-peer voice+screen+camera call
 * (fixtures/captured-sdps.json, produced by run.cjs live) + random mutations.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  mungeOpusForVoice, mungeOutgoingSdp, mungeLocalSdp, mungeCallSdp, mungeCodecFmtp,
  VOICE_OPUS_PARAMS, SCREEN_AUDIO_OPUS_PARAMS, VIDEO_BITRATE_HINTS,
} from "../../packages/call-engine/src/sdp";

const corpus: string[] = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/captured-sdps.json"), "utf8"));

const SECURITY = /^(a=fingerprint:|a=setup:|a=ice-ufrag:|a=ice-pwd:|a=ice-options:|a=crypto:|a=group:BUNDLE|a=rtcp-mux|a=mid:|m=|c=|a=candidate:|a=identity:|a=tls-id:)/;
const lines = (s: string) => s.split(/\r?\n/);
const sec = (s: string) => lines(s).filter((l) => SECURITY.test(l));

function assertSafe(before: string, after: string) {
  // 1. security lines byte-identical, same order
  expect(sec(after)).toEqual(sec(before));
  // 2. every removed line is an a=fmtp line; every added line is an a=fmtp line
  const b = lines(before), a = lines(after);
  const removed = b.filter((l) => !a.includes(l));
  const added = a.filter((l) => !b.includes(l));
  for (const l of [...removed, ...added]) expect(l).toMatch(/^a=fmtp:\d+ /);
  // 3. proto never downgraded
  expect(after).not.toMatch(/^m=\S+ \d+ RTP\/AVPF? /m);
  expect((after.match(/UDP\/TLS\/RTP\/SAVPF/g) || []).length).toBe((before.match(/UDP\/TLS\/RTP\/SAVPF/g) || []).length);
  // 4. line endings preserved
  expect(after.includes("\r\n")).toBe(before.includes("\r\n"));
}

const transforms: Record<string, (s: string) => string> = {
  mungeOpusForVoice,
  mungeOutgoing_nullMid: (s) => mungeOutgoingSdp(s, null),
  mungeOutgoing_mid0: (s) => mungeOutgoingSdp(s, "0"),
  mungeOutgoing_mid2: (s) => mungeOutgoingSdp(s, "2"),
  mungeOutgoing_bogusMid: (s) => mungeOutgoingSdp(s, "zz"),
  mungeLocal_mid0: (s) => mungeLocalSdp(s, "0"),
  mungeLocal_null: (s) => mungeLocalSdp(s, null),
  all: (s) => mungeCallSdp(s, { micMid: "0", voiceOpus: VOICE_OPUS_PARAMS, screenOpus: SCREEN_AUDIO_OPUS_PARAMS, videoHints: VIDEO_BITRATE_HINTS }),
  idempotentTwice: (s) => mungeOutgoingSdp(mungeOutgoingSdp(s, "0"), "0"),
};

// deterministic PRNG
let seed = 1337;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

function mutate(sdp: string): string {
  let ls = lines(sdp);
  const trailing = ls[ls.length - 1] === "";
  if (trailing) ls.pop();
  const n = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) {
    const op = Math.floor(rnd() * 8);
    const at = Math.floor(rnd() * ls.length);
    if (op === 0) ls.splice(at, 0, `a=fmtp:${pick(["111", "96", "63"])} ${pick(["", ";", "stereo", "a=b;;c", "usedtx=0; minptime=10", "x=\u00e9"])}`);
    else if (op === 1) ls = ls.filter((l) => !(l.startsWith("a=fmtp:") && rnd() < 0.5)); // drop some fmtp
    else if (op === 2) ls.splice(at, 0, `a=rtpmap:${Math.floor(rnd() * 127)} ${pick(["opus", "OPUS", "VP8", "H264", "AV1"])}/48000/2`);
    else if (op === 3) ls.splice(at, 0, `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join(":")}`); // extra fingerprint in odd places
    else if (op === 4) ls.splice(at, 0, "a=setup:" + pick(["active", "passive", "actpass"]));
    else if (op === 5) ls.splice(at, 0, "a=fmtp:111 a=fingerprint:sha-256 00"); // fmtp value containing security text
    else if (op === 6) ls.splice(at, 0, "a=ice-pwd:" + "x".repeat(24));
    else if (op === 7 && at > 0) ls.splice(at, 1); // delete a random line
  }
  const eol = rnd() < 0.2 ? "\n" : "\r\n";
  return ls.join(eol) + (trailing || rnd() < 0.5 ? eol : "");
}

describe("SDP munging never alters security-relevant lines", () => {
  it("has a non-trivial real corpus", () => {
    expect(corpus.length).toBeGreaterThan(5);
    expect(corpus.some((s) => (s.match(/^m=video/gm) || []).length >= 2)).toBe(true);
  });
  for (const [name, fn] of Object.entries(transforms)) {
    it(`${name}: real captured SDPs`, () => {
      for (const s of corpus) assertSafe(s, fn(s));
    });
    it(`${name}: 2000 fuzzed mutations`, () => {
      for (let i = 0; i < 2000; i++) {
        const s = mutate(pick(corpus));
        assertSafe(s, fn(s));
      }
    });
  }
  it("mungeCodecFmtp with arbitrary codec names only touches fmtp", () => {
    for (let i = 0; i < 500; i++) {
      const s = mutate(pick(corpus));
      assertSafe(s, mungeCodecFmtp(s, { "x-google-max-bitrate": 1 }, pick(["opus", "VP8", "VP9", "H264", "AV1", "H265", "red", "rtx"])));
    }
  });
});
