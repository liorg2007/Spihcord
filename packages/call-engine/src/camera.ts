/**
 * Camera video: media-kind identification, per-viewer quality and the per-peer
 * camera sender. No DOM globals (the RTCPeerConnection is injected), so all of
 * this is unit-testable.
 *
 * Identification of what a remote transceiver carries
 * ----------------------------------------------------
 * Every MediaStream the engine sends on has a stable, engine-owned id (the mic's
 * Web Audio destination stream, one camera stream, one screen stream). Browsers
 * don't let us choose MediaStream ids, so the *outgoing* SDP (what the hub relays,
 * never what we set locally) rewrites each of those msid stream ids to carry a
 * kind prefix: `mic-<id>`, `cam-<id>`, `scr-<id>` (a=msid, a=ssrc ... msid:,
 * a=msid-semantic). The receiver maps mid -> kind from the remote description's
 * msid of each m-section. The rewrite is a pure function of (sdp, our stream ids),
 * so it is identical for every offer/answer, across glare/rollback and on a
 * recreated connection (the same MediaStream objects are reused). Sections
 * without a recognised prefix (older clients) fall back to the previous rule:
 * any non-mic receiving media is screen share.
 */
import type { SignalData } from "@shpihcord/protocol";
import type { CameraPreference } from "./types";
import { splitSdpSections } from "./sdp";
import { updateSenderParams } from "./senderParams";

// ---------------------------------------------------------------------------
// Kind labels in SDP msid

export type MediaLabel = "mic" | "camera" | "screen";

export const MSID_PREFIX: Readonly<Record<MediaLabel, string>> = { mic: "mic-", camera: "cam-", screen: "scr-" };

/** Prefix a stream id with its kind (idempotent). */
export function labelStreamId(id: string, kind: MediaLabel): string {
  const prefix = MSID_PREFIX[kind];
  return id.startsWith(prefix) ? id : prefix + id;
}

/** The kind encoded in a (remote) msid stream id, if any. */
export function kindOfStreamId(id: string | undefined | null): MediaLabel | undefined {
  if (!id) return undefined;
  for (const kind of ["mic", "camera", "screen"] as const) if (id.startsWith(MSID_PREFIX[kind])) return kind;
  return undefined;
}

/**
 * Rewrite our msid stream ids to kind-labelled ones. `labels` maps a real local
 * MediaStream id to its kind; other ids (and "-") are left untouched.
 */
export function labelSdpMsids(sdp: string, labels: ReadonlyMap<string, MediaLabel>): string {
  if (labels.size === 0 || !sdp) return sdp;
  const map = (id: string): string => {
    const kind = labels.get(id);
    return kind ? labelStreamId(id, kind) : id;
  };
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  return sdp
    .split(eol)
    .map((line) => {
      let m = /^a=msid:(\S+)(.*)$/.exec(line);
      if (m) return `a=msid:${map(m[1])}${m[2]}`;
      m = /^(a=ssrc:\d+ msid:)(\S+)(.*)$/.exec(line);
      if (m) return `${m[1]}${map(m[2])}${m[3]}`;
      m = /^(a=msid-semantic:\s*WMS)(.*)$/.exec(line);
      if (m) return m[1] + m[2].replace(/\S+/g, (id) => map(id));
      return line;
    })
    .join(eol);
}

/** mid -> kind for every m-section of a description whose msid carries a kind label. */
export function sectionKinds(sdp: string | undefined | null): Map<string, MediaLabel> {
  const out = new Map<string, MediaLabel>();
  if (!sdp) return out;
  for (const s of splitSdpSections(sdp)) {
    if (!s.mid) continue;
    const id = /^a=msid:(\S+)/m.exec(s.text)?.[1] ?? /^a=ssrc:\d+ msid:(\S+)/m.exec(s.text)?.[1];
    const kind = kindOfStreamId(id);
    if (kind) out.set(s.mid, kind);
  }
  return out;
}

/**
 * What a receiving transceiver (not the mic, i.e. index > 0) carries, from the
 * remote description's labels. Unlabelled -> "screen" (backwards compatible).
 * A "mic" label on a non-first transceiver is treated as screen too (never
 * played as the voice track).
 */
export function receiverKind(mid: string | null | undefined, kinds: ReadonlyMap<string, MediaLabel>): "camera" | "screen" {
  return mid != null && kinds.get(mid) === "camera" ? "camera" : "screen";
}

// ---------------------------------------------------------------------------
// Per-viewer quality

export interface CameraCap {
  /** Target frame height (the sender scales down from the capture height). */
  height: number;
  maxFramerate: number;
  /** bits/s */
  maxBitrate: number;
}

/** Group-size tiers (people in the call, including us). */
export const CAMERA_CAP_SMALL: CameraCap = { height: 720, maxFramerate: 30, maxBitrate: 1_500_000 }; // 2-3
export const CAMERA_CAP_MEDIUM: CameraCap = { height: 480, maxFramerate: 30, maxBitrate: 800_000 }; // 4-5
export const CAMERA_CAP_LARGE: CameraCap = { height: 360, maxFramerate: 24, maxBitrate: 400_000 }; // 6+
/** Viewer preference "low": strip thumbnails / small grid tiles. */
export const CAMERA_CAP_LOW: CameraCap = { height: 180, maxFramerate: 15, maxBitrate: 150_000 };

/** Sender-side default cap per viewer for a call of `participants` people (including us). */
export function cameraGroupCap(participants: number): CameraCap {
  if (participants <= 3) return CAMERA_CAP_SMALL;
  if (participants <= 5) return CAMERA_CAP_MEDIUM;
  return CAMERA_CAP_LARGE;
}

export interface CameraEncoding {
  active: boolean;
  scaleResolutionDownBy: number;
  maxFramerate: number;
  maxBitrate: number;
}

/** Assumed capture height when the track doesn't report one. */
export const DEFAULT_CAPTURE_HEIGHT = 720;

/**
 * Encoding for one viewer: min(group cap, viewer preference). `off` keeps the
 * cap values but deactivates the encoding (nothing is sent to that viewer).
 */
export function cameraEncoding(captureHeight: number | undefined, participants: number, pref: CameraPreference): CameraEncoding {
  const group = cameraGroupCap(participants);
  const cap: CameraCap =
    pref === "low"
      ? {
          height: Math.min(group.height, CAMERA_CAP_LOW.height),
          maxFramerate: Math.min(group.maxFramerate, CAMERA_CAP_LOW.maxFramerate),
          maxBitrate: Math.min(group.maxBitrate, CAMERA_CAP_LOW.maxBitrate),
        }
      : group;
  const h = captureHeight && captureHeight > 0 ? captureHeight : DEFAULT_CAPTURE_HEIGHT;
  const scale = h > cap.height ? Math.round((h / cap.height) * 1000) / 1000 : 1;
  return { active: pref !== "off", scaleResolutionDownBy: scale, maxFramerate: cap.maxFramerate, maxBitrate: cap.maxBitrate };
}

// ---------------------------------------------------------------------------
// Preferences (both sides)

export const DEFAULT_CAMERA_PREFERENCE: CameraPreference = "high";

const PREFS: ReadonlySet<string> = new Set(["off", "low", "high"]);

export function isCameraPreference(v: unknown): v is CameraPreference {
  return typeof v === "string" && PREFS.has(v);
}

export function isVideoPrefSignal(data: SignalData): data is Extract<SignalData, { kind: "video-pref" }> {
  return data.kind === "video-pref";
}

/**
 * - local ("wanted"): what WE asked each remote sender for. Survives connection
 *   resets and the remote leaving/rejoining (like per-user volume); re-sent on
 *   every new connection.
 * - remote ("granted"): what each viewer asked US for. Survives resets of that
 *   viewer's connection; forgotten when the viewer leaves our channel.
 */
export class CameraPrefs {
  private readonly wanted = new Map<string, CameraPreference>();
  private readonly granted = new Map<string, CameraPreference>();

  /** Local user sets a preference. Returns the signal to send, or null if unchanged. */
  setLocal(userId: string, pref: CameraPreference): SignalData | null {
    const prev = this.wanted.get(userId) ?? DEFAULT_CAMERA_PREFERENCE;
    this.wanted.set(userId, pref);
    return prev === pref ? null : { kind: "video-pref", camera: pref };
  }

  local(userId: string): CameraPreference {
    return this.wanted.get(userId) ?? DEFAULT_CAMERA_PREFERENCE;
  }

  /** Signals to (re)send when a connection to `userId` is (re)created. */
  signalsForNewPeer(userId: string): SignalData[] {
    const p = this.wanted.get(userId);
    return p && p !== DEFAULT_CAMERA_PREFERENCE ? [{ kind: "video-pref", camera: p }] : [];
  }

  /** A `video-pref` from a viewer. Returns true if it changed. */
  onRemote(from: string, pref: CameraPreference): boolean {
    const prev = this.remote(from);
    this.granted.set(from, pref);
    return prev !== pref;
  }

  remote(userId: string): CameraPreference {
    return this.granted.get(userId) ?? DEFAULT_CAMERA_PREFERENCE;
  }

  /** The user left our channel: forget what they asked of us (keep what we asked of them). */
  peerLeft(userId: string): void {
    this.granted.delete(userId);
  }

  clear(): void {
    this.wanted.clear();
    this.granted.clear();
  }
}

// ---------------------------------------------------------------------------
// Per-peer camera sender

export interface CameraSenderOptions {
  pc: Pick<RTCPeerConnection, "addTransceiver">;
  /** The engine-owned msid stream for the camera (same object for every peer). */
  msid: MediaStream;
  /** Called once with the new transceiver (codec preferences). */
  onTransceiver?(t: RTCRtpTransceiver): void;
  onError?(message: string, cause?: unknown): void;
}

export const CAMERA_DEGRADATION: RTCDegradationPreference = "balanced";

/**
 * The camera on one peer connection. First attach adds a sendonly transceiver
 * (one renegotiation); afterwards on/off/device switches are replaceTrack only
 * (no renegotiation). Parameter updates are serialized.
 */
export class CameraSender {
  transceiver: RTCRtpTransceiver | null = null;
  /** Track currently attached (null while the camera is off). */
  track: MediaStreamTrack | null = null;
  private chain: Promise<void> = Promise.resolve();
  private lastEncoding: CameraEncoding | undefined;
  private closed = false;

  constructor(private readonly opts: CameraSenderOptions) {}

  get isAttached(): boolean {
    return !!this.track;
  }

  get encoding(): CameraEncoding | undefined {
    return this.lastEncoding;
  }

  /** Send `track` (adds the transceiver on first use, else replaceTrack). */
  attach(track: MediaStreamTrack, enc: CameraEncoding): void {
    if (this.closed) return;
    const t = this.transceiver;
    if (!t || isStopped(t)) {
      this.track = track;
      this.lastEncoding = enc;
      this.transceiver = this.opts.pc.addTransceiver(track, {
        direction: "sendonly",
        streams: [this.opts.msid],
        sendEncodings: [
          {
            active: enc.active,
            maxBitrate: enc.maxBitrate,
            maxFramerate: enc.maxFramerate,
            scaleResolutionDownBy: enc.scaleResolutionDownBy,
          },
        ],
      });
      this.opts.onTransceiver?.(this.transceiver);
      this.tune(enc);
      return;
    }
    if (t.direction !== "sendonly" && t.direction !== "sendrecv") t.direction = "sendonly";
    if (this.track === track) {
      this.tune(enc);
      return;
    }
    this.track = track;
    // Parameters first so a viewer with "off" never gets a frame.
    this.tune(enc);
    this.enqueue(() => t.sender.replaceTrack(track), "Failed to attach camera");
  }

  /** Stop sending (keeps the transceiver and its direction: no renegotiation). */
  detach(): void {
    if (this.closed || !this.track) return;
    this.track = null;
    const t = this.transceiver;
    if (t) this.enqueue(() => t.sender.replaceTrack(null), "Failed to detach camera");
  }

  /** Apply encoding parameters (serialized; a no-op until negotiated, re-applied later). */
  tune(enc: CameraEncoding): Promise<void> {
    this.lastEncoding = enc;
    const t = this.transceiver;
    if (!t || this.closed) return this.chain;
    return this.enqueue(async () => {
      const e = this.lastEncoding!;
      await updateSenderParams(
        t.sender,
        (p) => {
          for (const x of p.encodings) {
            x.active = e.active;
            x.maxBitrate = e.maxBitrate;
            x.maxFramerate = e.maxFramerate;
            x.scaleResolutionDownBy = e.scaleResolutionDownBy;
          }
        },
        CAMERA_DEGRADATION,
      );
    }, "camera sender tuning failed");
  }

  /** Re-apply the last encoding (e.g. after a negotiation). */
  retune(): Promise<void> {
    return this.lastEncoding ? this.tune(this.lastEncoding) : this.chain;
  }

  close(): void {
    this.closed = true;
  }

  private enqueue(fn: () => Promise<unknown>, what: string): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        if (this.closed) return;
        await fn();
      })
      .catch((err) => {
        if (!this.closed) this.opts.onError?.(what, err);
      });
    return this.chain;
  }
}

function isStopped(t: RTCRtpTransceiver): boolean {
  return t.currentDirection === "stopped" || (t as { stopped?: boolean }).stopped === true;
}
