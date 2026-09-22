import type { ScreenSharePreset, ScreenSharePresetId } from "./types";

/** Quality presets for screen sharing (PLAN.md §5.2). Bitrates are per viewer. */
export const SCREEN_SHARE_PRESETS: Record<ScreenSharePresetId, ScreenSharePreset> = {
  text: { id: "text", label: "Text / Code", maxWidth: 3840, maxHeight: 2160, frameRate: 15, maxBitrate: 5_000_000, contentHint: "text" },
  balanced: { id: "balanced", label: "1080p 60fps", maxWidth: 1920, maxHeight: 1080, frameRate: 60, maxBitrate: 6_000_000, contentHint: "motion" },
  gaming: { id: "gaming", label: "1440p 60fps", maxWidth: 2560, maxHeight: 1440, frameRate: 60, maxBitrate: 12_000_000, contentHint: "motion" },
  source: { id: "source", label: "Source", maxWidth: 3840, maxHeight: 2160, frameRate: 60, maxBitrate: 20_000_000, contentHint: "motion" },
};
