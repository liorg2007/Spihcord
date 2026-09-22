/**
 * Pure getStats() report parsing (no DOM).
 */
import type { PeerRoute } from "./types";

/** Anything shaped like RTCStatsReport (a Map of id -> stats dict). */
export interface StatsReportLike {
  forEach(cb: (value: any, key: string) => void): void;
}

export interface LossCounters {
  packetsLost: number;
  packetsReceived: number;
}

export interface ParsedStats {
  route: PeerRoute;
  rttMs?: number;
  /** Packet loss % over the window since `prev`; undefined without a baseline. */
  lossPct?: number;
  /** Cumulative counters; pass back as `prev` next time. */
  counters?: LossCounters;
}

type Dict = Record<string, any>;

export function findSelectedCandidatePair(byId: Map<string, Dict>): Dict | undefined {
  for (const s of byId.values()) {
    if (s.type === "transport" && s.selectedCandidatePairId) {
      const pair = byId.get(s.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  let fallback: Dict | undefined;
  for (const s of byId.values()) {
    if (s.type !== "candidate-pair") continue;
    if (s.nominated && s.state === "succeeded") return s;
    if (s.selected && !fallback) fallback = s; // legacy / Firefox
  }
  return fallback;
}

export function parseStatsReport(report: StatsReportLike, prev?: LossCounters): ParsedStats {
  const byId = new Map<string, Dict>();
  report.forEach((value, key) => byId.set(value?.id ?? key, value));

  const result: ParsedStats = { route: "unknown" };

  const pair = findSelectedCandidatePair(byId);
  if (pair) {
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    if (local?.candidateType === "relay" || remote?.candidateType === "relay") result.route = "relay";
    else if (local?.candidateType || remote?.candidateType) result.route = "direct";
    if (typeof pair.currentRoundTripTime === "number") {
      result.rttMs = Math.round(pair.currentRoundTripTime * 1000);
    }
  }

  let lost = 0;
  let received = 0;
  let haveInbound = false;
  let remoteRtt: number | undefined;
  for (const s of byId.values()) {
    const kind = s.kind ?? s.mediaType;
    if (s.type === "inbound-rtp" && kind === "audio") {
      haveInbound = true;
      lost += typeof s.packetsLost === "number" ? s.packetsLost : 0;
      received += typeof s.packetsReceived === "number" ? s.packetsReceived : 0;
    } else if (s.type === "remote-inbound-rtp" && kind === "audio" && typeof s.roundTripTime === "number") {
      remoteRtt = s.roundTripTime;
    }
  }
  if (result.rttMs === undefined && remoteRtt !== undefined) result.rttMs = Math.round(remoteRtt * 1000);

  if (haveInbound) {
    result.counters = { packetsLost: lost, packetsReceived: received };
    if (prev) {
      const dl = lost - prev.packetsLost;
      const dr = received - prev.packetsReceived;
      if (dl >= 0 && dr >= 0) {
        const total = dl + dr;
        result.lossPct = total > 0 ? Math.round((dl / total) * 1000) / 10 : 0;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Screen-share video stats

export interface VideoCounters {
  outBytes?: number;
  outTs?: number;
  inBytes?: number;
  inTs?: number;
}

export interface VideoDirectionStats {
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  /** "H264", "AV1", "VP9", "VP8", ... */
  codec?: string;
  qualityLimitation?: "none" | "cpu" | "bandwidth" | "other";
  bytes: number;
}

export interface ParsedVideoStats {
  send?: VideoDirectionStats;
  recv?: VideoDirectionStats;
  counters: VideoCounters;
}

const QUALITY_LIMITATIONS = new Set(["none", "cpu", "bandwidth", "other"]);

function kbpsDelta(bytes: number, ts: number | undefined, prevBytes?: number, prevTs?: number): number | undefined {
  if (prevBytes === undefined || prevTs === undefined || ts === undefined) return undefined;
  const dt = ts - prevTs;
  const db = bytes - prevBytes;
  if (!(dt > 0) || db < 0) return undefined;
  return Math.round((db * 8) / dt); // bits per ms == kbit/s
}

function codecOf(byId: Map<string, Dict>, s: Dict): string | undefined {
  const mime = s.codecId ? byId.get(s.codecId)?.mimeType : undefined;
  if (typeof mime !== "string") return undefined;
  const i = mime.indexOf("/");
  return (i === -1 ? mime : mime.slice(i + 1)).toUpperCase();
}

function pickLargest(byId: Map<string, Dict>, type: string, bytesKey: string): Dict | undefined {
  let best: Dict | undefined;
  for (const s of byId.values()) {
    if (s.type !== type || (s.kind ?? s.mediaType) !== "video") continue;
    if (!best || (s[bytesKey] ?? 0) > (best[bytesKey] ?? 0)) best = s;
  }
  return best;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Parse outbound/inbound video RTP stats of one peer connection (there is at most
 * one screen video in each direction per connection). Pass the returned
 * `counters` back as `prev` for bitrate deltas.
 */
export function parseVideoStats(report: StatsReportLike, prev?: VideoCounters): ParsedVideoStats {
  const byId = new Map<string, Dict>();
  report.forEach((value, key) => byId.set(value?.id ?? key, value));
  const result: ParsedVideoStats = { counters: {} };

  const out = pickLargest(byId, "outbound-rtp", "bytesSent");
  if (out) {
    const bytes = num(out.bytesSent) ?? 0;
    const ts = num(out.timestamp);
    const reason = typeof out.qualityLimitationReason === "string" ? out.qualityLimitationReason : undefined;
    result.send = {
      width: num(out.frameWidth),
      height: num(out.frameHeight),
      fps: num(out.framesPerSecond),
      bitrateKbps: kbpsDelta(bytes, ts, prev?.outBytes, prev?.outTs),
      codec: codecOf(byId, out),
      qualityLimitation: reason && QUALITY_LIMITATIONS.has(reason) ? (reason as VideoDirectionStats["qualityLimitation"]) : undefined,
      bytes,
    };
    result.counters.outBytes = bytes;
    result.counters.outTs = ts;
  }

  const inb = pickLargest(byId, "inbound-rtp", "bytesReceived");
  if (inb) {
    const bytes = num(inb.bytesReceived) ?? 0;
    const ts = num(inb.timestamp);
    result.recv = {
      width: num(inb.frameWidth),
      height: num(inb.frameHeight),
      fps: num(inb.framesPerSecond),
      bitrateKbps: kbpsDelta(bytes, ts, prev?.inBytes, prev?.inTs),
      codec: codecOf(byId, inb),
      bytes,
    };
    result.counters.inBytes = bytes;
    result.counters.inTs = ts;
  }
  return result;
}
