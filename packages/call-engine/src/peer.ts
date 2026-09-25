/**
 * One RTCPeerConnection to one remote user, using the W3C "perfect negotiation"
 * pattern. No DOM globals are touched here: the RTCPeerConnection is built by an
 * injected factory, so this module is testable with a fake.
 */
import type { SignalData } from "@shpihcord/protocol";
import { extractFingerprint, mungeOpusForVoice } from "./sdp";

export type PcFactory = (config: RTCConfiguration) => RTCPeerConnection;

export interface PeerTimings {
  /** Restart ICE if 'disconnected' persists this long. */
  disconnectedGraceMs: number;
  /** Ask the owner to recreate the peer if it doesn't recover within this long after failing/disconnecting. */
  failedTeardownMs: number;
  /** Ask the owner to recreate the peer if it never connects within this long. */
  connectTimeoutMs: number;
  /**
   * The polite side does not send the *initial* offer; it waits this long for the
   * impolite side's offer first. Avoids glare + implicit rollback on every new
   * connection (Chromium can stall ICE gathering forever when a local offer is
   * rolled back before gathering starts).
   */
  politeInitialOfferDelayMs: number;
}

export const DEFAULT_PEER_TIMINGS: PeerTimings = {
  disconnectedGraceMs: 5_000,
  failedTeardownMs: 30_000,
  connectTimeoutMs: 15_000,
  politeInitialOfferDelayMs: 3_000,
};

export type ResetReason = "failed" | "connect-timeout" | "remote-restarted" | "negotiation-error";

export interface SenderTuning {
  maxBitrate?: number;
  priority?: RTCPriorityType;
}

export interface PeerOptions {
  userId: string;
  polite: boolean;
  config: RTCConfiguration;
  createPc: PcFactory;
  /** Track sent to this peer (the shared, gated local destination track). */
  localTrack?: MediaStreamTrack | null;
  localStreams?: MediaStream[];
  send(data: SignalData): void;
  onTrack?(track: MediaStreamTrack, stream: MediaStream | undefined, transceiver: RTCRtpTransceiver | undefined): void;
  /** Signaling returned to 'stable' (a negotiation round completed or was rolled back). */
  onNegotiated?(): void;
  onConnectionState?(state: RTCPeerConnectionState): void;
  onError?(message: string, cause?: unknown): void;
  /**
   * Ask the owner to discard this peer and create a fresh one. `replay` are
   * signals that should be fed into the new peer (e.g. the offer that revealed
   * the remote side started a new session).
   */
  onReset?(reason: ResetReason, replay?: SignalData[]): void;
  /** Transform outgoing SDP (default: Opus voice munging). */
  mungeSdp?: (sdp: string) => string;
  /**
   * Consulted before each setLocalDescription. Return a transform to apply the
   * description through createOffer/createAnswer + munged setLocalDescription;
   * null (default) keeps the atomic parameterless setLocalDescription().
   */
  localSdpTransform?: () => ((sdp: string) => string) | null;
  timings?: Partial<PeerTimings>;
  /** Sender encoding parameters applied once connected; null to skip. */
  senderTuning?: SenderTuning | null;
}

type Timer = ReturnType<typeof setTimeout>;

export class Peer {
  readonly userId: string;
  readonly polite: boolean;
  readonly pc: RTCPeerConnection;

  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;
  private closed = false;
  private resetRequested = false;
  private senderTuned = false;
  /** We (polite) rolled back a local offer: Chromium can leave the mic send stream stopped. */
  private rolledBack = false;
  private micSender: RTCRtpSender | undefined;
  private initialOfferTimer: ReturnType<typeof setTimeout> | undefined;

  private disconnectTimer: Timer | undefined;
  private teardownTimer: Timer | undefined;
  private readonly timings: PeerTimings;
  private readonly munge: (sdp: string) => string;

  constructor(private readonly opts: PeerOptions) {
    this.userId = opts.userId;
    this.polite = opts.polite;
    this.timings = { ...DEFAULT_PEER_TIMINGS, ...opts.timings };
    this.munge = opts.mungeSdp ?? mungeOpusForVoice;

    const pc = opts.createPc(opts.config);
    this.pc = pc;

    pc.onnegotiationneeded = () => {
      void this.negotiate();
    };
    pc.onicecandidate = (ev) => {
      if (this.closed) return;
      const c = ev.candidate;
      if (!c || !c.candidate) {
        this.opts.send({ kind: "candidate", candidate: null });
        return;
      }
      const init = typeof c.toJSON === "function" ? c.toJSON() : (c as RTCIceCandidateInit);
      this.opts.send({
        kind: "candidate",
        candidate: {
          candidate: init.candidate ?? "",
          sdpMid: init.sdpMid ?? null,
          sdpMLineIndex: init.sdpMLineIndex ?? null,
          usernameFragment: init.usernameFragment ?? null,
        },
      });
    };
    pc.ontrack = (ev) => {
      if (this.closed) return;
      this.opts.onTrack?.(ev.track, ev.streams?.[0], ev.transceiver);
    };
    pc.onconnectionstatechange = () => this.handleConnectionState();
    pc.onsignalingstatechange = () => {
      if (this.closed || this.pc.signalingState !== "stable") return;
      if (this.rolledBack) {
        this.rolledBack = false;
        void this.kickMicSender();
      }
      this.opts.onNegotiated?.();
    };

    if (opts.localTrack) {
      this.micSender = pc.addTrack(opts.localTrack, ...(opts.localStreams ?? []));
    } else {
      this.micSender = pc.addTransceiver("audio", { direction: "sendrecv" })?.sender;
    }

    this.armTeardown("connect-timeout", this.timings.connectTimeoutMs);
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Feed a signal received from this peer. Never rejects. */
  async handleSignal(data: SignalData): Promise<void> {
    if (this.closed) return;
    const pc = this.pc;
    if (data.kind === "candidate") {
      try {
        if (data.candidate) await pc.addIceCandidate(data.candidate);
        else await pc.addIceCandidate();
      } catch {
        // Candidates for an ignored offer, a stale session, or an unsupported
        // end-of-candidates form are expected to fail; never fatal.
      }
      return;
    }
    if (data.kind !== "description") return; // 'stream' signals are handled by the owner

    const description = data.description;
    const hadRemote = !!pc.currentRemoteDescription;
    try {
      if (description.type === "offer" && this.isForeignSession(description.sdp)) {
        // The remote side recreated its RTCPeerConnection (new DTLS identity):
        // this connection can't be renegotiated into it. Start over.
        this.requestReset("remote-restarted", [data]);
        return;
      }
      const readyForOffer =
        !this.makingOffer && (pc.signalingState === "stable" || this.isSettingRemoteAnswerPending);
      const offerCollision = description.type === "offer" && !readyForOffer;
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;
      // Only a renegotiation rollback (not the initial glare) has been seen to stall the mic.
      if (offerCollision && pc.currentLocalDescription) this.rolledBack = true;

      this.isSettingRemoteAnswerPending = description.type === "answer";
      try {
        await pc.setRemoteDescription(description as RTCSessionDescriptionInit);
      } finally {
        this.isSettingRemoteAnswerPending = false;
      }
      if (this.closed) return;
      if (description.type === "offer") {
        if (!(await this.setLocal()) || this.closed) return;
        this.sendLocalDescription();
      }
    } catch (err) {
      if (this.closed) return;
      if (description.type === "offer" && hadRemote) {
        this.requestReset("negotiation-error", [data]);
      } else {
        this.opts.onError?.(`Failed to apply ${description.type} from ${this.userId}`, err);
      }
    }
  }

  restartIce(): void {
    if (this.closed) return;
    try {
      this.pc.restartIce();
    } catch (err) {
      this.opts.onError?.(`ICE restart failed for ${this.userId}`, err);
    }
  }

  setConfiguration(config: RTCConfiguration): void {
    if (this.closed) return;
    try {
      this.pc.setConfiguration(config);
    } catch (err) {
      this.opts.onError?.(`Failed to update ICE configuration for ${this.userId}`, err);
    }
  }

  getStats(): Promise<RTCStatsReport> {
    return this.pc.getStats();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    const pc = this.pc;
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.onsignalingstatechange = null;
    try {
      pc.close();
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------

  private async negotiate(force = false): Promise<void> {
    if (this.closed) return;
    if (!force && this.polite && !this.pc.currentRemoteDescription && !this.pc.currentLocalDescription) {
      // Initial negotiation: let the impolite side offer; fall back to offering ourselves.
      this.initialOfferTimer ??= setTimeout(() => {
        this.initialOfferTimer = undefined;
        if (!this.closed && !this.pc.currentRemoteDescription && this.pc.signalingState === "stable") {
          void this.negotiate(true);
        }
      }, this.timings.politeInitialOfferDelayMs);
      return;
    }
    try {
      this.makingOffer = true;
      if (!(await this.setLocal())) return;
      if (this.closed) return;
      this.sendLocalDescription();
    } catch (err) {
      if (!this.closed) this.opts.onError?.(`Failed to create offer for ${this.userId}`, err);
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * setLocalDescription, optionally through a munged createOffer/createAnswer.
   * Returns false when the signaling state moved on meanwhile (an incoming
   * offer won the race); negotiationneeded fires again once stable.
   */
  private async setLocal(): Promise<boolean> {
    const pc = this.pc;
    const transform = this.opts.localSdpTransform?.() ?? null;
    if (!transform) {
      await pc.setLocalDescription();
      return true;
    }
    const state = pc.signalingState;
    if (state !== "stable" && state !== "have-remote-offer") return false;
    const desc = state === "have-remote-offer" ? await pc.createAnswer() : await pc.createOffer();
    if (this.closed || pc.signalingState !== state) return false;
    try {
      await pc.setLocalDescription({ type: desc.type, sdp: transform(desc.sdp ?? "") });
    } catch (err) {
      if (this.closed || pc.signalingState !== state) return false;
      // Munged SDP rejected: fall back to the plain description.
      console.warn(`[call-engine] munged local ${desc.type} rejected, using the plain one`, err);
      await pc.setLocalDescription();
    }
    return true;
  }

  private sendLocalDescription(): void {
    const desc = this.pc.localDescription;
    if (!desc) return;
    const sdp = desc.sdp && (desc.type === "offer" || desc.type === "answer") ? this.munge(desc.sdp) : desc.sdp;
    this.opts.send({ kind: "description", description: { type: desc.type, sdp } });
  }

  private isForeignSession(sdp: string | undefined): boolean {
    const current = extractFingerprint(this.pc.currentRemoteDescription?.sdp);
    const incoming = extractFingerprint(sdp);
    return !!current && !!incoming && current !== incoming;
  }

  private handleConnectionState(): void {
    if (this.closed) return;
    const state = this.pc.connectionState;
    this.opts.onConnectionState?.(state);
    switch (state) {
      case "connected":
        this.clearTimers();
        void this.tuneSender();
        break;
      case "disconnected":
        if (!this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = undefined;
            if (!this.closed && this.pc.connectionState === "disconnected") this.restartIceIfImpolite();
          }, this.timings.disconnectedGraceMs);
        }
        this.armTeardown("failed", this.timings.failedTeardownMs);
        break;
      case "failed":
        if (this.disconnectTimer) {
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = undefined;
        }
        this.restartIceIfImpolite();
        this.armTeardown("failed", this.timings.failedTeardownMs);
        break;
      case "closed":
        this.clearTimers();
        break;
    }
  }

  private restartIceIfImpolite(): void {
    if (!this.polite) this.restartIce();
  }

  private armTeardown(reason: ResetReason, ms: number): void {
    if (this.teardownTimer) return;
    this.teardownTimer = setTimeout(() => {
      this.teardownTimer = undefined;
      if (this.closed || this.pc.connectionState === "connected") return;
      this.requestReset(reason);
    }, ms);
  }

  private requestReset(reason: ResetReason, replay?: SignalData[]): void {
    if (this.closed || this.resetRequested) return;
    this.resetRequested = true;
    this.opts.onReset?.(reason, replay);
  }

  private clearTimers(): void {
    if (this.initialOfferTimer) clearTimeout(this.initialOfferTimer);
    this.initialOfferTimer = undefined;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    if (this.teardownTimer) clearTimeout(this.teardownTimer);
    this.disconnectTimer = undefined;
    this.teardownTimer = undefined;
  }

  /**
   * After an implicit rollback Chromium may recreate the mic's send stream (new
   * SSRC, parameters reset) without starting it: re-apply the track and the
   * sender parameters, which restarts it.
   */
  private async kickMicSender(): Promise<void> {
    const sender = this.micSender;
    if (!sender || this.closed || typeof sender.getParameters !== "function") return;
    // Encodings are empty until Chromium re-creates the send stream; wait for that.
    for (let i = 0; i < 50 && !this.closed; i++) {
      try {
        if ((sender.getParameters().encodings?.length ?? 0) > 0) break;
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.closed) return;
    try {
      const track = sender.track;
      if (track) {
        await sender.replaceTrack(null);
        await sender.replaceTrack(track);
      }
    } catch {
      /* best effort */
    }
    this.senderTuned = false;
    if (this.pc.connectionState === "connected") await this.tuneSender();
  }

  private async tuneSender(): Promise<void> {
    const tuning = this.opts.senderTuning;
    if (this.senderTuned || !tuning) return;
    this.senderTuned = true;
    // Only the mic sender: screen-share senders are tuned by their owner.
    for (const sender of this.micSender ? [this.micSender] : []) {
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) continue;
        for (const enc of params.encodings) {
          if (tuning.maxBitrate) enc.maxBitrate = tuning.maxBitrate;
          if (tuning.priority) {
            enc.priority = tuning.priority;
            enc.networkPriority = tuning.priority;
          }
        }
        await sender.setParameters(params);
      } catch {
        // Not critical (older engines reject some fields).
      }
    }
  }
}
