/** Short UI sounds synthesized with WebAudio oscillators (no asset files). */
import { getSettings } from "../store/settings";

export type SoundName = "join" | "leave" | "peerJoin" | "peerLeave" | "mute" | "unmute" | "deafen" | "undeafen" | "error";

interface Note {
  freq: number;
  /** start offset (s) */
  at: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

const SOUNDS: Record<SoundName, Note[]> = {
  join: [
    { freq: 587.33, at: 0, dur: 0.12 },
    { freq: 880, at: 0.1, dur: 0.18 },
  ],
  leave: [
    { freq: 880, at: 0, dur: 0.12 },
    { freq: 523.25, at: 0.1, dur: 0.2 },
  ],
  peerJoin: [
    { freq: 659.25, at: 0, dur: 0.09, gain: 0.6 },
    { freq: 987.77, at: 0.08, dur: 0.14, gain: 0.6 },
  ],
  peerLeave: [
    { freq: 987.77, at: 0, dur: 0.09, gain: 0.6 },
    { freq: 659.25, at: 0.08, dur: 0.14, gain: 0.6 },
  ],
  mute: [{ freq: 440, at: 0, dur: 0.09, type: "triangle" }, { freq: 330, at: 0.07, dur: 0.1, type: "triangle" }],
  unmute: [{ freq: 330, at: 0, dur: 0.09, type: "triangle" }, { freq: 494, at: 0.07, dur: 0.1, type: "triangle" }],
  deafen: [{ freq: 392, at: 0, dur: 0.1, type: "triangle" }, { freq: 261.63, at: 0.08, dur: 0.14, type: "triangle" }],
  undeafen: [{ freq: 261.63, at: 0, dur: 0.1, type: "triangle" }, { freq: 392, at: 0.08, dur: 0.14, type: "triangle" }],
  error: [{ freq: 220, at: 0, dur: 0.25, type: "square", gain: 0.35 }],
};

let ctx: AudioContext | null = null;
let currentSink = "default";

function getCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext({ latencyHint: "interactive" });
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Route UI sounds to the selected output device (Chromium AudioContext.setSinkId). */
export async function setSoundOutputDevice(deviceId: string): Promise<void> {
  currentSink = deviceId || "default";
  const c = ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
  if (!c?.setSinkId) return;
  try {
    await c.setSinkId(currentSink === "default" ? "" : currentSink);
  } catch (err) {
    console.warn("[sounds] setSinkId failed", err);
  }
}

export function playSound(name: SoundName, volume = 0.18): void {
  const settings = getSettings();
  if (!settings.soundsEnabled) return;
  // Deafened users only hear their own deafen/undeafen feedback.
  if (settings.selfDeafened && name !== "undeafen" && name !== "deafen") return;
  const hadCtx = !!ctx;
  const c = getCtx();
  if (!c) return;
  if (!hadCtx && settings.outputDeviceId !== "default") void setSoundOutputDevice(settings.outputDeviceId);
  const master = c.createGain();
  master.gain.value = volume;
  master.connect(c.destination);
  const t0 = c.currentTime + 0.01;
  let end = t0;
  for (const n of SOUNDS[name]) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.value = n.freq;
    const start = t0 + n.at;
    const stop = start + n.dur;
    const peak = n.gain ?? 1;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, stop);
    osc.connect(g).connect(master);
    osc.start(start);
    osc.stop(stop + 0.02);
    end = Math.max(end, stop);
  }
  setTimeout(() => master.disconnect(), (end - c.currentTime + 0.2) * 1000);
}
