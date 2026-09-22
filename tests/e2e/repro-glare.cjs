/** Engine-free Chromium glare/rollback repro (diagnostic only). Run: npx electron tests/e2e/repro-glare.cjs (after building the page) */
"use strict";
const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
setTimeout(() => { console.log("timeout"); app.exit(2); }, 90_000).unref();
const DIST = path.join(__dirname, "dist");
app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const f = path.join(DIST, new URL(req.url, "http://x").pathname.slice(1) || "index.html");
    if (!fs.existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" });
    fs.createReadStream(f).pipe(res);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  await win.loadURL(`http://127.0.0.1:${srv.address().port}/index.html`);
  for (const [pairs, delay] of [[10, 0], [10, 20], [10, 60], [10, 150], [10, 400]]) {
    const r = await win.webContents.executeJavaScript(`window.harness.glareRepro(${pairs}, ${delay})`);
    console.log(JSON.stringify(r));
  }
  srv.close();
  app.exit(0);
});
