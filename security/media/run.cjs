/**
 * Electron main for the media-encryption security harness.
 *   electron security/media/run.cjs <live|mitm|cert> [outName]
 * Expects security/media/out/page.js (built by run.bat with esbuild).
 * Hidden window, localhost only, self-terminating (hard timeout).
 */
"use strict";
const { app, BrowserWindow } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { X509Certificate } = require("node:crypto");

const mode = process.argv.find((a) => ["live", "mitm", "cert"].includes(a)) || "live";
const outName = process.argv[process.argv.indexOf(mode) + 1] || mode;
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
// Persistent profile (needed for the cert-persistence test across restarts).
app.setPath("userData", path.join(OUT, "userdata"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.disableHardwareAcceleration();
setTimeout(() => {
  console.error("HARD TIMEOUT");
  app.exit(2);
}, 90000);

function certInfo(c) {
  if (!c || !c.base64Certificate) return c;
  try {
    const x = new X509Certificate(Buffer.from(c.base64Certificate, "base64"));
    const k = x.publicKey;
    return {
      fingerprintAlgorithm: c.fingerprintAlgorithm,
      fingerprint: c.fingerprint,
      keyType: k.asymmetricKeyType,
      keyDetails: k.asymmetricKeyDetails,
      subject: x.subject,
      validFrom: x.validFrom,
      validTo: x.validTo,
      selfSigned: x.checkIssued(x),
    };
  } catch (e) {
    return { error: String(e) };
  }
}

app.whenReady().then(async () => {
  const html = `<!doctype html><meta charset=utf-8><body><script src="page.js"></script>`;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/page.js")) {
      res.setHeader("content-type", "text/javascript");
      return res.end(fs.readFileSync(path.join(OUT, "page.js")));
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise((r) => srv.listen(47811, "127.0.0.1", r));
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on("console-message", (_e, _l, msg) => process.env.VERBOSE && console.log("[page]", msg));
  await win.loadURL(`http://127.0.0.1:47811/#${mode}`);
  let res = null;
  for (let i = 0; i < 170 && !res; i++) {
    await new Promise((r) => setTimeout(r, 500));
    res = await win.webContents.executeJavaScript("window.__result");
  }
  if (!res) res = { fatal: "no result" };
  if (res.pairs) {
    for (const p of Object.values(res.pairs))
      for (const t of p.transports) {
        t.localCert = certInfo(t.localCert);
        t.remoteCert = certInfo(t.remoteCert);
      }
  }
  fs.writeFileSync(path.join(OUT, `${outName}.json`), JSON.stringify(res, null, 2));
  console.log(`wrote out/${outName}.json fatal=${res.fatal || "none"}`);
  srv.close();
  app.exit(res.fatal ? 1 : 0);
});
