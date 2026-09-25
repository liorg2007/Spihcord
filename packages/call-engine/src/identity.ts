/**
 * DTLS identity helpers: strict fingerprint extraction for pinning and the
 * safety number both sides of a connection can compare out of band.
 * No DOM globals beyond WebCrypto (crypto.subtle), so this is unit-testable in Node.
 */

export type FingerprintParse = { ok: true; fingerprint: string } | { ok: false; reason: string };

const SHA256_HEX = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * Canonical form used for pins: "sha-256 AB:CD:..." (upper-case hex).
 * Accepts "sha-256 ab:cd..." strings and RTCDtlsFingerprint objects.
 */
export function normalizeFingerprint(fp: string | { algorithm?: string; value?: string }): string | undefined {
  let algorithm: string;
  let value: string;
  if (typeof fp === "string") {
    const m = /^\s*(\S+)\s+(\S+)\s*$/.exec(fp);
    if (!m) return undefined;
    algorithm = m[1];
    value = m[2];
  } else {
    algorithm = fp.algorithm ?? "";
    value = fp.value ?? "";
  }
  if (algorithm.toLowerCase() !== "sha-256") return undefined;
  const v = value.toUpperCase();
  return SHA256_HEX.test(v) ? `sha-256 ${v}` : undefined;
}

/**
 * Every `a=fingerprint` line of the SDP (session and media level). Pinning
 * accepts the description only if there is at least one, all are sha-256 and
 * all carry the same value (with BUNDLE there is one DTLS transport, so a
 * second, different fingerprint can only be an attempt to confuse a checker
 * that reads the first line only).
 */
export function parseDtlsFingerprint(sdp: string | undefined | null): FingerprintParse {
  if (!sdp) return { ok: false, reason: "no SDP" };
  const lines = [...sdp.matchAll(/^a=fingerprint:(.*?)\r?$/gm)].map((m) => m[1]);
  if (lines.length === 0) return { ok: false, reason: "no a=fingerprint line" };
  let first: string | undefined;
  for (const line of lines) {
    const fp = normalizeFingerprint(line);
    if (!fp) return { ok: false, reason: `unsupported fingerprint "${line.trim().slice(0, 40)}" (only sha-256 is accepted)` };
    if (first === undefined) first = fp;
    else if (fp !== first) return { ok: false, reason: "a=fingerprint lines disagree" };
  }
  return { ok: true, fingerprint: first! };
}

/** The SDP o= session id; stable for the life of an RTCPeerConnection, new for a recreated one. */
export function extractSessionId(sdp: string | undefined | null): string | undefined {
  if (!sdp) return undefined;
  return /^o=\S+ (\S+) /m.exec(sdp)?.[1];
}

/**
 * Short code derived from SHA-256 over the two canonical fingerprints, sorted,
 * so both ends compute the same value: 5 groups of 5 digits (~83 bits).
 */
export async function computeSafetyNumber(fingerprintA: string, fingerprintB: string): Promise<string> {
  const a = normalizeFingerprint(fingerprintA) ?? fingerprintA;
  const b = normalizeFingerprint(fingerprintB) ?? fingerprintB;
  const input = new TextEncoder().encode([a, b].sort().join("\n"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const groups: string[] = [];
  for (let i = 0; i < 5; i++) {
    const n = (digest[i * 3] << 16) | (digest[i * 3 + 1] << 8) | digest[i * 3 + 2];
    groups.push(String(n % 100000).padStart(5, "0"));
  }
  return groups.join(" ");
}

/** The sha-256 fingerprint of a certificate we generated (RTCCertificate.getFingerprints). */
export function certificateFingerprint(cert: RTCCertificate | undefined): string | undefined {
  const fps = (cert as { getFingerprints?: () => RTCDtlsFingerprint[] } | undefined)?.getFingerprints?.() ?? [];
  for (const f of fps) {
    const n = normalizeFingerprint(f);
    if (n) return n;
  }
  return undefined;
}
