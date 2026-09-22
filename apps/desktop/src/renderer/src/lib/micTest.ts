/**
 * Mic level monitor for the settings modal. Uses the active call's level when
 * in voice; otherwise a throwaway VoiceCall with no peers (same level scale as
 * the real VAD), falling back to a plain AnalyserNode if the engine can't start.
 */
import { createVoiceCall, type VoiceCall } from "@shpihcord/call-engine";
import { getSettings, useSettings } from "../store/settings";
import { hasActiveCall, onLocalLevel } from "./voice";

export type LevelHandler = (level: number) => void;

/** Map RMS amplitude to 0..1 (-60 dBFS .. 0 dBFS). */
export function rmsToLevel(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

class AnalyserMonitor {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private level = 0;
  private stopped = false;

  constructor(private readonly onLevel: LevelHandler) {}

  async start(): Promise<void> {
    const s = getSettings();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: s.inputDeviceId && s.inputDeviceId !== "default" ? { exact: s.inputDeviceId } : undefined,
        noiseSuppression: s.noiseSuppression,
        echoCancellation: s.echoCancellation,
        autoGainControl: s.autoGainControl,
      },
    });
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const lvl = rmsToLevel(Math.sqrt(sum / buf.length));
      this.level = Math.max(lvl, this.level * 0.8);
      this.onLevel(this.level);
    }, 50);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
  }
}

/**
 * Start monitoring. Restarts automatically when input-related settings change.
 * Returns a stop function. `onError` receives a user-facing message.
 */
export function startMicTest(onLevel: LevelHandler, onError: (message: string) => void): () => void {
  if (hasActiveCall()) return onLocalLevel(onLevel);

  let stopped = false;
  let testCall: VoiceCall | null = null;
  let offLevel: (() => void) | null = null;
  let analyser: AnalyserMonitor | null = null;

  const stopCurrent = (): void => {
    offLevel?.();
    offLevel = null;
    try {
      testCall?.close();
    } catch {
      /* ignore */
    }
    testCall = null;
    analyser?.stop();
    analyser = null;
  };

  let runSeq = 0;
  const run = async (): Promise<void> => {
    const seq = ++runSeq;
    const stale = (): boolean => stopped || seq !== runSeq;
    stopCurrent();
    const s = getSettings();
    let c: VoiceCall | null = null;
    let off: (() => void) | null = null;
    try {
      c = createVoiceCall({
        selfId: "__mic_test__",
        iceServers: [],
        signaling: { send: () => {}, onSignal: () => () => {} },
        inputDeviceId: s.inputDeviceId === "default" ? undefined : s.inputDeviceId,
        inputMode: "voice-activity",
        vadThreshold: s.vadThreshold,
        noiseSuppression: s.noiseSuppression,
        echoCancellation: s.echoCancellation,
        autoGainControl: s.autoGainControl,
      });
      testCall = c;
      off = c.on("localLevel", ({ level }) => {
        if (!stale()) onLevel(level);
      });
      offLevel = off;
      await c.start();
      if (stale()) {
        off();
        c.close();
      }
      return;
    } catch (err) {
      off?.();
      try {
        c?.close();
      } catch {
        /* ignore */
      }
      if (stale()) return;
      testCall = null;
      offLevel = null;
      console.info("[micTest] engine monitor unavailable, using analyser:", err);
    }
    const a = new AnalyserMonitor(onLevel);
    analyser = a;
    try {
      await a.start();
      if (stale()) a.stop();
    } catch (err) {
      a.stop();
      if (stale()) return;
      const name = err instanceof Error ? err.name : "";
      onError(
        name === "NotAllowedError"
          ? "Microphone access was denied."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "Selected microphone isn't available."
            : "Couldn't open the microphone.",
      );
    }
  };

  void run();
  const unsub = useSettings.subscribe((s, prev) => {
    if (
      s.inputDeviceId !== prev.inputDeviceId ||
      s.noiseSuppression !== prev.noiseSuppression ||
      s.echoCancellation !== prev.echoCancellation ||
      s.autoGainControl !== prev.autoGainControl
    ) {
      void run();
    } else if (s.vadThreshold !== prev.vadThreshold) {
      testCall?.setVadThreshold(s.vadThreshold);
    }
  });

  return () => {
    stopped = true;
    unsub();
    stopCurrent();
  };
}
