import { randomBytes } from "node:crypto";

/** Crockford base32 alphabet (as used by ULID). */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => b % 32);
}

/** Increment a base32 digit array by one (monotonic ULIDs within the same ms). */
function increment(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 31) {
      next[i]++;
      return next;
    }
    next[i] = 0;
  }
  return freshRandom(); // overflow: astronomically unlikely
}

/**
 * ULID-like, lexicographically time-sortable 26-char id.
 * Monotonic within the same millisecond in this process.
 */
export function newId(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = increment(lastRandom);
    now = lastTime;
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encodeTime(now) + lastRandom.map((d) => ALPHABET[d]).join("");
}

/** Human-friendly random code (no ambiguous chars), e.g. for invites. */
export function randomCode(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}
