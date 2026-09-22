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
} as const;
