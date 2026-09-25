/**
 * Types and channel names shared by the main process, the preload bridge and
 * the renderer. Keep this file free of runtime imports so every side can use it.
 */

/** Mirror of the protocol `User` (kept local so main doesn't depend on zod). */
export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}

export interface StoredSession {
  serverUrl: string;
  token: string;
  user: SessionUser;
}

/**
 * A push-to-talk binding. `code` is a DOM `KeyboardEvent.code` (e.g. "KeyV",
 * "F13", "ControlLeft") or "Mouse3".."Mouse5" for middle/side mouse buttons.
 * The main process maps it to a uiohook keycode / button for the global hook.
 */
export interface PttBinding {
  code: string;
  /** Human-readable label for the UI. */
  label: string;
}

export interface PttRegisterResult {
  /** True if the global (system-wide) hook is watching this binding. */
  global: boolean;
  /** Why the global hook isn't in use, if it isn't. */
  reason?: string;
}

/** A capturable screen or window, for the Go Live picker. */
export interface ScreenSource {
  /** desktopCapturer id, e.g. "screen:0:0" / "window:1234:0". */
  id: string;
  name: string;
  kind: "screen" | "window";
  /** JPEG data URL (empty string if the OS gave no thumbnail, e.g. minimized). */
  thumbnail: string;
  /** PNG data URL of the owning app's icon (windows only), or null. */
  appIcon: string | null;
  /** Display id for screens ("" for windows). */
  displayId: string;
}

/**
 * How stream audio is captured:
 *  - "system": everything the PC plays, minus Shpihcord's own playback when
 *    `excludesOwnAudio` (so friends don't hear themselves);
 *  - "app": only the shared window's application (process tree);
 *  - "none": video only.
 */
export type ScreenAudioMode = "system" | "app" | "none";

export interface ScreenAudioSupport {
  /** System audio can be captured on this platform. */
  system: boolean;
  /** Our own playback (voice chat) is excluded from system audio (best knowledge; verified per track). */
  excludesOwnAudio: boolean;
  /** "Share only this app's audio" is available for window shares. */
  appAudio: boolean;
  /** Shown in the picker when something is limited. */
  note?: string;
}

export interface ScreenSelectRequest {
  sourceId: string;
  audio: ScreenAudioMode;
}

export interface ScreenSelectResult {
  ok: boolean;
  /** The audio mode actually granted (e.g. "app" falls back to "system" if the window's process is unknown). */
  audio: ScreenAudioMode;
  reason?: string;
}

export interface ShpihcordApi {
  platform: string;
  getVersion(): Promise<string>;
  session: {
    load(): Promise<StoredSession | null>;
    /** Returns false if OS-level encryption is unavailable (session not persisted). */
    save(session: StoredSession): Promise<boolean>;
    clear(): Promise<void>;
  };
  ptt: {
    /** Whether the native global hook (uiohook-napi) loaded. */
    isGlobalAvailable(): Promise<boolean>;
    /** Start watching `binding` globally, or stop with null. */
    setBinding(binding: PttBinding | null): Promise<PttRegisterResult>;
    /** Global PTT key state changes (only fires while a binding is registered). */
    onState(handler: (pressed: boolean) => void): () => void;
    /**
     * Record the next key / mouse button pressed anywhere (global hook). Resolves
     * with null on timeout/cancel or when the global hook is unavailable.
     */
    record(timeoutMs?: number): Promise<PttBinding | null>;
    cancelRecord(): void;
  };
  screen: {
    getSources(): Promise<ScreenSource[]>;
    audioSupport(): Promise<ScreenAudioSupport>;
    /**
     * Arm the next getDisplayMedia() call with this source. Must be followed by
     * getDisplayMedia within a few seconds; the selection is single-use.
     */
    select(req: ScreenSelectRequest): Promise<ScreenSelectResult>;
  };
  window: {
    /**
     * The main window was minimized/hidden (false) or restored/shown (true).
     * Needed because backgroundThrottling=false keeps document.visibilityState
     * "visible" while minimized.
     */
    onVisibility(handler: (visible: boolean) => void): () => void;
  };
}

export const IPC = {
  version: "app:version",
  sessionLoad: "session:load",
  sessionSave: "session:save",
  sessionClear: "session:clear",
  pttAvailable: "ptt:available",
  pttSetBinding: "ptt:set-binding",
  pttState: "ptt:state",
  pttRecord: "ptt:record",
  pttCancelRecord: "ptt:cancel-record",
  screenGetSources: "screen:getSources",
  screenAudioSupport: "screen:audioSupport",
  screenSelect: "screen:select",
  windowVisibility: "window:visibility",
} as const;
