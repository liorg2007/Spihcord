/**
 * Pure mesh bookkeeping (no DOM): peer diffing, politeness, and buffering of
 * signals that arrive before a peer exists.
 */
import type { SignalData } from "@shpihcord/protocol";

export interface PeerDiff {
  added: string[];
  removed: string[];
}

/** Compute which peers to create/close. selfId, duplicates and empty ids are ignored. */
export function diffPeers(current: Iterable<string>, desired: Iterable<string>, selfId: string): PeerDiff {
  const cur = new Set(current);
  const want = new Set<string>();
  for (const id of desired) {
    if (id && id !== selfId) want.add(id);
  }
  const added = [...want].filter((id) => !cur.has(id));
  const removed = [...cur].filter((id) => !want.has(id));
  return { added, removed };
}

/** Deterministic role for perfect negotiation: the lexicographically smaller id is polite. */
export function isPolite(selfId: string, peerId: string): boolean {
  return selfId < peerId;
}

export interface SignalBufferOptions {
  ttlMs?: number;
  maxPerSender?: number;
  maxSenders?: number;
}

interface Buffered {
  at: number;
  data: SignalData;
}

/** Bounded, TTL'd per-sender queue of early signals. */
export class SignalBuffer {
  private readonly ttlMs: number;
  private readonly maxPerSender: number;
  private readonly maxSenders: number;
  private readonly queues = new Map<string, Buffered[]>();

  constructor(opts: SignalBufferOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.maxPerSender = opts.maxPerSender ?? 100;
    this.maxSenders = opts.maxSenders ?? 32;
  }

  push(from: string, data: SignalData, now: number): void {
    this.prune(now);
    let q = this.queues.get(from);
    if (!q) {
      if (this.queues.size >= this.maxSenders) {
        // Evict the sender whose newest signal is oldest.
        let oldestKey: string | undefined;
        let oldestAt = Infinity;
        for (const [k, v] of this.queues) {
          const last = v[v.length - 1]?.at ?? -Infinity;
          if (last < oldestAt) {
            oldestAt = last;
            oldestKey = k;
          }
        }
        if (oldestKey !== undefined) this.queues.delete(oldestKey);
      }
      q = [];
      this.queues.set(from, q);
    }
    q.push({ at: now, data });
    if (q.length > this.maxPerSender) q.splice(0, q.length - this.maxPerSender);
  }

  /** Remove and return the still-valid signals from a sender, oldest first. */
  take(from: string, now: number): SignalData[] {
    const q = this.queues.get(from);
    this.queues.delete(from);
    if (!q) return [];
    return q.filter((b) => now - b.at <= this.ttlMs).map((b) => b.data);
  }

  drop(from: string): void {
    this.queues.delete(from);
  }

  prune(now: number): void {
    for (const [k, q] of this.queues) {
      const kept = q.filter((b) => now - b.at <= this.ttlMs);
      if (kept.length === 0) this.queues.delete(k);
      else if (kept.length !== q.length) this.queues.set(k, kept);
    }
  }

  size(from?: string): number {
    if (from !== undefined) return this.queues.get(from)?.length ?? 0;
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  clear(): void {
    this.queues.clear();
  }
}
