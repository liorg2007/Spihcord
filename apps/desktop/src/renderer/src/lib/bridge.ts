import { platformCaps } from "../../../shared/platform";
import type { PttRegisterResult, ShpihcordApi, StoredSession } from "../../../shared/ipc";

/**
 * The preload API, or an in-memory fallback so the renderer can also run in a
 * plain browser tab during development (no persistence, no global PTT).
 */
function browserFallback(): ShpihcordApi {
  let mem: StoredSession | null = null;
  const noGlobal: PttRegisterResult = { global: false, reason: "not running in Electron" };
  return {
    platform: "browser",
    getVersion: async () => "dev",
    caps: async () => platformCaps("browser", {}, ""),
    openSystemSettings: async () => {},
    session: {
      load: async () => mem,
      save: async (s) => {
        mem = s;
        return false;
      },
      clear: async () => {
        mem = null;
      },
    },
    ptt: {
      isGlobalAvailable: async () => false,
      setBinding: async () => noGlobal,
      onState: () => () => {},
      record: async () => null,
      cancelRecord: () => {},
      accessibility: async () => "not-needed",
    },
    screen: {
      getSources: async () => [],
      audioSupport: async () => ({ system: false, excludesOwnAudio: false, appAudio: false, note: "Not running in Electron." }),
      permission: async () => "granted",
      select: async () => ({ ok: false, audio: "none", reason: "not running in Electron" }),
    },
    window: {
      onVisibility: () => () => {},
    },
  };
}

export const bridge: ShpihcordApi = window.shpihcord ?? browserFallback();
