/**
 * Pure platform-capability decisions (no Electron / DOM imports), shared by the
 * main process (which computes them from the real platform, env and OS
 * release) and the renderer (which drives its UI copy from the result).
 */

export type SourcePicker = "custom" | "system";

export interface PlatformCaps {
  platform: string;
  /** Linux session is Wayland (desktopCapturer thumbnails / global hooks don't work). */
  wayland: boolean;
  /** Stream audio ("what you hear") can be captured. */
  systemAudio: boolean;
  /** Our own playback is kept out of system audio (restrictOwnAudio / loopbackWithoutChrome). */
  excludeOwnAudio: boolean;
  /** Per-application audio ("applicationLoopback:<pid>"), Windows 11 only. */
  appAudio: boolean;
  /** A system-wide PTT hook can work here (may still need a permission, see needsAccessibility). */
  globalPtt: boolean;
  /** macOS: the global hook needs the Accessibility permission. */
  needsAccessibility: boolean;
  /** macOS: screen capture needs the Screen Recording permission. */
  needsScreenPermission: boolean;
  /** "custom": our thumbnail grid; "system": the OS portal chooses (Wayland). */
  sourcePicker: SourcePicker;
  /** Label of the primary shortcut modifier ("Cmd" on macOS, "Ctrl" elsewhere). */
  modKey: string;
  /** Short note shown next to the audio toggle when something is limited. */
  audioNote?: string;
}

export function isWaylandSession(env: Record<string, string | undefined>): boolean {
  const t = (env["XDG_SESSION_TYPE"] ?? "").toLowerCase();
  if (t === "wayland") return true;
  if (t === "x11") return false;
  return !!env["WAYLAND_DISPLAY"];
}

/** Windows build number from os.release() ("10.0.22631" -> 22631). */
export function windowsBuild(osRelease: string): number {
  return Number(osRelease.split(".")[2] ?? 0) || 0;
}

/** Darwin kernel major from os.release() ("22.1.0" -> 22 = macOS 13). */
export function darwinMajor(osRelease: string): number {
  return Number(osRelease.split(".")[0]) || 0;
}

export function platformCaps(
  platform: string,
  env: Record<string, string | undefined>,
  osRelease: string,
  opts: { pidResolver?: boolean } = {},
): PlatformCaps {
  const base = {
    platform,
    wayland: false,
    needsAccessibility: false,
    needsScreenPermission: false,
    sourcePicker: "custom" as SourcePicker,
    modKey: "Ctrl",
  };
  switch (platform) {
    case "win32": {
      const build = windowsBuild(osRelease);
      const excludes = build >= 19045;
      return {
        ...base,
        systemAudio: true,
        excludeOwnAudio: excludes,
        appAudio: build >= 22000 && opts.pidResolver !== false,
        globalPtt: true,
        audioNote: excludes
          ? undefined
          : "This Windows version can't keep Shpihcord's own audio out of the stream, so friends may hear themselves. Update Windows (10 22H2 or 11), or turn off stream audio.",
      };
    }
    case "darwin": {
      // Darwin 22 = macOS 13: ScreenCaptureKit system audio (+ own-audio exclusion).
      const ok = darwinMajor(osRelease) >= 22;
      return {
        ...base,
        modKey: "Cmd",
        needsAccessibility: true,
        needsScreenPermission: true,
        systemAudio: ok,
        excludeOwnAudio: ok,
        appAudio: false,
        globalPtt: true,
        audioNote: ok
          ? "macOS will ask for Screen & System Audio Recording permission the first time."
          : "Sharing system audio needs macOS 13 or later.",
      };
    }
    case "linux": {
      const wayland = isWaylandSession(env);
      return {
        ...base,
        wayland,
        sourcePicker: wayland ? "system" : "custom",
        systemAudio: true,
        // Electron's restrictOwnAudio (loopbackWithoutChrome) is Windows/macOS only.
        excludeOwnAudio: false,
        appAudio: false,
        // Wayland doesn't let apps observe global input; X11 works via uiohook (libXtst).
        globalPtt: !wayland,
        audioNote:
          "On Linux, stream audio includes everything you hear, including voice chat, so friends will hear themselves (headphones don't help). Turn off stream audio if that's a problem.",
      };
    }
    default:
      return { ...base, systemAudio: false, excludeOwnAudio: false, appAudio: false, globalPtt: false };
  }
}

/** Merge feature names into an existing comma-separated --enable-features value. */
export function mergeFeatures(existing: string | undefined, add: string[]): string {
  const set = (existing ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const f of add) if (!set.includes(f)) set.push(f);
  return set.join(",");
}

/** Only these System Settings panes may be opened from the renderer. */
export const MAC_SETTINGS_PANES = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
} as const;
export type MacSettingsPane = keyof typeof MAC_SETTINGS_PANES;

/** Human label for a modifier DOM code on this platform. */
export function modifierLabel(code: string, platform: string): string | null {
  const mac = platform === "darwin";
  const base = code.replace(/(Left|Right)$/, "");
  const right = code.endsWith("Right") ? " (R)" : "";
  switch (base) {
    case "Control": return `Ctrl${right}`;
    case "Alt": return `${mac ? "Option" : "Alt"}${right}`;
    case "Meta": return `${mac ? "Cmd" : platform === "win32" ? "Win" : "Super"}${right}`;
    case "Shift": return `Shift${right}`;
    default: return null;
  }
}
