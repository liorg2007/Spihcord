/**
 * `Shpihcord --self-test`: headless smoke test for packaged builds (CI and
 * release checks). Loads the native addons exactly like the app does (from
 * app.asar.unpacked), prints one JSON line to stdout and exits; no window, no
 * network, the uiohook hook is never started. Exit code 0 = all OK.
 */
import { app } from "electron";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

function tryLoad(name: string, probe: (m: unknown) => unknown): { ok: boolean; detail: string } {
  try {
    const m = nodeRequire(name);
    return { ok: true, detail: String(probe(m)) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function runSelfTestIfRequested(): boolean {
  if (!process.argv.includes("--self-test")) return false;
  void app.whenReady().then(() => {
    const result = {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: `${process.platform}-${process.arch}`,
      electron: process.versions.electron,
      uiohook: tryLoad("uiohook-napi", (m) => typeof (m as { uIOhook?: { start?: unknown } }).uIOhook?.start === "function"),
      koffi: tryLoad("koffi", (m) => (m as { version?: string }).version ?? typeof m),
    };
    process.stdout.write(`SHPIHCORD_SELF_TEST ${JSON.stringify(result)}\n`);
    app.exit(result.uiohook.ok && result.koffi.ok ? 0 : 1);
  });
  return true;
}
