/**
 * Renderer permission policy: microphone + camera ("media" with audio/video)
 * and output-device selection; everything else is denied. Screen capture
 * ("Go Live") is gated separately by the display-media request handler.
 */
import { systemPreferences, type Session } from "electron";

type MediaKind = "audio" | "video";

function isMediaKind(t: unknown): t is MediaKind {
  return t === "audio" || t === "video";
}

/** macOS asks the user once per app (TCC); other platforms have no app-level prompt here. */
async function osAllows(kinds: MediaKind[]): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  for (const k of kinds) {
    const type = k === "audio" ? "microphone" : "camera";
    try {
      const status = systemPreferences.getMediaAccessStatus(type);
      if (status === "granted") continue;
      if (status === "denied" || status === "restricted") return false;
      if (!(await systemPreferences.askForMediaAccess(type))) return false;
    } catch {
      // Unknown status: let Chromium try (it reports NotAllowedError if the OS refuses).
    }
  }
  return true;
}

/**
 * `isAppPage(wc, url)`: true only for our own main window showing our own
 * bundled page (origin scoping; any other webContents / origin is denied).
 */
export function setupPermissions(
  ses: Session,
  isAppPage: (wc: Electron.WebContents | null, url: string | undefined) => boolean,
): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!isAppPage(wc, details.requestingUrl) || permission !== "media") {
      callback(false);
      return;
    }
    // getUserMedia lists what it wants; display capture may send no types (handled elsewhere).
    const types = ((details as { mediaTypes?: unknown[] }).mediaTypes ?? []) as unknown[];
    if (!types.every(isMediaKind)) {
      callback(false);
      return;
    }
    void osAllows(types as MediaKind[]).then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (!isAppPage(wc, details.requestingUrl)) return false;
    const p = permission as string;
    if (p === "speaker-selection") return true;
    if (p !== "media") return false;
    const t = (details as { mediaType?: string }).mediaType;
    // "unknown" is used by enumerateDevices-style checks (device labels).
    return t === undefined || t === "audio" || t === "video" || t === "unknown";
  });
}
