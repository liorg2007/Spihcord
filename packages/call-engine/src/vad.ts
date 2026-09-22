/**
 * Pure level / voice-activity logic (no DOM).
 *
 * Level scale: normalized 0..1 on a dBFS scale, -60 dBFS -> 0, 0 dBFS -> 1.
 * Perceptually linear, which makes the settings meter and threshold slider
 * behave sensibly. Typical speech (with AGC) sits around 0.45..0.7,
 * a quiet room around 0..0.15.
 */

export const LEVEL_FLOOR_DB = -60;
export const DEFAULT_VAD_THRESHOLD = 0.25; // ~ -45 dBFS
export const DEFAULT_VAD_HANGOVER_MS = 300;

export function rms(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Map a linear amplitude/RMS (0..1) to the normalized 0..1 level. */
export function levelFromRms(value: number): number {
  if (!(value > 0)) return 0;
  const db = 20 * Math.log10(value);
  const level = (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB;
  return Math.min(1, Math.max(0, level));
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export interface VadOptions {
  /** Attack threshold 0..1. */
  threshold: number;
  /** How long to stay active after the level last exceeded the release threshold. */
  hangoverMs?: number;
  /** Release threshold as a fraction of `threshold` (hysteresis). Default 0.8. */
  releaseRatio?: number;
}

/**
 * Voice-activity state machine with attack threshold, lower release threshold
 * and a hangover so trailing syllables are not cut off.
 */
export class VadGate {
  private active = false;
  private lastVoiceAt = -Infinity;
  private threshold: number;
  private readonly hangoverMs: number;
  private readonly releaseRatio: number;

  constructor(opts: VadOptions) {
    this.threshold = clamp01(opts.threshold);
    this.hangoverMs = opts.hangoverMs ?? DEFAULT_VAD_HANGOVER_MS;
    this.releaseRatio = opts.releaseRatio ?? 0.8;
  }

  setThreshold(threshold: number): void {
    this.threshold = clamp01(threshold);
  }

  getThreshold(): number {
    return this.threshold;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Feed a level sample; returns whether voice is active. */
  update(level: number, nowMs: number): boolean {
    if (!this.active) {
      if (level >= this.threshold && level > 0) {
        this.active = true;
        this.lastVoiceAt = nowMs;
      }
    } else if (level >= this.threshold * this.releaseRatio && level > 0) {
      this.lastVoiceAt = nowMs;
    } else if (nowMs - this.lastVoiceAt >= this.hangoverMs) {
      this.active = false;
    }
    return this.active;
  }

  reset(): void {
    this.active = false;
    this.lastVoiceAt = -Infinity;
  }
}
