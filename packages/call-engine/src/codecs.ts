/**
 * Pure video codec preference ordering for the screen-share transceiver (no DOM).
 */

/** Shape of RTCRtpCodec / RTCRtpCodecCapability. */
export interface CodecLike {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
}

/**
 * Tunable preference among the primary codecs (hardware-friendly first).
 * Hardware-accelerated codecs (per mediaCapabilities.powerEfficient) are moved
 * ahead of software ones, keeping this relative order.
 */
export const SCREEN_CODEC_ORDER: readonly string[] = ["H264", "AV1", "VP9", "VP8"];

/** Codecs that are only preferred when hardware accelerated; otherwise they go last. */
export const HARDWARE_ONLY_CODECS: readonly string[] = ["AV1"];

const AUX = new Set(["rtx", "red", "ulpfec", "flexfec-03"]);

export function codecName(mimeType: string): string {
  const i = mimeType.indexOf("/");
  return (i === -1 ? mimeType : mimeType.slice(i + 1)).toUpperCase();
}

function fmtpValue(fmtp: string | undefined, key: string): string | undefined {
  if (!fmtp) return undefined;
  for (const part of fmtp.split(";")) {
    const [k, v] = part.split("=");
    if (k?.trim().toLowerCase() === key) return v?.trim();
  }
  return undefined;
}

/** Lower is better: High > Main > Constrained Baseline > Baseline > other; packetization-mode=1 first. */
export function h264Rank(fmtp: string | undefined): number {
  const plid = (fmtpValue(fmtp, "profile-level-id") ?? "").toLowerCase();
  const profileIdc = plid.slice(0, 2);
  const iop = plid.slice(2, 4);
  let rank: number;
  if (profileIdc === "64") rank = 0; // High (and constrained high, 640c)
  else if (profileIdc === "4d") rank = 1; // Main
  else if (profileIdc === "42" && iop === "e0") rank = 2; // Constrained Baseline
  else if (profileIdc === "42") rank = 3; // Baseline
  else rank = 4; // e.g. High 4:4:4 (f4) is decode-only in Chromium
  const pm = fmtpValue(fmtp, "packetization-mode") === "1" ? 0 : 1;
  return rank * 2 + pm;
}

export interface OrderOptions {
  order?: readonly string[];
  /** Codec names (e.g. "AV1", "H264") that have a power-efficient (hardware) encoder. */
  hardware?: ReadonlySet<string>;
  hardwareOnly?: readonly string[];
  /** Codec names the local side can encode; others are not moved to the front. */
  sendable?: ReadonlySet<string>;
}

/**
 * Reorder a capability list for setCodecPreferences:
 *   1. primary codecs with a hardware encoder, in `order`
 *   2. remaining primary codecs in `order` (hardware-only codecs excluded)
 *   3. other media codecs (unknown / not sendable), original order
 *   4. hardware-only codecs without hardware (e.g. software AV1)
 *   5. RTX / RED / ULPFEC / FlexFEC, original order (kept so they stay negotiated)
 * Within H264, better profiles come first. Nothing is dropped.
 */
export function orderVideoCodecs<T extends CodecLike>(codecs: readonly T[], opts: OrderOptions = {}): T[] {
  const order = (opts.order ?? SCREEN_CODEC_ORDER).map((c) => c.toUpperCase());
  const hw = opts.hardware ?? new Set<string>();
  const hwOnly = new Set((opts.hardwareOnly ?? HARDWARE_ONLY_CODECS).map((c) => c.toUpperCase()));
  const sendable = opts.sendable;

  const tier = (c: T): number => {
    const name = codecName(c.mimeType);
    if (AUX.has(name.toLowerCase())) return 4;
    const idx = order.indexOf(name);
    if (idx === -1 || (sendable && !sendable.has(name))) return 2;
    if (hw.has(name)) return 0;
    if (hwOnly.has(name)) return 3;
    return 1;
  };
  const key = (c: T): number[] => {
    const name = codecName(c.mimeType);
    const t = tier(c);
    const idx = order.indexOf(name);
    return [t, t <= 1 || t === 3 ? idx : 0, name === "H264" ? h264Rank(c.sdpFmtpLine) : 0];
  };
  return codecs
    .map((c, i) => ({ c, i, k: key(c) }))
    .sort((a, b) => {
      for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j];
      return a.i - b.i;
    })
    .map((x) => x.c);
}

/** e.g. "video/H264;profile-level-id=4d001f" for mediaCapabilities.encodingInfo. */
export function mediaCapabilitiesContentType(c: CodecLike): string {
  const name = codecName(c.mimeType);
  const plid = name === "H264" ? fmtpValue(c.sdpFmtpLine, "profile-level-id") : undefined;
  return plid ? `${c.mimeType};profile-level-id=${plid}` : c.mimeType;
}
