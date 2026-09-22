/** User preferences, persisted in localStorage. */
import { create } from "zustand";
import type { InputMode } from "@shpihcord/call-engine";
import type { PttBinding } from "../../../shared/ipc";

export interface Settings {
  inputDeviceId: string;
  outputDeviceId: string;
  inputMode: InputMode;
  pttBinding: PttBinding | null;
  /** 0..1 on the normalized mic level. */
  vadThreshold: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  forceRelay: boolean;
  /** Per-user playback volume 0..2 (1 = 100%). */
  userVolumes: Record<string, number>;
  /** Per-user local mute. */
  userMuted: Record<string, boolean>;
  /** Self mute / deafen persist like Discord. */
  selfMuted: boolean;
  selfDeafened: boolean;
  soundsEnabled: boolean;
  showMemberList: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  inputDeviceId: "default",
  outputDeviceId: "default",
  inputMode: "voice-activity",
  pttBinding: { code: "Backquote", label: "`" },
  vadThreshold: 0.25,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  forceRelay: false,
  userVolumes: {},
  userMuted: {},
  selfMuted: false,
  selfDeafened: false,
  soundsEnabled: true,
  showMemberList: true,
};

const KEY = "shpihcord.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged: Settings = { ...DEFAULT_SETTINGS, ...parsed };
    // Light sanitation of values that could break the UI.
    if (merged.inputMode !== "voice-activity" && merged.inputMode !== "push-to-talk") merged.inputMode = "voice-activity";
    if (typeof merged.vadThreshold !== "number" || !Number.isFinite(merged.vadThreshold)) merged.vadThreshold = DEFAULT_SETTINGS.vadThreshold;
    merged.vadThreshold = Math.min(1, Math.max(0, merged.vadThreshold));
    if (!merged.userVolumes || typeof merged.userVolumes !== "object") merged.userVolumes = {};
    if (!merged.userMuted || typeof merged.userMuted !== "object") merged.userMuted = {};
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function save(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full / unavailable: settings stay in memory */
  }
}

interface SettingsStore extends Settings {
  update(patch: Partial<Settings>): void;
  setUserVolume(userId: string, volume: number): void;
  setUserMuted(userId: string, muted: boolean): void;
}

export const useSettings = create<SettingsStore>()((set, get) => ({
  ...load(),
  update: (patch) => set(patch),
  setUserVolume: (userId, volume) =>
    set({ userVolumes: { ...get().userVolumes, [userId]: Math.min(2, Math.max(0, volume)) } }),
  setUserMuted: (userId, muted) => set({ userMuted: { ...get().userMuted, [userId]: muted } }),
}));

let saveTimer: ReturnType<typeof setTimeout> | null = null;
useSettings.subscribe((state) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { update: _u, setUserVolume: _v, setUserMuted: _m, ...data } = state;
    save(data);
  }, 150);
});

export function getSettings(): Settings {
  return useSettings.getState();
}
