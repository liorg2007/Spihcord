// C4 probe: boots the REAL built main hidden, then from the renderer
//  (a) calls screen.select + getDisplayMedia WITHOUT a gesture -> must fail,
//  (b) does the same from a synthesized click (sendInputEvent) with the IPC hop -> must succeed,
//  (c) selects an id never returned by getSources -> must be refused.
// Run (Windows): cd apps\desktop && npx electron ..\..\security\client\gesture-probe.mjs
import electron from "electron";
const { app, BrowserWindow } = electron;
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
process.env.SHPIHCORD_DISABLE_UPDATES = "1";
const here = dirname(fileURLToPath(import.meta.url));
BrowserWindow.prototype.show = function () {};
setTimeout(() => { console.log("PROBE_TIMEOUT"); app.exit(2); }, 30000);
const capture = `(async () => {
  const src = (await window.shpihcord.screen.getSources())[0];
  const sel = await window.shpihcord.screen.select({ sourceId: src.id, audio: "none" });
  try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); s.getTracks().forEach(t => t.stop()); return { sel: sel.ok, capture: "granted" }; }
  catch (e) { return { sel: sel.ok, capture: e.name }; }
})()`;
app.on("browser-window-created", (_e, win) => {
  const wc = win.webContents;
  wc.once("did-finish-load", async () => {
    const r = {};
    r.noGesture = await wc.executeJavaScript(capture);
    r.bogusId = await wc.executeJavaScript(`window.shpihcord.screen.select({ sourceId: "screen:9999:0", audio: "none" })`);
    await wc.executeJavaScript(`window.__r = null; (() => { const b = document.createElement("button"); b.id = "probe"; b.style.cssText = "position:fixed;left:0;top:0;width:80px;height:80px;z-index:99999"; b.onclick = () => ${capture}.then(x => window.__r = x); document.body.appendChild(b); })()`);
    wc.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
    for (let i = 0; i < 40 && !r.withClick; i++) { r.withClick = await wc.executeJavaScript("window.__r"); await new Promise(s => setTimeout(s, 250)); }
    console.log("GESTURE_PROBE " + JSON.stringify(r));
    app.exit(0);
  });
});
await import(pathToFileURL(join(here, "..", "..", "apps", "desktop", "out", "main", "index.js")).href);
