import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, Tray, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import { setupPermissions } from "./permissions";
import { setupAutoUpdater } from "./updater";
import { applyEarlySwitches, setupAppMenu, setupPlatformIpc, trayImage } from "./platformSetup";
import { getAudioSupport, getSources, selectSource, setupDisplayMediaHandler } from "./screen";
import { webrtcPolicyForHub } from "./webrtcPolicy";
import { runSelfTestIfRequested } from "./selfTest";

const BG = "#1e1f22";
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** macOS: closing the window only hides it (app keeps running in the dock) until a real quit. */
let quitting = false;

applyEarlySwitches();

if (runSelfTestIfRequested()) {
  // Headless smoke test (see selfTest.ts): no window, no single-instance lock.
} else if (!app.requestSingleInstanceLock()) {
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

const RENDERER_FILE_URL = pathToFileURL(join(__dirname, "../renderer/index.html")).href;
const DEV_URL = !app.isPackaged ? process.env["ELECTRON_RENDERER_URL"] : undefined;

/** True for our own bundled renderer page (or the dev server in development). */
function isAppUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (DEV_URL) return u.origin === new URL(DEV_URL).origin;
    u.hash = "";
    u.search = "";
    return u.href === RENDERER_FILE_URL;
  } catch {
    return false;
  }
}

/** Permission scoping: only our main window, only while it shows our page. */
function isAppPage(wc: Electron.WebContents | null, url: string | undefined): boolean {
  return !!wc && !!mainWindow && wc === mainWindow.webContents && isAppUrl(url ?? wc.getURL());
}

/** The logo bubble at `size` px, from the PNGs `npm run icons` writes to resources/. */
function makeIcon(size: number): Electron.NativeImage {
  const dir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
  const file = size <= 16 ? "tray-16.png" : size <= 22 ? "tray-22.png" : "icon.png";
  const img = nativeImage.createFromPath(join(dir, file));
  return img.isEmpty() ? img : img.resize({ width: size, height: size, quality: "best" });
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
      // No DevTools in packaged builds (the macOS View menu omits it too).
      devTools: !app.isPackaged,
    },
  });
  // Security T2: never expose LAN / VPN / Tailscale / extra-interface addresses
  // in ICE until we know the hub is on a private network (net:set-hub).
  mainWindow.webContents.setWebRTCIPHandlingPolicy(webrtcPolicyForHub(null));

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // backgroundThrottling=false keeps document.visibilityState "visible" while
  // minimized, so tell the renderer (it pauses incoming camera video meanwhile).
  const win = mainWindow;
  const sendVisibility = () => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC.windowVisibility, win.isVisible() && !win.isMinimized());
  };
  win.on("minimize", sendVisibility);
  win.on("restore", sendVisibility);
  win.on("hide", sendVisibility);
  win.on("show", sendVisibility);
  // A push-to-talk recording must never outlive focus (security C3).
  win.on("blur", () => cancelPttRecord());
  win.on("close", (event) => {
    if (process.platform === "darwin" && !quitting) {
      event.preventDefault();
      win.hide();
    }
  });
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

  if (DEV_URL) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function createTray(): void {
  try {
    // Linux without an AppIndicator/StatusNotifier host throws or shows nothing;
    // the app still works (window-all-closed quits there).
    tray = new Tray(trayImage(makeIcon));
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
  ipcMain.handle(IPC.pttRecord, (e, timeoutMs: unknown) => {
    // Only while our window is focused (blur cancels, see createWindow).
    if (!trusted(e) || !mainWindow?.isFocused()) return null;
    return recordPttBinding(typeof timeoutMs === "number" ? timeoutMs : undefined);
  });
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

  setupPlatformIpc(trusted);

  ipcMain.handle(IPC.netSetHub, (e, serverUrl: unknown) => {
    if (!trusted(e) || !mainWindow) return;
    mainWindow.webContents.setWebRTCIPHandlingPolicy(webrtcPolicyForHub(typeof serverUrl === "string" ? serverUrl : null));
  });

  setPttStateListener((pressed) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.pttState, pressed);
  });
}

function onReady(): void {
  if (process.platform === "win32") app.setAppUserModelId("app.shpihcord.desktop");
  setupAppMenu();
  setupPermissions(session.defaultSession, isAppPage);
  setupIpc();
  createWindow();
  createTray();
  setupAutoUpdater(() => mainWindow);

  app.on("activate", () => {
    showWindow(); // dock icon click

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

app.on("before-quit", () => {
  quitting = true;
  shutdownPtt();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
