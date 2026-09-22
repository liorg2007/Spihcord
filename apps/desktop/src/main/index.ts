import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, Tray, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import { clearSession, loadSession, saveSession } from "./session";
import {
  cancelPttRecord,
  isGlobalPttAvailable,
  recordPttBinding,
  setPttBinding,
  setPttStateListener,
  shutdownPtt,
} from "./ptt";
import { getAudioSupport, getSources, selectSource, setupDisplayMediaHandler } from "./screen";

const BG = "#1e1f22";
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  void app.whenReady().then(onReady);
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A blurple circle icon drawn in code (no asset files), BGRA bitmap. */
function makeIcon(size: number): Electron.NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const rOuter = size / 2 - 0.5;
  const rInner = size * 0.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const outerA = Math.max(0, Math.min(1, rOuter - d + 0.5));
      const innerA = Math.max(0, Math.min(1, rInner - d + 0.5));
      // blurple #5865f2 blended with white centre dot
      const r = 0x58 + (0xff - 0x58) * innerA;
      const g = 0x65 + (0xff - 0x65) * innerA;
      const b = 0xf2 + (0xff - 0xf2) * innerA;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(b * outerA);
      buf[i + 1] = Math.round(g * outerA);
      buf[i + 2] = Math.round(r * outerA);
      buf[i + 3] = Math.round(255 * outerA);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    title: "Shpihcord",
    backgroundColor: BG,
    autoHideMenuBar: true,
    icon: makeIcon(64),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // Remote audio must play without a gesture (e.g. rejoin after reconnect),
      // and the engine's VAD timers must keep running while minimized.
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const wc = mainWindow.webContents;
  // Never open new Electron windows; send web links to the system browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    if (url !== wc.getURL()) {
      event.preventDefault();
      if (isHttpUrl(url)) void shell.openExternal(url);
    }
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function createTray(): void {
  try {
    tray = new Tray(makeIcon(process.platform === "win32" ? 16 : 22));
    tray.setToolTip("Shpihcord");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show Shpihcord", click: () => showWindow() },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
    tray.on("click", () => showWindow());
  } catch (err) {
    console.warn("[tray] unavailable:", err);
  }
}

function setupPermissions(): void {
  const ses = session.defaultSession;
  // Microphone (and later camera) only; deny everything else. Screen capture
  // ("Go Live") also asks for "media" and is gated by the display-media handler.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    const p = permission as string;
    return p === "media" || p === "speaker-selection";
  });
}

/** Only accept IPC from our own window's main frame. */
function trusted(event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return !!mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
}

function setupIpc(): void {
  ipcMain.handle(IPC.version, (e) => (trusted(e) ? app.getVersion() : ""));
  ipcMain.handle(IPC.sessionLoad, (e) => (trusted(e) ? loadSession() : null));
  ipcMain.handle(IPC.sessionSave, (e, s: unknown) => (trusted(e) ? saveSession(s) : false));
  ipcMain.handle(IPC.sessionClear, (e) => (trusted(e) ? clearSession() : undefined));

  ipcMain.handle(IPC.pttAvailable, (e) => trusted(e) && isGlobalPttAvailable());
  ipcMain.handle(IPC.pttSetBinding, (e, binding: unknown) => {
    if (!trusted(e)) return { global: false, reason: "untrusted" };
    if (binding === null) return setPttBinding(null);
    const b = binding as { code?: unknown; label?: unknown };
    if (typeof b.code !== "string" || typeof b.label !== "string") return { global: false, reason: "invalid binding" };
    return setPttBinding({ code: b.code, label: b.label });
  });
  ipcMain.handle(IPC.pttRecord, (e, timeoutMs: unknown) =>
    trusted(e) ? recordPttBinding(typeof timeoutMs === "number" ? timeoutMs : undefined) : null,
  );
  ipcMain.on(IPC.pttCancelRecord, (e) => {
    if (trusted(e)) cancelPttRecord();
  });

  ipcMain.handle(IPC.screenGetSources, (e) => (trusted(e) ? getSources() : []));
  ipcMain.handle(IPC.screenAudioSupport, (e) =>
    trusted(e) ? getAudioSupport() : { system: false, excludesOwnAudio: false, appAudio: false },
  );
  ipcMain.handle(IPC.screenSelect, (e, req: unknown) =>
    trusted(e) ? selectSource(req) : { ok: false, audio: "none", reason: "untrusted" },
  );
  setupDisplayMediaHandler(
    (frame) => !!frame && !!mainWindow && !mainWindow.isDestroyed() && frame === mainWindow.webContents.mainFrame,
  );

  setPttStateListener((pressed) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.pttState, pressed);
  });
}

function onReady(): void {
  if (process.platform === "win32") app.setAppUserModelId("app.shpihcord.desktop");
  Menu.setApplicationMenu(null);
  setupPermissions();
  setupIpc();
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// Deny any attempt to create webviews / extra windows from any webContents.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
});

app.on("before-quit", () => shutdownPtt());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
