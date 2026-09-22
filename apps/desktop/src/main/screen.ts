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
 *  - Linux: plain "loopback" (PulseAudio/PipeWire monitor). No exclusion is
 *    possible, so the UI warns that friends will hear themselves.
 */
import { BrowserWindow, desktopCapturer, session, type DesktopCapturerSource } from "electron";
import { createRequire } from "node:module";
import { release } from "node:os";
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

function windowsBuild(): number {
  const parts = release().split(".");
  return Number(parts[2] ?? 0) || 0;
}

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

let supportCache: ScreenAudioSupport | null = null;

export function getAudioSupport(): ScreenAudioSupport {
  if (supportCache) return supportCache;
  let s: ScreenAudioSupport;
  switch (process.platform) {
    case "win32": {
      const build = windowsBuild();
      const excludes = build >= 19045;
      s = {
        system: true,
        excludesOwnAudio: excludes,
        // Chromium only enables per-application loopback on Windows 11.
        appAudio: build >= 22000 && !!pidResolver(),
        note: excludes
          ? undefined
          : "This Windows version can't keep Shpihcord's own audio out of the stream, so friends may hear themselves. Update Windows (10 22H2 or 11), or turn off stream audio.",
      };
      break;
    }
    case "darwin": {
      // Darwin 22 = macOS 13, where ScreenCaptureKit system audio starts.
      const darwinMajor = Number(release().split(".")[0]) || 0;
      const ok = darwinMajor >= 22;
      s = {
        system: ok,
        excludesOwnAudio: ok,
        appAudio: false,
        note: ok
          ? "macOS will ask for Screen & System Audio Recording permission the first time."
          : "Sharing system audio needs macOS 13 or later.",
      };
      break;
    }
    default:
      s = {
        system: true,
        excludesOwnAudio: false,
        appAudio: false,
        note: "On Linux, stream audio includes everything you hear, including voice chat, so friends will hear themselves (headphones don't help). Turn off stream audio if that's a problem.",
      };
  }
  supportCache = s;
  return s;
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

const SOURCE_ID_RE = /^(screen|window):[-\d]+:[-\d]+$/;

export function selectSource(raw: unknown): ScreenSelectResult {
  const req = raw as Partial<ScreenSelectRequest> | null;
  pending = null;
  if (!req || typeof req.sourceId !== "string" || !SOURCE_ID_RE.test(req.sourceId)) {
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
    const streams: Parameters<typeof callback>[0] = { video: { id: sel.sourceId, name: sel.name } };
    if (request.audioRequested && sel.audioDevice) {
      // "loopback" is upgraded to "loopbackWithoutChrome" by Electron when the
      // renderer requested restrictOwnAudio (Windows/macOS). The typings only
      // list "loopback" | "loopbackWithMute", but any Chromium loopback device
      // id is passed through (used for "applicationLoopback:<pid>").
      streams.audio = sel.audioDevice as "loopback";
    }
    callback(streams);
  });
}
