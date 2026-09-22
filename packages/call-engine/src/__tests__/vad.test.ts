import { describe, expect, it } from "vitest";
import { VadGate, levelFromRms, rms } from "../vad";

describe("level", () => {
  it("computes rms", () => {
    expect(rms([])).toBe(0);
    expect(rms([1, -1, 1, -1])).toBeCloseTo(1);
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
  });

  it("maps rms to a 0..1 dB scale", () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(2)).toBe(1);
    expect(levelFromRms(0.001)).toBe(0); // -60 dBFS
    expect(levelFromRms(Math.pow(10, -30 / 20))).toBeCloseTo(0.5); // -30 dBFS
    expect(levelFromRms(NaN)).toBe(0);
  });
});

describe("VadGate", () => {
  it("activates immediately at the attack threshold", () => {
    const v = new VadGate({ threshold: 0.3, hangoverMs: 300 });
    expect(v.update(0.1, 0)).toBe(false);
    expect(v.update(0.29, 10)).toBe(false);
    expect(v.update(0.3, 20)).toBe(true);
  });

  it("holds through the hangover and then releases", () => {
    const v = new VadGate({ threshold: 0.3, hangoverMs: 300 });
    v.update(0.5, 0);
    expect(v.update(0, 100)).toBe(true);
    expect(v.update(0, 299)).toBe(true);
    expect(v.update(0, 300)).toBe(false);
  });

  it("uses a lower release threshold (hysteresis) to refresh the hangover", () => {
    const v = new VadGate({ threshold: 0.3, hangoverMs: 300, releaseRatio: 0.8 });
    v.update(0.5, 0);
    // 0.25 is below the attack threshold but above the release threshold (0.24)
    expect(v.update(0.25, 250)).toBe(true);
    expect(v.update(0.1, 500)).toBe(true); // hangover counted from 250
    expect(v.update(0.1, 550)).toBe(false);
    // Once inactive, 0.25 is not enough to re-trigger
    expect(v.update(0.25, 560)).toBe(false);
  });

  it("does not chop short pauses between words", () => {
    const v = new VadGate({ threshold: 0.3, hangoverMs: 300 });
    const pattern = [0.6, 0.5, 0.05, 0.05, 0.05, 0.6, 0.02]; // 50 ms steps
    const out = pattern.map((lvl, i) => v.update(lvl, i * 50));
    expect(out).toEqual([true, true, true, true, true, true, true]);
  });

  it("threshold changes apply immediately and are clamped", () => {
    const v = new VadGate({ threshold: 0.3 });
    v.setThreshold(0.8);
    expect(v.update(0.5, 0)).toBe(false);
    v.setThreshold(5);
    expect(v.getThreshold()).toBe(1);
    v.setThreshold(-1);
    expect(v.getThreshold()).toBe(0);
    expect(v.update(0, 10)).toBe(false); // silence never triggers even at 0
  });
});
