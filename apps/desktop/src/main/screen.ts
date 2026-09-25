/**
 * Screen share capture ("Go Live").
 *
 * The renderer shows its own Discord-style picker (screen:getSources), arms a
 * selection (screen:select) and then calls the standard getDisplayMedia(). Our
 * setDisplayMediaRequestHandler answers that call with the armed source.
 *
 * System audio:
 *  - Windows / macOS: we grant "loopback" and the renderer asks for
 *    `audio: { restrictOwnAudio: true }`. Since Electron 43.4 / 44.0
 *    (electron/electron#52455) Chromium then captures "loopbackWithoutChrome":
 *    all system audio EXCEPT this app's own process tree, so friends don't hear
 *    their own voices echoed back. Windows needs the process-loopback API
 *    (Win10 22H2 / build 19045+ in practice); the renderer verifies per track
 *    via `getSettings().restrictOwnAudio` and warns if it didn't take effect.
 *  - Windows 11: "app" mode captures only the shared window's process tree via
 *    Chromium's "applicationLoopback:<pid>" device (the pid comes from the HWND
 *    in the source id, resolved with GetWindowThreadProcessId through koffi).
 *  - Linux/Wayland: desktopCapturer can't enumerate; the xdg-desktop-portal
 *    picker chooses (see PORTAL_SOURCE). Needs the WebRTCPipeWireCapturer feature.
 *  - Linux: plain "loopback" (PulseAudio/PipeWire monitor). No exclusion is
 *    possible, so the UI warns that friends will hear themselves.
 */
import { BrowserWindow, desktopCapturer, session, systemPreferences, type DesktopCapturerSource } from "electron";
import { createRequire } from "node:module";
import { release } from "node:os";
import { platformCaps, windowsBuild, type PlatformCaps } from "../shared/platform";
import type { ScreenAudioMode, ScreenAudioSupport, ScreenSelectRequest, ScreenSelectResult, ScreenSource } from "../shared/ipc";

const nodeRequire = createRequire(import.meta.url);

/** How long an armed selection waits for its getDisplayMedia() call. */
const SELECTION_TTL_MS = 15_000;

interface PendingSelection {
  sourceId: string;
  name: string;
  /** Audio device id to grant ("loopback" / "applicationLoopback:<pid>"), or null for none. */
  audioDevice: string | null;
  expiresAt: number;
}

let pending: PendingSelection | null = null;
let lastSources = new Map<string, string>(); // id -> name
let inflight: Promise<ScreenSource[]> | null = null;

// ---------------------------------------------------------------------------
// Platform support
// ---------------------------------------------------------------------------

type GetPidFn = (hwnd: number) => number | null;
let getPidFn: GetPidFn | null | undefined;

/** HWND -> owning process id (Windows only, via koffi FFI). */
function pidResolver(): GetPidFn | null {
  if (getPidFn !== undefined) return getPidFn;
  getPidFn = null;
  if (process.platform !== "win32") return null;
  try {
    const koffi = nodeRequire("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    const fn = user32.func("uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)");
    getPidFn = (hwnd: number) => {
      const out = [0];
      const tid = fn(hwnd, out) as number;
      return tid && out[0] ? out[0] : null;
    };
  } catch (err) {
    console.warn("[screen] koffi unavailable, app-only audio disabled:", err instanceof Error ? err.message : err);
  }
  return getPidFn;
}

let capsCache: PlatformCaps | null = null;

/** Capabilities of this machine (computed once). */
export function getPlatformCaps(): PlatformCaps {
  capsCache ??= platformCaps(process.platform, process.env, release(), {
    // Only probe koffi where it matters (Windows 11); never load it elsewhere.
    pidResolver: process.platform === "win32" && windowsBuild(release()) >= 22000 ? !!pidResolver() : false,
  });
  return capsCache;
}

export function getAudioSupport(): ScreenAudioSupport {
  const c = getPlatformCaps();
  return { system: c.systemAudio, excludesOwnAudio: c.excludeOwnAudio, appAudio: c.appAudio, note: c.audioNote };
}

/** macOS Screen Recording (TCC) status; "granted" elsewhere. */
export function screenPermission(): string {
  if (process.platform !== "darwin") return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function ownMediaSourceIds(): Set<string> {
  const ids = new Set<string>();
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      ids.add(w.getMediaSourceId());
    } catch {
      /* destroyed */
    }
  }
  return ids;
}

function toSource(src: DesktopCapturerSource): ScreenSource {
  const kind = src.id.startsWith("screen:") ? "screen" : "window";
  const thumb = src.thumbnail && !src.thumbnail.isEmpty() ? `data:image/jpeg;base64,${src.thumbnail.toJPEG(72).toString("base64")}` : "";
  let appIcon: string | null = null;
  if (src.appIcon && !src.appIcon.isEmpty()) {
    appIcon = src.appIcon.resize({ width: 32, height: 32, quality: "best" }).toDataURL();
  }
  return { id: src.id, name: src.name, kind, thumbnail: thumb, appIcon, displayId: src.display_id ?? "" };
}

export function getSources(): Promise<ScreenSource[]> {
  // Wayland: every getSources() call pops the xdg-desktop-portal dialog, so the
  // renderer skips the grid and the portal picks at getDisplayMedia time.
  if (getPlatformCaps().sourcePicker === "system") return Promise.resolve([]);
  // Refreshes are polled; share one capture pass between overlapping calls.
  if (inflight) return inflight;
  inflight = desktopCapturer
    .getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
    .then((sources) => {
      const own = ownMediaSourceIds();
      const list = sources.filter((s) => !own.has(s.id) && s.name.trim() !== "").map(toSource);
      lastSources = new Map(list.map((s) => [s.id, s.name]));
      return list;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------------------------------------------------------------------------
// Selection + getDisplayMedia handler
// ---------------------------------------------------------------------------

/** Pseudo source id: "let the OS portal choose" (Wayland). */
const PORTAL_SOURCE = "portal";
const SOURCE_ID_RE = /^(screen|window):[-\d]+:[-\d]+$/;

export function selectSource(raw: unknown): ScreenSelectResult {
  const req = raw as Partial<ScreenSelectRequest> | null;
  pending = null;
  const portal = req?.sourceId === PORTAL_SOURCE && getPlatformCaps().sourcePicker === "system";
  if (!req || typeof req.sourceId !== "string" || (!portal && !SOURCE_ID_RE.test(req.sourceId))) {
    return { ok: false, audio: "none", reason: "invalid source" };
  }
  const wanted: ScreenAudioMode = req.audio === "system" || req.audio === "app" ? req.audio : "none";
  const support = getAudioSupport();
  let audio: ScreenAudioMode = "none";
  let audioDevice: string | null = null;
  let reason: string | undefined;

  if (wanted === "app") {
    const m = /^window:(\d+):/.exec(req.sourceId);
    const pid = m && support.appAudio ? pidResolver()?.(Number(m[1])) ?? null : null;
    if (pid && pid !== process.pid) {
      audio = "app";
      audioDevice = `applicationLoopback:${pid}`;
    } else {
      reason = "Couldn't isolate that window's audio; sharing system audio instead.";
    }
  }
  if (wanted !== "none" && !audioDevice && support.system) {
    audio = "system";
    audioDevice = "loopback";
  }

  pending = {
    sourceId: req.sourceId,
    name: lastSources.get(req.sourceId) ?? (req.sourceId.startsWith("screen:") ? "Screen" : "Window"),
    audioDevice,
    expiresAt: Date.now() + SELECTION_TTL_MS,
  };
  return { ok: true, audio, reason };
}

/**
 * Install the getDisplayMedia handler. `isTrustedFrame` limits capture to our
 * own main window's main frame.
 */
export function setupDisplayMediaHandler(isTrustedFrame: (frame: Electron.WebFrameMain | null) => boolean): void {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const sel = pending;
    pending = null; // single use
    if (!sel || sel.expiresAt < Date.now() || !request.videoRequested || !isTrustedFrame(request.frame)) {
      // Rejects getDisplayMedia() with an AbortError.
      callback(null as unknown as Parameters<typeof callback>[0]);
      return;
    }
    if (sel.sourceId === PORTAL_SOURCE) {
      // Wayland/PipeWire: this getSources() call shows the portal dialog and
      // resolves with the single source the user picked (empty if cancelled).
      desktopCapturer
        .getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
        .then((list) => {
          const src = list[0];
          if (!src) {
            callback(null as unknown as Parameters<typeof callback>[0]);
            return;
          }
          grant(callback, request.audioRequested, { ...sel, sourceId: src.id, name: src.name || "Screen" });
        })
        .catch((err: unknown) => {
          console.warn("[screen] portal capture failed:", err);
          callback(null as unknown as Parameters<typeof callback>[0]);
        });
      return;
    }
    grant(callback, request.audioRequested, sel);
  });
}

type GrantCallback = (streams: Electron.Streams) => void;

function grant(callback: GrantCallback, audioRequested: boolean, sel: PendingSelection): void {
  {
    const streams: Parameters<GrantCallback>[0] = { video: { id: sel.sourceId, name: sel.name } };
    if (audioRequested && sel.audioDevice) {
      // "loopback" is upgraded to "loopbackWithoutChrome" by Electron when the
      // renderer requested restrictOwnAudio (Windows/macOS). The typings only
      // list "loopback" | "loopbackWithMute", but any Chromium loopback device
      // id is passed through (used for "applicationLoopback:<pid>").
      streams.audio = sel.audioDevice as "loopback";
    }
    callback(streams);
  }
}
