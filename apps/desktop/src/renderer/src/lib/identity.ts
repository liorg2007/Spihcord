/**
 * Media identity (security M1/M2): a long-term DTLS certificate for this
 * install, trust-on-first-use pins of every peer's certificate fingerprint
 * (per server URL + user id), safety numbers and the "verified" mark.
 *
 * - The certificate (ECDSA P-256, 1-year expiry) lives in IndexedDB, so our
 *   fingerprint survives restarts; it is regenerated when < 30 days remain
 *   (peers then see a key change once).
 * - Pins live in localStorage because the engine's verification hook is
 *   synchronous (it runs in order with signaling).
 */
import { computeSafetyNumber, certificateFingerprint, type FingerprintVerifier } from "@shpihcord/call-engine";
import { create } from "zustand";

const DB_NAME = "shpihcord-identity";
const STORE = "certificates";
const CERT_KEY = "dtls";
const CERT_LIFETIME_MS = 365 * 24 * 3600 * 1000;
const CERT_RENEW_MS = 30 * 24 * 3600 * 1000;
const PINS_KEY = "shpihcord.identityPins.v1";

// ---------------------------------------------------------------------------
// Certificate

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

let certPromise: Promise<RTCCertificate> | null = null;

async function loadOrCreateCertificate(): Promise<RTCCertificate> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
  } catch (err) {
    console.warn("[identity] IndexedDB unavailable, using a session-only certificate", err);
  }
  try {
    if (db) {
      const stored = await idb<RTCCertificate | undefined>(db, "readonly", (s) => s.get(CERT_KEY)).catch(() => undefined);
      if (stored && typeof stored.expires === "number" && stored.expires - Date.now() > CERT_RENEW_MS && certificateFingerprint(stored)) {
        return stored;
      }
    }
    const cert = await RTCPeerConnection.generateCertificate({
      name: "ECDSA",
      namedCurve: "P-256",
      expires: CERT_LIFETIME_MS,
    } as EcKeyGenParams & { expires: number });
    if (db) await idb(db, "readwrite", (s) => s.put(cert, CERT_KEY)).catch((err) => console.warn("[identity] could not persist certificate", err));
    return cert;
  } finally {
    db?.close();
  }
}

/** This install's DTLS certificate (same object for the whole session). */
export function getCertificate(): Promise<RTCCertificate> {
  certPromise ??= loadOrCreateCertificate().catch((err) => {
    certPromise = null;
    throw err;
  });
  return certPromise.then((c) => {
    if (c.expires - Date.now() <= CERT_RENEW_MS) {
      // Long-running session crossed the renewal point: rotate for the next call.
      certPromise = null;
    }
    return c;
  });
}

// ---------------------------------------------------------------------------
// Pins

export interface Pin {
  fingerprint: string;
  verified: boolean;
  pinnedAt: number;
}

export interface IdentityMismatch {
  userId: string;
  expected: string;
  received: string;
  reason: "changed" | "invalid";
  /** The old key had been marked verified: a stronger warning. */
  wasVerified: boolean;
}

interface IdentityState {
  pins: Record<string, Pin>;
  /** Pending mismatches for the current call (the dialog shows the first one). */
  mismatches: IdentityMismatch[];
  /** Our own fingerprint once the certificate is loaded. */
  selfFingerprint: string | null;
}

function loadPins(): Record<string, Pin> {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Record<string, Pin>) : {};
  } catch {
    return {};
  }
}

export const useIdentity = create<IdentityState>()(() => ({ pins: loadPins(), mismatches: [], selfFingerprint: null }));

function savePins(pins: Record<string, Pin>): void {
  useIdentity.setState({ pins });
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch (err) {
    console.warn("[identity] could not persist pins", err);
  }
}

export const pinKey = (serverUrl: string, userId: string) => `${serverUrl.replace(/\/+$/, "")}|${userId}`;

export function getPin(serverUrl: string, userId: string): Pin | undefined {
  return useIdentity.getState().pins[pinKey(serverUrl, userId)];
}

/** The engine hook for one server: pin on first use, then require the pinned key. */
export function makeVerifier(serverUrl: string): FingerprintVerifier {
  return (userId, fingerprint) => {
    const key = pinKey(serverUrl, userId);
    const pin = useIdentity.getState().pins[key];
    if (!pin) {
      savePins({ ...useIdentity.getState().pins, [key]: { fingerprint, verified: false, pinnedAt: Date.now() } });
      return { trusted: true };
    }
    return pin.fingerprint === fingerprint ? { trusted: true } : { trusted: false, expected: pin.fingerprint };
  };
}

/** "Trust new key": replace the pin (the verified mark does not carry over). */
export function repin(serverUrl: string, userId: string, fingerprint: string): void {
  const key = pinKey(serverUrl, userId);
  savePins({ ...useIdentity.getState().pins, [key]: { fingerprint, verified: false, pinnedAt: Date.now() } });
}

export function setVerified(serverUrl: string, userId: string, verified: boolean): void {
  const key = pinKey(serverUrl, userId);
  const pin = useIdentity.getState().pins[key];
  if (!pin) return;
  savePins({ ...useIdentity.getState().pins, [key]: { ...pin, verified } });
}

export function useVerified(serverUrl: string | undefined, userId: string | null | undefined): boolean {
  return useIdentity((s) => (serverUrl && userId ? !!s.pins[pinKey(serverUrl, userId)]?.verified : false));
}

// ---------------------------------------------------------------------------
// Mismatches (dialog queue)

export function addMismatch(m: IdentityMismatch): void {
  useIdentity.setState((s) => ({ mismatches: [...s.mismatches.filter((x) => x.userId !== m.userId), m] }));
}

export function dropMismatch(userId: string): void {
  useIdentity.setState((s) => (s.mismatches.some((x) => x.userId === userId) ? { mismatches: s.mismatches.filter((x) => x.userId !== userId) } : {}));
}

export function clearMismatches(): void {
  useIdentity.setState({ mismatches: [] });
}

// ---------------------------------------------------------------------------
// Safety numbers

export function setSelfFingerprint(fp: string | null): void {
  if (useIdentity.getState().selfFingerprint !== fp) useIdentity.setState({ selfFingerprint: fp });
}

/** Safety number of our key and `fingerprint` (identical on the other side). */
export function safetyNumber(fingerprint: string): Promise<string | null> {
  const self = useIdentity.getState().selfFingerprint;
  return self ? computeSafetyNumber(self, fingerprint) : Promise.resolve(null);
}

/** Load the certificate (if not yet) so our fingerprint is known outside a call. */
export function ensureSelfFingerprint(): void {
  if (useIdentity.getState().selfFingerprint) return;
  void getCertificate()
    .then((c) => setSelfFingerprint(certificateFingerprint(c) ?? null))
    .catch(() => undefined);
}
