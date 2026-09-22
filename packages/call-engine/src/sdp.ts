/**
 * Pure SDP helpers (no DOM).
 */

export type FmtpParams = Record<string, string | number>;

/** Opus parameters we want for voice. */
export const VOICE_OPUS_PARAMS: FmtpParams = {
  useinbandfec: 1,
  usedtx: 1,
  stereo: 0,
  maxaveragebitrate: 64000,
};

function detectEol(sdp: string): string {
  return sdp.includes("\r\n") ? "\r\n" : "\n";
}

/** Payload types whose rtpmap names the given codec (case-insensitive). */
export function findPayloadTypes(sdp: string, codec: string): string[] {
  const re = new RegExp(`^a=rtpmap:(\\d+) ${codec}/`, "i");
  const out: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Parse "a=b;c=d" (whitespace tolerant) preserving order. */
export function parseFmtp(value: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of value.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq === -1) out.push([p, ""]);
    else out.push([p.slice(0, eq).trim(), p.slice(eq + 1).trim()]);
  }
  return out;
}

function serializeFmtp(params: Array<[string, string]>): string {
  return params.map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";");
}

function mergeParams(existing: Array<[string, string]>, wanted: FmtpParams): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  const wantedLower = new Map(Object.entries(wanted).map(([k, v]) => [k.toLowerCase(), String(v)]));
  for (const [k, v] of existing) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue; // drop duplicates
    seen.add(key);
    out.push([k, wantedLower.has(key) ? wantedLower.get(key)! : v]);
  }
  for (const [k, v] of wantedLower) {
    if (!seen.has(k)) out.push([k, v]);
  }
  return out;
}

/**
 * Set fmtp parameters for every payload type of `codec` (default opus).
 * Existing parameters are kept, wanted ones overridden, nothing is duplicated.
 * If a payload type has no fmtp line, one is inserted right after its rtpmap.
 */
export function mungeCodecFmtp(sdp: string, wanted: FmtpParams, codec = "opus"): string {
  const pts = new Set(findPayloadTypes(sdp, codec));
  if (pts.size === 0) return sdp;
  const eol = detectEol(sdp);
  const endsWithEol = sdp.endsWith(eol);
  const lines = sdp.split(/\r?\n/);
  if (endsWithEol) lines.pop();

  const withFmtp = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^a=fmtp:(\d+) ?(.*)$/.exec(line);
    if (m && pts.has(m[1])) {
      withFmtp.add(m[1]);
      out.push(`a=fmtp:${m[1]} ${serializeFmtp(mergeParams(parseFmtp(m[2]), wanted))}`);
    } else {
      out.push(line);
    }
  }
  // Insert missing fmtp lines after the rtpmap line.
  const final: string[] = [];
  for (const line of out) {
    final.push(line);
    const m = /^a=rtpmap:(\d+) /.exec(line);
    if (m && pts.has(m[1]) && !withFmtp.has(m[1])) {
      final.push(`a=fmtp:${m[1]} ${serializeFmtp(mergeParams([], wanted))}`);
      withFmtp.add(m[1]);
    }
  }
  return final.join(eol) + (endsWithEol ? eol : "");
}

/** Apply voice Opus settings. */
export function mungeOpusForVoice(sdp: string): string {
  return mungeCodecFmtp(sdp, VOICE_OPUS_PARAMS, "opus");
}

/** The first DTLS fingerprint in the SDP ("sha-256 AB:CD:..."), or undefined. */
export function extractFingerprint(sdp: string | undefined | null): string | undefined {
  if (!sdp) return undefined;
  const m = /^a=fingerprint:(.+)$/m.exec(sdp);
  return m ? m[1].trim().toLowerCase() : undefined;
}
