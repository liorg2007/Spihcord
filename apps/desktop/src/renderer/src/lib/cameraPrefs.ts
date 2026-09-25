/**
 * Decides how much of each remote camera we want ("off" | "low" | "high") and
 * tells the engine, which forwards it to the sender as a `video-pref` signal so
 * no bandwidth is spent on video we can't see (PLAN §5a.3).
 *
 *  - off:  no visible tile (IntersectionObserver; also when the call view isn't
 *          shown at all), the window is hidden/minimized, the user hid that
 *          camera, or "Don't receive video" is on.
 *  - low:  every visible tile is a stage-strip thumbnail or narrower than 320 px.
 *  - high: otherwise.
 *
 * Only changes are sent, debounced by 300 ms so layout churn (tiles mounting,
 * observers settling, window resizes) collapses into one update.
 */
import { useCallback, useEffect, useRef } from "react";
import type { CameraPreference } from "@shpihcord/call-engine";
import { getApp, useApp } from "../store/app";
import { getSettings, useSettings } from "../store/settings";
import { bridge } from "./bridge";

const DEBOUNCE_MS = 300;
/** Tiles narrower than this get the low (180p) layer. */
export const LOW_WIDTH_PX = 320;
/** The engine's default for a user we never sent a preference for. */
const ENGINE_DEFAULT: CameraPreference = "high";

interface TileReport {
  userId: string;
  visible: boolean;
  width: number;
  compact: boolean;
}

type Sender = (userId: string, pref: CameraPreference) => void;

const tiles = new Map<number, TileReport>();
let nextTileId = 1;
/** What the current call's engine was last told, per user. */
let lastSent = new Map<string, CameraPreference>();
let sender: Sender | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** From the main process (minimize/hide); see ShpihcordApi.window. */
let windowVisible = true;

/** Register the function that applies a preference to the active call (null when idle). */
export function setCameraPrefSender(fn: Sender | null): void {
  sender = fn;
  // A new call = a new engine with default preferences.
  lastSent = new Map();
  if (fn) schedule();
}

/** Compute the wanted preference for one remote user from the current state. */
export function computeCameraPreference(userId: string): CameraPreference {
  const s = getSettings();
  if (s.disableIncomingVideo || s.hiddenVideos[userId]) return "off";
  if (!windowVisible || (typeof document !== "undefined" && document.visibilityState === "hidden")) return "off";
  let best: CameraPreference = "off";
  for (const t of tiles.values()) {
    if (t.userId !== userId || !t.visible) continue;
    if (!t.compact && t.width >= LOW_WIDTH_PX) return "high";
    best = "low";
  }
  return best;
}

function flush(): void {
  timer = null;
  const send = sender;
  if (!send) return;
  const { voiceStates, voiceChannelId, self } = getApp();
  if (!voiceChannelId) return;
  for (const vs of Object.values(voiceStates)) {
    if (vs.channelId !== voiceChannelId || vs.userId === self?.id) continue;
    const pref = computeCameraPreference(vs.userId);
    if ((lastSent.get(vs.userId) ?? ENGINE_DEFAULT) === pref) continue;
    lastSent.set(vs.userId, pref);
    try {
      send(vs.userId, pref);
    } catch (err) {
      console.warn("[camera] setCameraPreference failed", err);
    }
  }
}

/** Recompute everything after DEBOUNCE_MS (coalesces bursts). */
export function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE_MS);
}

// Global inputs: window visibility, settings, and who is in our channel.
if (typeof document !== "undefined") document.addEventListener("visibilitychange", schedule);
bridge.window.onVisibility((visible) => {
  if (visible === windowVisible) return;
  windowVisible = visible;
  schedule();
});
useSettings.subscribe((s, prev) => {
  if (s.disableIncomingVideo !== prev.disableIncomingVideo || s.hiddenVideos !== prev.hiddenVideos) schedule();
});
useApp.subscribe((s, prev) => {
  if (s.voiceStates !== prev.voiceStates || s.voiceChannelId !== prev.voiceChannelId) schedule();
});

/**
 * Report a participant tile's visibility and size. Returns a ref callback for
 * the tile element. Pass `enabled=false` for the self tile.
 */
export function useCameraPrefTile(userId: string, compact: boolean, enabled = true): (el: HTMLElement | null) => void {
  const idRef = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);
  const compactRef = useRef(compact);
  compactRef.current = compact;

  // Keep `compact` in sync without re-observing.
  useEffect(() => {
    const t = tiles.get(idRef.current);
    if (t && t.compact !== compact) {
      t.compact = compact;
      schedule();
    }
  }, [compact]);

  return useCallback(
    (el: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!el || !enabled) return;
      const id = nextTileId++;
      idRef.current = id;
      const report: TileReport = { userId, visible: false, width: el.getBoundingClientRect().width, compact: compactRef.current };
      tiles.set(id, report);
      schedule();

      const io =
        typeof IntersectionObserver !== "undefined"
          ? new IntersectionObserver(
              (entries) => {
                const e = entries[entries.length - 1];
                const visible = e.isIntersecting && e.intersectionRatio > 0;
                if (visible !== report.visible) {
                  report.visible = visible;
                  schedule();
                }
              },
              { threshold: [0, 0.05] },
            )
          : null;
      if (io) io.observe(el);
      else report.visible = true;

      const ro =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver((entries) => {
              const w = entries[entries.length - 1].contentRect.width;
              // Only the threshold crossing matters.
              const crossed = w >= LOW_WIDTH_PX !== report.width >= LOW_WIDTH_PX;
              report.width = w;
              if (crossed) schedule();
            })
          : null;
      ro?.observe(el);

      cleanupRef.current = () => {
        io?.disconnect();
        ro?.disconnect();
        tiles.delete(id);
        schedule();
      };
    },
    [userId, enabled],
  );
}
