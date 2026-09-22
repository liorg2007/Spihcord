/**
 * Pure screen-share bookkeeping (no DOM).
 *
 * Watch intent lives on both sides:
 *  - `watching`: remote sharers WE asked to send to us (viewer side). Survives
 *    peer connection resets (the watch signal is re-sent to the new connection)
 *    and is cleared when the user leaves our channel or we unwatch.
 *  - `watchers`: remote users that asked US (sharer side). Remembered whether or
 *    not we are sharing right now, so a `watch` that races ahead of
 *    startScreenShare still works, and a replacement share keeps its viewers.
 *    Cleared on `unwatch` or when the user leaves our channel.
 *
 * We actually send to `watchers ∩ present peers` while sharing.
 */
import type { SignalData } from "@shpihcord/protocol";
import type { ScreenSharePreset } from "./types";

export type StreamAction = "watch" | "unwatch";

export class ScreenShareIntents {
  private sharing = false;
  private readonly watchers = new Set<string>();
  private readonly watching = new Set<string>();

  get isSharing(): boolean {
    return this.sharing;
  }

  setSharing(sharing: boolean): void {
    this.sharing = sharing;
  }

  /** A `stream` signal from a remote viewer. */
  onRemoteSignal(from: string, action: StreamAction): void {
    if (action === "watch") this.watchers.add(from);
    else this.watchers.delete(from);
  }

  /** Local user (un)watches a remote sharer. Returns the signal to send. */
  watch(userId: string, watching: boolean): SignalData {
    if (watching) this.watching.add(userId);
    else this.watching.delete(userId);
    return { kind: "stream", action: watching ? "watch" : "unwatch" };
  }

  isWatching(userId: string): boolean {
    return this.watching.has(userId);
  }

  hasWatcher(userId: string): boolean {
    return this.watchers.has(userId);
  }

  /** Should we be sending our screen to this (present) peer right now? */
  shouldSendTo(userId: string): boolean {
    return this.sharing && this.watchers.has(userId);
  }

  /** Peers we should be sending to, given who is currently connected/present. */
  targets(present: Iterable<string>): string[] {
    if (!this.sharing) return [];
    return [...present].filter((id) => this.watchers.has(id)).sort();
  }

  /** Signals to (re)send when a connection to `userId` is (re)created. */
  signalsForNewPeer(userId: string): SignalData[] {
    return this.watching.has(userId) ? [{ kind: "stream", action: "watch" }] : [];
  }

  /** The user left our channel: forget intent in both directions. */
  peerLeft(userId: string): void {
    this.watchers.delete(userId);
    this.watching.delete(userId);
  }

  clear(): void {
    this.sharing = false;
    this.watchers.clear();
    this.watching.clear();
  }
}

export function isStreamSignal(data: SignalData): data is Extract<SignalData, { kind: "stream" }> {
  return data.kind === "stream";
}

// ---------------------------------------------------------------------------
// Sender encoding parameters

export interface ScreenEncoding {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  degradationPreference: "maintain-framerate" | "maintain-resolution";
}

export interface CpuDowngrade {
  /** Multiplier on the preset frame rate (motion content). */
  fpsFactor: number;
  /** scaleResolutionDownBy (detail/text content). */
  scale: number;
}

export const NO_DOWNGRADE: CpuDowngrade = { fpsFactor: 1, scale: 1 };

export function screenEncoding(preset: ScreenSharePreset, downgrade: CpuDowngrade = NO_DOWNGRADE): ScreenEncoding {
  const motion = preset.contentHint === "motion";
  return {
    maxBitrate: preset.maxBitrate,
    maxFramerate: Math.max(5, Math.round(preset.frameRate * downgrade.fpsFactor)),
    scaleResolutionDownBy: Math.max(1, downgrade.scale),
    degradationPreference: motion ? "maintain-framerate" : "maintain-resolution",
  };
}

// ---------------------------------------------------------------------------
// Adaptive fallback: sustained CPU limitation at a demanding preset

export const CPU_LIMIT_SUSTAIN_MS = 10_000;

/** A preset is "high" when it asks for >30 fps or more than 1080p. */
export function isHighPreset(p: ScreenSharePreset): boolean {
  return p.frameRate > 30 || p.maxWidth * p.maxHeight > 1920 * 1080;
}

/**
 * Tracks qualityLimitationReason === "cpu" per viewer. Returns a new downgrade
 * once the limitation has persisted for CPU_LIMIT_SUSTAIN_MS at a high preset
 * (one step per sustained period, at most: 60 -> 30 fps, or 1 -> 1.5 scale).
 */
export class CpuWatch {
  private since: number | undefined;
  private current: CpuDowngrade = NO_DOWNGRADE;

  constructor(private readonly sustainMs = CPU_LIMIT_SUSTAIN_MS) {}

  get downgrade(): CpuDowngrade {
    return this.current;
  }

  reset(): void {
    this.since = undefined;
    this.current = NO_DOWNGRADE;
  }

  /** Feed one stats sample; returns the new downgrade if it changed. */
  update(reason: string | undefined, preset: ScreenSharePreset, now: number): CpuDowngrade | undefined {
    if (reason !== "cpu") {
      this.since = undefined;
      return undefined;
    }
    this.since ??= now;
    if (now - this.since < this.sustainMs || !isHighPreset(preset)) return undefined;
    this.since = now; // next step only after another sustained period
    const motion = preset.contentHint === "motion";
    const next: CpuDowngrade = motion
      ? { fpsFactor: this.current.fpsFactor > 0.5 ? 0.5 : this.current.fpsFactor, scale: this.current.fpsFactor > 0.5 ? this.current.scale : Math.min(2, this.current.scale * 1.5) }
      : { fpsFactor: this.current.fpsFactor, scale: Math.min(2, this.current.scale * 1.5) };
    if (next.fpsFactor === this.current.fpsFactor && next.scale === this.current.scale) return undefined;
    this.current = next;
    return next;
  }
}
