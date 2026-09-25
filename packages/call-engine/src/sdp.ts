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

// ---------------------------------------------------------------------------
// Per-media-section munging (screen share)

/** Opus parameters for screen-share audio (music/game audio): stereo, 128 kbps, no DTX. */
export const SCREEN_AUDIO_OPUS_PARAMS: FmtpParams = {
  stereo: 1,
  "sprop-stereo": 1,
  maxaveragebitrate: 128000,
  usedtx: 0,
  useinbandfec: 1,
};

/**
 * Bitrate hints (kbps) for every video codec. Chromium reads x-google-* from the
 * *send* codec, i.e. from the remote description: hints we put in our outgoing
 * SDP shape how the other side sends to us (the sharer's encoder starts at
 * start-bitrate instead of ramping up from ~300 kbps).
 */
export const VIDEO_BITRATE_HINTS: FmtpParams = {
  "x-google-start-bitrate": 4000,
  "x-google-min-bitrate": 1000,
  "x-google-max-bitrate": 25000,
};

export const HINTED_VIDEO_CODECS: readonly string[] = ["VP8", "VP9", "H264", "AV1", "H265"];

export interface SdpSection {
  /** "audio" | "video" | "application"; undefined for the session section. */
  kind?: string;
  mid?: string;
  text: string;
}

/** Split into the session section followed by one section per m-line (text keeps its EOLs). */
export function splitSdpSections(sdp: string): SdpSection[] {
  const parts = sdp.split(/(?=^m=)/m);
  return parts.map((text, i) => {
    if (i === 0 && !text.startsWith("m=")) return { text };
    const kind = /^m=(\w+)/.exec(text)?.[1];
    const mid = /^a=mid:(\S+)/m.exec(text)?.[1];
    return { kind, mid, text };
  });
}

export interface CallSdpOptions {
  /** mid of the microphone m-line; undefined/null = the first audio m-line. */
  micMid?: string | null;
  /** Opus params for the mic m-line (null = leave untouched). */
  voiceOpus?: FmtpParams | null;
  /** Opus params for every other audio m-line (screen-share audio). */
  screenOpus?: FmtpParams | null;
  /** fmtp params added to every video codec (null = none). */
  videoHints?: FmtpParams | null;
  /** mids of camera video m-lines (they get `cameraVideoHints` instead of `videoHints`). */
  cameraMids?: ReadonlySet<string> | null;
  cameraVideoHints?: FmtpParams | null;
}

/**
 * Apply Opus params per audio m-line (mic vs screen audio share payload type
 * 111 but each m-line carries its own fmtp; Chromium accepts differing fmtp for
 * the same PT across bundled m-lines) and bitrate hints on video m-lines.
 */
export function mungeCallSdp(sdp: string, opts: CallSdpOptions): string {
  const sections = splitSdpSections(sdp);
  const micMid = opts.micMid ?? undefined;
  const firstAudio = sections.find((s) => s.kind === "audio");
  return sections
    .map((s) => {
      if (s.kind === "audio") {
        const isMic = micMid !== undefined && sections.some((x) => x.mid === micMid) ? s.mid === micMid : s === firstAudio;
        const params = isMic ? opts.voiceOpus : opts.screenOpus;
        return params ? mungeCodecFmtp(s.text, params, "opus") : s.text;
      }
      const isCamera = s.kind === "video" && !!s.mid && !!opts.cameraMids?.has(s.mid);
      const hints = isCamera ? opts.cameraVideoHints : opts.videoHints;
      if (s.kind === "video" && hints) {
        let text = s.text;
        for (const codec of HINTED_VIDEO_CODECS) text = mungeCodecFmtp(text, hints, codec);
        return text;
      }
      return s.text;
    })
    .join("");
}

/** Outgoing SDP for a call with screen share: voice Opus on the mic, stereo on screen audio, video bitrate hints. */
/** Camera m-lines: only a higher start bitrate (no min/max floor, so "low" can go to 150 kbps). */
export const CAMERA_BITRATE_HINTS: FmtpParams = { "x-google-start-bitrate": 1000 };

export function mungeOutgoingSdp(sdp: string, micMid?: string | null, cameraMids?: ReadonlySet<string> | null): string {
  return mungeCallSdp(sdp, {
    micMid,
    cameraMids,
    cameraVideoHints: CAMERA_BITRATE_HINTS,
    voiceOpus: VOICE_OPUS_PARAMS,
    screenOpus: SCREEN_AUDIO_OPUS_PARAMS,
    videoHints: VIDEO_BITRATE_HINTS,
  });
}

/**
 * Local description munging: Chromium configures the Opus *decoder* from the
 * local description, so `stereo=1` must be there for received screen audio to
 * be decoded as stereo. Only non-mic audio m-lines are touched.
 */
export function mungeLocalSdp(sdp: string, micMid?: string | null): string {
  return mungeCallSdp(sdp, { micMid, voiceOpus: null, screenOpus: SCREEN_AUDIO_OPUS_PARAMS, videoHints: null });
}

/** Does the SDP have an audio m-line other than the mic one? */
export function hasScreenAudioSection(sdp: string, micMid?: string | null): boolean {
  const audio = splitSdpSections(sdp).filter((s) => s.kind === "audio");
  if (micMid == null) return audio.length > 1;
  return audio.some((s) => s.mid !== micMid);
}
