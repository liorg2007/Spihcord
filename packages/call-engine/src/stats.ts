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
