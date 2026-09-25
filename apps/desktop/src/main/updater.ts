/**
 * Auto-update via electron-updater + GitHub Releases (see electron-builder.yml `publish`).
 *
 * - Checks on startup and every 6 hours, downloads in the background, then
 *   pushes { state: "ready" } to the renderer (IPC.updateStatus) so it can show
 *   "Update ready - restart"; the renderer calls updates.install() to apply.
 *   If the user never clicks, the update is installed on the next quit.
 * - Disabled when not packaged (dev) or with SHPIHCORD_DISABLE_UPDATES=1.
 * - Every downloaded update must match an Ed25519-signed manifest before it
 *   can be installed (updateSignature.ts); otherwise it's never installed.
 * - Unsigned macOS builds can't be updated by Squirrel.Mac, so there we only
 *   report { state: "available-manual", url } pointing at the release page.
 */
import { app, BrowserWindow, ipcMain, net, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import electronUpdater from "electron-updater";
import { IPC, type UpdateStatus } from "../shared/ipc";
import { UPDATE_PUBLIC_KEY_PEM } from "./updatePublicKey";
import { manifestCovers, manifestName, sha512File, verifyManifestSignature } from "./updateSignature";

const { autoUpdater } = electronUpdater;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RELEASES_URL = "https://github.com/liorg2007/Spihcord/releases";

let status: UpdateStatus | null = null;
/** Version whose downloaded file passed the signed-manifest check (security C2). */
let verifiedVersion: string | null = null;

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await net.fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 1024 * 1024) throw new Error(`${url} is unexpectedly large`);
  return buf;
}

/**
 * Check a downloaded update against the Ed25519-signed manifest of its
 * release. Resolves true only if the signature is valid for the embedded key
 * and the signed manifest names this version and the downloaded file's sha512.
 */
async function verifyDownloadedUpdate(version: string, downloadedFile: string): Promise<boolean> {
  const name = manifestName(process.platform, process.arch);
  const base = `${RELEASES_URL}/download/v${encodeURIComponent(version)}`;
  try {
    const [manifest, sig, actual] = await Promise.all([
      fetchBytes(`${base}/${name}`),
      fetchBytes(`${base}/${name}.sig`),
      sha512File(downloadedFile),
    ]);
    if (!verifyManifestSignature(manifest, sig.toString("utf8"), UPDATE_PUBLIC_KEY_PEM)) {
      console.error(`[updater] ${name} signature is INVALID for v${version}; refusing to install`);
      return false;
    }
    if (!manifestCovers(manifest.toString("utf8"), version, actual)) {
      console.error(`[updater] downloaded file doesn't match the signed ${name} for v${version}; refusing to install`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[updater] couldn't verify the update signature; refusing to install:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** True if the running .app has a real (Developer ID) signature, not ad-hoc/none. */
function isMacSigned(): Promise<boolean> {
  // process.execPath = Shpihcord.app/Contents/MacOS/Shpihcord
  const appPath = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, "");
  return new Promise((resolve) => {
    execFile("codesign", ["-dv", "--verbose=2", appPath], (err, _stdout, stderr) => {
      if (err) return resolve(false);
      const team = /TeamIdentifier=(.+)/.exec(stderr)?.[1]?.trim();
      resolve(!!team && team !== "not set");
    });
  });
}

export function setupAutoUpdater(getWindow: () => BrowserWindow | null): void {
  const fromOurWindow = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const win = getWindow();
    return !!win && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame;
  };
  const publish = (next: UpdateStatus): void => {
    status = next;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.updateStatus, next);
  };

  ipcMain.handle(IPC.updateGetStatus, (e) => (fromOurWindow(e) ? status : null));
  ipcMain.on(IPC.updateInstall, (e) => {
    if (fromOurWindow(e) && status?.state === "ready" && verifiedVersion === status.version) {
      // isSilent=true (Windows: no installer UI), isForceRunAfter=true (relaunch).
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    }
  });

  if (!app.isPackaged || process.env["SHPIHCORD_DISABLE_UPDATES"] === "1") return;
  // Linux: only the AppImage (and .deb via electron-updater's DebUpdater) can self-update.
  if (process.platform === "linux" && !process.env["APPIMAGE"] && !isDebInstall()) return;

  void (async () => {
    const manualOnly = process.platform === "darwin" && !(await isMacSigned());

    autoUpdater.autoDownload = !manualOnly;
    // Only after the signed-manifest check passes (see update-downloaded).
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = console;

    autoUpdater.on("update-available", (info) => {
      if (manualOnly) {
        publish({ state: "available-manual", version: info.version, url: `${RELEASES_URL}/tag/v${info.version}` });
      }
    });
    autoUpdater.on("download-progress", (p) => {
      const version = status && "version" in status ? status.version : "";
      publish({ state: "downloading", version, percent: Math.round(p.percent) });
    });
    autoUpdater.on("update-downloaded", (event) => {
      void verifyDownloadedUpdate(event.version, event.downloadedFile).then((ok) => {
        if (!ok) {
          verifiedVersion = null;
          autoUpdater.autoInstallOnAppQuit = false;
          status = null;
          return;
        }
        verifiedVersion = event.version;
        autoUpdater.autoInstallOnAppQuit = true;
        publish({ state: "ready", version: event.version });
      });
    });
    autoUpdater.on("error", (err) => console.warn("[updater]", err?.message ?? err));

    const check = (): void => {
      // Don't re-download once an update is waiting to be installed.
      if (status?.state === "ready") return;
      autoUpdater.checkForUpdates().catch((err: unknown) => console.warn("[updater] check failed:", err));
    };
    check();
    setInterval(check, CHECK_INTERVAL_MS).unref();
  })();
}

function isDebInstall(): boolean {
  // electron-builder's deb installs to /opt/<productName>.
  return process.execPath.startsWith("/opt/");
}
