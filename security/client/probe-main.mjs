// Runtime hardening probe. Boots the REAL built main (apps/desktop/out/main/index.js)
// with windows forced hidden, then attacks it from the renderer as a compromised
// renderer would, and prints JSON results. Self-terminates after ~20s.
// Run (Windows): cd apps\desktop && npx electron ..\..\security\client\probe-main.mjs
import electron from "electron";
const { app, BrowserWindow, shell, ipcMain } = electron;
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.SHPIHCORD_DISABLE_UPDATES = "1";
const here = dirname(fileURLToPath(import.meta.url));
const results = { opened: [], switches: {} };
const killer = setTimeout(() => { console.log("PROBE_TIMEOUT"); app.exit(2); }, 25000);

// Keep everything hidden and record external opens instead of launching them.
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
shell.openExternal = async (url) => { results.opened.push(url); };

app.on("browser-window-created", (_e, win) => {
  const wc = win.webContents;
  wc.once("did-finish-load", async () => {
    try {
      results.webPreferences = wc.getLastWebPreferences?.() ?? null;
      results.devtoolsOpenable = typeof wc.openDevTools === "function";
      results.renderer = await wc.executeJavaScript(`(async () => {
        const r = {};
        r.require = typeof require; r.process = typeof process; r.module = typeof module;
        r.bridgeKeys = window.shpihcord ? Object.keys(window.shpihcord) : null;
        r.csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null;
        r.localStorageKeys = Object.keys(localStorage);
        try { eval("1"); r.eval = "allowed"; } catch (e) { r.eval = "blocked"; }
        r.inlineScript = await new Promise(res => { window.__x = 0; const s = document.createElement("script"); s.textContent = "window.__x=1"; document.head.appendChild(s); setTimeout(() => res(window.__x ? "ran" : "blocked"), 50); });
        for (const u of ["file:///C:/Windows/System32/calc.exe", "smb://evil.example/share", "ms-settings:", "javascript:alert(1)", "https://example.com/ok"]) { try { window.open(u); } catch {} }
        try { const ok = await window.shpihcord.screen.select({ sourceId: "window:999999999999:0", audio: "app" }); r.selectBogus = ok; } catch (e) { r.selectBogus = String(e); }
        try { r.selectJunk = await window.shpihcord.screen.select({ sourceId: "../../x", audio: "app" }); } catch (e) { r.selectJunk = String(e); }
        try { r.sessionSaveJunk = await window.shpihcord.session.save({ evil: 1 }).then(x => x, e => "rejected: " + e.message); } catch (e) { r.sessionSaveJunk = String(e); }
        const f = document.createElement("iframe"); f.src = "https://example.com"; document.body.appendChild(f);
        return r;
      })()`);
      // Navigation attempt away from file:// (should be blocked and not opened as file).
      await wc.executeJavaScript(`location.href = "file:///C:/Windows/win.ini"; 0`).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      results.urlAfterNav = wc.getURL();
      results.windowCount = BrowserWindow.getAllWindows().length;
      results.ipcChannels = ipcMain.eventNames?.() ?? [];
      results.handleChannels = [...(ipcMain._invokeHandlers?.keys?.() ?? [])];
      for (const s of ["ignore-certificate-errors", "disable-web-security", "remote-debugging-port", "allow-insecure-localhost", "no-sandbox", "enable-features"])
        results.switches[s] = app.commandLine.hasSwitch(s) ? app.commandLine.getSwitchValue(s) || true : false;
      results.certErrorListeners = app.listenerCount("certificate-error");
    } catch (e) {
      results.error = String(e?.stack ?? e);
    }
    console.log("PROBE_RESULT " + JSON.stringify(results, null, 1));
    clearTimeout(killer);
    app.exit(0);
  });
});

await import(pathToFileURL(join(here, "../../apps/desktop/out/main/index.js")).href);
