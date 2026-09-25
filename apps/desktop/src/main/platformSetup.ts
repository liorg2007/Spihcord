/**
 * Per-OS glue kept out of index.ts: early Chromium switches (Linux Wayland),
 * the application menu (macOS needs one for Cmd+C/V in inputs), the tray
 * image, and the platform IPC (caps, macOS permission panes).
 */
import { app, ipcMain, Menu, nativeImage, shell, type IpcMainInvokeEvent, type NativeImage } from "electron";
import { IPC } from "../shared/ipc";
import { MAC_SETTINGS_PANES, mergeFeatures, type MacSettingsPane } from "../shared/platform";
import { accessibilityStatus } from "./ptt";
import { getPlatformCaps, screenPermission } from "./screen";

/** Must run before app "ready". */
export function applyEarlySwitches(): void {
  if (process.platform !== "linux") return;
  // PipeWire capture (xdg-desktop-portal) is required for screen share on Wayland;
  // harmless on X11. Merge with any --enable-features given on the command line.
  const existing = app.commandLine.getSwitchValue("enable-features");
  app.commandLine.appendSwitch("enable-features", mergeFeatures(existing, ["WebRTCPipeWireCapturer"]));
  // Run natively on Wayland when available (falls back to X11/XWayland), unless
  // the user chose explicitly.
  if (!app.commandLine.hasSwitch("ozone-platform-hint") && !app.commandLine.hasSwitch("ozone-platform")) {
    app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  }
}

/**
 * macOS gets a standard menu (app/Edit/View/Window) so Cmd+C/V/X/A/Z, Cmd+Q,
 * Cmd+W and Cmd+M work. Windows/Linux keep no menu bar.
 */
export function setupAppMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

/** A monochrome template image for the macOS menu bar (black + alpha; macOS tints it). */
function macTemplateIcon(): NativeImage {
  const make = (size: number): Buffer => {
    const buf = Buffer.alloc(size * size * 4);
    const c = (size - 1) / 2;
    const rOuter = size * 0.42;
    const rInner = size * 0.17;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - c, y - c);
        const outer = Math.max(0, Math.min(1, rOuter - d + 0.5));
        const hole = Math.max(0, Math.min(1, rInner - d + 0.5));
        const a = outer * (1 - hole); // ring
        const i = (y * size + x) * 4;
        buf[i + 3] = Math.round(255 * a); // BGR stay 0 (black)
      }
    }
    return buf;
  };
  const img = nativeImage.createFromBitmap(make(16), { width: 16, height: 16, scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: make(32) });
  img.setTemplateImage(true);
  return img;
}

export function trayImage(makeIcon: (size: number) => NativeImage): NativeImage {
  if (process.platform === "darwin") return macTemplateIcon();
  return makeIcon(process.platform === "win32" ? 16 : 22);
}

export function setupPlatformIpc(trusted: (e: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle(IPC.caps, (e) => (trusted(e) ? getPlatformCaps() : null));
  ipcMain.handle(IPC.screenPermission, (e) => (trusted(e) ? screenPermission() : "denied"));
  ipcMain.handle(IPC.pttAccessibility, (e, prompt: unknown) =>
    trusted(e) ? accessibilityStatus(prompt === true) : "denied",
  );
  ipcMain.handle(IPC.openSystemSettings, async (e, pane: unknown) => {
    if (!trusted(e) || process.platform !== "darwin") return;
    if (typeof pane !== "string" || !Object.hasOwn(MAC_SETTINGS_PANES, pane)) return;
    await shell.openExternal(MAC_SETTINGS_PANES[pane as MacSettingsPane]);
  });
}
