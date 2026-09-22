import { describe, expect, it } from "vitest";
import { parseStatsReport } from "../stats";

type S = Record<string, unknown> & { id: string; type: string };

function report(...stats: S[]): Map<string, S> {
  return new Map(stats.map((s) => [s.id, s]));
}

const local = (id: string, candidateType: string): S => ({ id, type: "local-candidate", candidateType });
const remote = (id: string, candidateType: string): S => ({ id, type: "remote-candidate", candidateType });
const inbound = (lost: number, recv: number): S => ({
  id: "IT01A",
  type: "inbound-rtp",
  kind: "audio",
  packetsLost: lost,
  packetsReceived: recv,
});

describe("parseStatsReport", () => {
  it("uses the transport's selected candidate pair", () => {
    const r = report(
      { id: "T01", type: "transport", selectedCandidatePairId: "CP2" },
      { id: "CP1", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", nominated: true, state: "succeeded", currentRoundTripTime: 0.5 },
      { id: "CP2", type: "candidate-pair", localCandidateId: "L2", remoteCandidateId: "R2", nominated: true, state: "succeeded", currentRoundTripTime: 0.0234 },
      local("L1", "relay"),
      remote("R1", "host"),
      local("L2", "srflx"),
      remote("R2", "host"),
    );
    const s = parseStatsReport(r);
    expect(s.route).toBe("direct");
    expect(s.rttMs).toBe(23);
  });

  it("falls back to the nominated succeeded pair and detects relay on either end", () => {
    const base = [
      { id: "CPx", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", nominated: false, state: "in-progress" },
      { id: "CP1", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", nominated: true, state: "succeeded", currentRoundTripTime: 0.1 },
    ] as S[];
    expect(parseStatsReport(report(...base, local("L1", "host"), remote("R1", "relay"))).route).toBe("relay");
    expect(parseStatsReport(report(...base, local("L1", "relay"), remote("R1", "srflx"))).route).toBe("relay");
    expect(parseStatsReport(report(...base, local("L1", "prflx"), remote("R1", "srflx"))).route).toBe("direct");
  });

  it("reports unknown with no selected pair", () => {
    const s = parseStatsReport(
      report({ id: "CP1", type: "candidate-pair", nominated: false, state: "waiting", localCandidateId: "L", remoteCandidateId: "R" }),
    );
    expect(s.route).toBe("unknown");
    expect(s.rttMs).toBeUndefined();
    expect(s.lossPct).toBeUndefined();
  });

  it("computes loss from deltas between reports", () => {
    const first = parseStatsReport(report(inbound(10, 990)));
    expect(first.lossPct).toBeUndefined();
    expect(first.counters).toEqual({ packetsLost: 10, packetsReceived: 990 });

    const second = parseStatsReport(report(inbound(15, 1085)), first.counters);
    expect(second.lossPct).toBe(5); // 5 lost of 100 in the window

    const idle = parseStatsReport(report(inbound(15, 1085)), second.counters);
    expect(idle.lossPct).toBe(0);

    // Counter reset (new SSRC): no bogus value
    const reset = parseStatsReport(report(inbound(0, 50)), second.counters);
    expect(reset.lossPct).toBeUndefined();
  });

  it("ignores video inbound streams and uses remote-inbound rtt as a fallback", () => {
    const s = parseStatsReport(
      report(
        { id: "V", type: "inbound-rtp", kind: "video", packetsLost: 100, packetsReceived: 1 },
        inbound(0, 100),
        { id: "RI", type: "remote-inbound-rtp", kind: "audio", roundTripTime: 0.0419 },
      ),
      { packetsLost: 0, packetsReceived: 0 },
    );
    expect(s.lossPct).toBe(0);
    expect(s.rttMs).toBe(42);
  });
});
