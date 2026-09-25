/**
 * Shpihcord P2P voice end-to-end test.
 *
 * Runs in Electron's main process (Electron = headless Chromium):
 *   - starts the real hub (apps/hub) as a child process on a free port with a temp DATA_DIR
 *   - serves the vite-built harness page (tests/e2e/dist) over http
 *   - opens hidden BrowserWindows, one per user, each running the real call engine
 *     against a fake mic (Chromium fake device "beep")
 *   - drives scenarios and prints PASS/FAIL; exit code != 0 on any failure.
 *
 * Run:  npm run test:e2e   (from the repo root, with Windows Node 22)
 */
"use strict";
const { app, BrowserWindow, session } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const DIST = path.join(__dirname, "dist");
const HARD_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 480_000);
/** E2E_SCREEN_ONLY=1 skips the voice scenarios 2-6 (for iterating on screen share). */
const SCREEN_ONLY = !!process.env.E2E_SCREEN_ONLY;
/** E2E_CAMERA_ONLY=1 runs only the mesh precondition + camera scenarios. */
const CAMERA_ONLY = !!process.env.E2E_CAMERA_ONLY;
const VERBOSE = !!process.env.E2E_VERBOSE;

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.disableHardwareAcceleration();

// ---------------------------------------------------------------------------
// plumbing

let hub = null;
let staticServer = null;
let dataDir = null;
const results = [];
let exiting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function cleanup() {
  if (hub && hub.exitCode === null) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(hub.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        hub.kill("SIGKILL");
      }
    } catch {
      /* already gone */
    }
  }
  try {
    staticServer?.close();
  } catch {}
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
}

function finish(code) {
  if (exiting) return;
  exiting = true;
  cleanup();
  app.exit(code);
}

const hardTimer = setTimeout(() => {
  console.log(`\nFAIL  hard timeout after ${HARD_TIMEOUT_MS} ms`);
  printSummary();
  finish(2);
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();

process.on("uncaughtException", (err) => {
  console.error("uncaught", err);
  finish(3);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection", err);
  finish(3);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function serveDist() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".map": "application/json", ".css": "text/css" };
  return new Promise((resolve) => {
    staticServer = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
      const file = path.join(DIST, rel);
      if (!file.startsWith(DIST) || !fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    staticServer.listen(0, "127.0.0.1", () => resolve(staticServer.address().port));
  });
}

async function startHub() {
  const port = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shpihcord-e2e-"));
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    STUN_URLS: "", // localhost only: host candidates, no external STUN
    LOG_LEVEL: VERBOSE ? "info" : "warn",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Plain Node (not Electron's) so better-sqlite3's native ABI matches.
  hub = spawn("node", ["--import", "tsx", path.join("apps", "hub", "src", "index.ts")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  const invite = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hub did not start in 20s. Output:\n${out}`)), 20_000);
    const onData = (buf) => {
      const s = buf.toString();
      out += s;
      if (VERBOSE) process.stdout.write(`[hub] ${s}`);
      const m = /First-run invite code:\s+(\S+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    };
    hub.stdout.on("data", onData);
    hub.stderr.on("data", (b) => {
      out += b.toString();
      process.stderr.write(`[hub:err] ${b}`);
    });
    hub.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`hub exited early (${code}). Output:\n${out}`));
    });
  });
  hub.removeAllListeners("exit");
  hub.on("exit", (code) => {
    if (!exiting) console.log(`[hub] exited unexpectedly with code ${code}`);
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {}
    await sleep(100);
  }
  return { base, invite };
}

// ---------------------------------------------------------------------------
// clients

class Client {
  constructor(name, win) {
    this.name = name;
    this.win = win;
    this.id = null;
    this.events = [];
  }
  exec(code) {
    return this.win.webContents.executeJavaScript(code, true);
  }
  call(fn, ...args) {
    return this.exec(`window.harness.${fn}(...${JSON.stringify(args)})`);
  }
  async drain() {
    const ev = await this.call("takeEvents");
    this.events.push(...ev);
    return ev;
  }
  peers() {
    return this.call("peers");
  }
}

async function openClient(name, pageUrl) {
  const partition = `e2e-${name}`;
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  ses.setPermissionCheckHandler(() => true);
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { partition, backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setAudioMuted(true); // never play the fake beeps on the real speakers
  win.webContents.on("console-message", (_e, level, message) => {
    if (VERBOSE || (level >= 2 && !message.includes("Electron Security Warning"))) console.log(`  [${name}:console:${level}] ${message}`);
  });
  win.webContents.on("render-process-gone", (_e, d) => console.log(`  [${name}] renderer gone: ${d.reason}`));
  await win.loadURL(pageUrl);
  const c = new Client(name, win);
  await waitFor(() => c.exec("!!window.harnessLoaded"), 10_000, "harness loaded");
  return c;
}

async function waitFor(fn, timeoutMs, what, intervalMs = 200) {
  const deadline = now() + timeoutMs;
  let last;
  while (now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// reporting

function record(name, pass, details) {
  results.push({ name, pass, details });
  console.log(`\n${pass ? "PASS" : "FAIL"}  ${name}`);
  for (const line of [].concat(details || [])) console.log(`      ${line}`);
}

function printSummary() {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n==== ${passed}/${results.length} scenarios passed ====`);
  for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  try {
    fs.writeFileSync(path.join(__dirname, "last-run.json"), JSON.stringify(results, null, 2));
  } catch {}
}

const short = (id, byId) => byId.get(id) || id;

/** For every client: which other members are connected (and route). */
async function meshStatus(clients) {
  const byId = new Map(clients.map((c) => [c.id, c.name]));
  const status = {};
  for (const c of clients) {
    const peers = await c.peers();
    status[c.name] = {};
    for (const p of peers) status[c.name][short(p.userId, byId)] = { state: p.connectionState, route: p.route, rtt: p.rttMs };
  }
  return status;
}

function meshComplete(status, clients, requireDirect) {
  for (const a of clients) {
    const row = status[a.name] || {};
    const others = clients.filter((c) => c !== a);
    if (Object.keys(row).length !== others.length) return false;
    for (const b of others) {
      const p = row[b.name];
      if (!p || p.state !== "connected") return false;
      if (requireDirect && p.route !== "direct") return false;
    }
  }
  return true;
}

function fmtMesh(status) {
  return Object.entries(status).map(
    ([n, row]) => `${n}: ` + (Object.entries(row).map(([m, p]) => `${m}=${p.state}/${p.route}${p.rtt != null ? `/${p.rtt}ms` : ""}`).join(" ") || "(no peers)"),
  );
}

async function waitMesh(clients, timeoutMs) {
  const t = now();
  let status;
  let connectedAt = null;
  while (now() - t < timeoutMs) {
    status = await meshStatus(clients);
    if (connectedAt === null && meshComplete(status, clients, false)) connectedAt = now() - t;
    if (meshComplete(status, clients, true)) return { ok: true, connectedMs: connectedAt ?? now() - t, directMs: now() - t, status };
    await sleep(200);
  }
  return { ok: false, connectedMs: connectedAt, status };
}

/** Names involved in a not-connected pair. */
function stuckNames(status, clients) {
  const names = new Set();
  for (const a of clients)
    for (const b of clients)
      if (a !== b && status?.[a.name]?.[b.name]?.state !== "connected") names.add(a.name).add(b.name);
  return [...names];
}

async function drainAll(clients) {
  for (const c of clients) await c.drain();
}

function errorsOf(clients) {
  const out = [];
  for (const c of clients) for (const e of c.events) if (e.type === "error" || e.type === "hubError") out.push(`${c.name}: ${e.type} ${e.message ?? ""} ${e.code ?? ""} ${e.cause ?? ""}`.trim());
  return out;
}

/** Pc states + signaling trail; limited to lines about `focus` names when given. */
async function debugDump(clients, focus) {
  const byId = new Map(clients.map((c) => [c.id, c.name]));
  const rename = (str) => str.replace(/[0-9A-Z]{26}/g, (id) => byId.get(id) || id);
  const lines = [];
  for (const c of clients) {
    const d = await c.call("debugPcs");
    lines.push(`--- ${c.name} pcs: ` + d.pcs.map((p) => `pc${p.id}(${byId.get(p.remote) || p.remote}) sig=${p.signaling} ice=${p.ice} gather=${p.gathering} conn=${p.conn} L=${p.hasLocal} R=${p.hasRemote}`).join(" | "));
    if (focus && !focus.includes(c.name)) continue;
    for (const l of d.sigLog) {
      const r = rename(l);
      if (focus && !focus.some((n) => n !== c.name && r.includes(n))) continue;
      if (/ (<-|->) \S+ cand$/.test(r)) continue; // individual candidates are noise
      lines.push(`    ${c.name}: ${r}`);
    }
  }
  return lines;
}

function fmtAudio(s) {
  return s
    ? `+${s.bytes} B, +${s.packets} pkts, statsAudioLevel(max)=${s.maxLevel}, statsRms=${s.rmsLevel} (samplesDur ${s.samplesDur}s), meterPeak=${s.meterPeak}, engine speaking-on x${s.speakingOn}`
    : "NO inbound-rtp";
}

// ---------------------------------------------------------------------------
// scenarios

async function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) throw new Error("tests/e2e/dist missing: run the vite build first");
  const { base, invite } = await startHub();
  const pagePort = await serveDist();
  const pageUrl = `http://127.0.0.1:${pagePort}/index.html`;
  console.log(`hub ${base}  invite ${invite}  page ${pageUrl}`);

  const names = ["alice", "bob", "carol", "dave", "erin"];
  const all = [];
  for (const n of names) all.push(await openClient(n, pageUrl));
  const [A, B, C, D, E] = all;
  let channels;
  for (const c of all) {
    const r = await c.call("init", { hubUrl: base, username: c.name, password: "password123", invite });
    c.id = r.userId;
    channels = r.channels;
  }
  const byId = new Map(all.map((c) => [c.id, c.name]));
  const voice = channels.filter((ch) => ch.type === "voice");
  const hangout = voice[0].id;
  const gaming = voice[1].id;
  console.log(`users: ${all.map((c) => `${c.name}=${c.id}`).join(" ")}`);
  console.log(`voice channels: ${voice.map((v) => `${v.name}=${v.id}`).join(" ")}`);
  const trio = [A, B, C];

  // 1. 3-peer mesh ---------------------------------------------------------
  for (const c of trio) await c.call("join", hangout);
  const m1 = await waitMesh(trio, 15_000);
  await drainAll(all);
  record("3-peer mesh (connected + direct within 15s)", m1.ok, [
    `all connected after ${m1.connectedMs ?? "never"} ms, all direct after ${m1.ok ? m1.directMs : "never"} ms`,
    ...fmtMesh(m1.status),
    ...errorsOf(trio),
    ...(m1.ok && !VERBOSE ? [] : await debugDump(trio, stuckNames(m1.status, trio))),
  ]);

  if (!SCREEN_ONLY && !CAMERA_ONLY) await voiceScenarios({ all, trio, A, B, C, byId, hangout, gaming });
  if (!CAMERA_ONLY) await screenScenarios({ all, trio, A, B, C, D, E, byId, hangout });
  await cameraScenarios({ all, trio, A, B, C, D, E, byId, hangout });

  for (const c of all) {
    try {
      await c.call("leave");
    } catch {}
  }
}

async function voiceScenarios({ all, trio, A, B, C, byId, hangout, gaming }) {
  // 2. audio flows -----------------------------------------------------------
  {
    const samples = await Promise.all(trio.map((c) => c.call("sampleAudio", 3000)));
    const maxLocal = await Promise.all(trio.map((c) => c.exec("window.__maxLocal()")));
    await drainAll(all);
    const lines = [];
    let ok = true;
    trio.forEach((rx, i) => {
      for (const tx of trio) {
        if (tx === rx) continue;
        const s = samples[i][tx.id];
        const good = !!s && s.bytes > 0 && (s.maxLevel > 0.01 || s.meterPeak > 0.01);
        if (!good) ok = false;
        lines.push(`${rx.name} <- ${tx.name}: ${fmtAudio(s)} ${good ? "" : "<-- no audio"}`);
        if (VERBOSE) lines.push(`   meter peak per 250ms: ${s?.timeline}`);
      }
    });
    lines.push(`local mic max level (engine 0..1 scale): ${trio.map((c, i) => `${c.name}=${maxLocal[i].toFixed(3)}`).join(" ")}`);
    const sp = [];
    for (const c of trio) {
      const remote = c.events.filter((e) => e.type === "speaking" && e.userId !== c.id && e.speaking);
      const self = c.events.filter((e) => e.type === "speaking" && e.userId === c.id && e.speaking);
      sp.push(`${c.name}: self speaking-on x${self.length}, remote speaking-on x${remote.length} (${[...new Set(remote.map((e) => byId.get(e.userId)))].join(",") || "none"})`);
    }
    lines.push("speaking events so far (informational): ", ...sp);
    record("audio flows on every leg (bytes grow, audioLevel > 0)", ok, lines);
  }

  // 3. mute ------------------------------------------------------------------
  {
    await A.call("setMuted", true);
    await sleep(1000);
    const muted = await Promise.all([B, C].map((c) => c.call("sampleAudio", 2000)));
    await A.call("setMuted", false);
    await sleep(1000);
    const unmuted = await Promise.all([B, C].map((c) => c.call("sampleAudio", 3000)));
    const lines = [];
    let ok = true;
    [B, C].forEach((rx, i) => {
      const m = muted[i][A.id];
      const u = unmuted[i][A.id];
      const silent = !!m && m.maxLevel < 0.01 && m.meterPeak < 0.01;
      const back = !!u && (u.maxLevel > 0.01 || u.meterPeak > 0.01);
      if (!silent || !back) ok = false;
      lines.push(`${rx.name} <- alice MUTED:   ${fmtAudio(m)} ${silent ? "" : "<-- not silent"}`);
      lines.push(`${rx.name} <- alice UNMUTED: ${fmtAudio(u)} ${back ? "" : "<-- did not come back"}`);
      lines.push(`   meter peak per 250ms, muted:   ${m?.timeline}`);
      lines.push(`   meter peak per 250ms, unmuted: ${u?.timeline}`);
    });
    lines.push(`control while alice muted: bob<-carol meterPeak=${muted[0][C.id]?.meterPeak}, carol<-bob meterPeak=${muted[1][B.id]?.meterPeak}`);
    await drainAll(all);
    record("mute silences alice for others, unmute restores", ok, lines);
  }

  // 4. leave / rejoin ------------------------------------------------------------
  {
    await drainAll(all);
    for (const c of all) c.events = [];
    await C.call("leave");
    let removedOk = true;
    const t = now();
    try {
      await waitFor(
        async () => {
          await drainAll(trio);
          const aGot = A.events.some((e) => e.type === "peerRemoved" && e.userId === C.id);
          const bGot = B.events.some((e) => e.type === "peerRemoved" && e.userId === C.id);
          const cPeers = await C.peers();
          return aGot && bGot && cPeers.length === 0;
        },
        5000,
        "peerRemoved for carol",
      );
    } catch {
      removedOk = false;
    }
    const removedMs = now() - t;
    const statusAfterLeave = await meshStatus(trio);
    const cOpen = (await C.call("state")).openPcs;
    const abStill = meshComplete(await meshStatus([A, B]), [A, B], true);
    await C.call("join", hangout);
    const m = await waitMesh(trio, 15_000);
    await drainAll(all);
    record("leave -> peerRemoved; rejoin -> full mesh recovers", removedOk && abStill && cOpen === 0 && m.ok, [
      `peerRemoved(carol) seen by alice & bob, carol has 0 peers: ${removedOk} (${removedMs} ms); carol open RTCPeerConnections after leave: ${cOpen}`,
      `alice<->bob still connected while carol away: ${abStill}`,
      ...fmtMesh(statusAfterLeave).map((l) => `after leave  ${l}`),
      `rejoin: connected after ${m.connectedMs ?? "never"} ms, direct after ${m.ok ? m.directMs : "never"} ms`,
      ...fmtMesh(m.status).map((l) => `after rejoin ${l}`),
      ...errorsOf(trio),
    ]);
  }

  // 5. switch channel ------------------------------------------------------------
  {
    for (const c of all) c.events = [];
    await B.call("join", gaming);
    let ok = true;
    const t = now();
    try {
      await waitFor(
        async () => {
          await drainAll(trio);
          const aGot = A.events.some((e) => e.type === "peerRemoved" && e.userId === B.id);
          const cGot = C.events.some((e) => e.type === "peerRemoved" && e.userId === B.id);
          const bPeers = await B.peers();
          return aGot && cGot && bPeers.length === 0;
        },
        5000,
        "bob torn down",
      );
    } catch {
      ok = false;
    }
    const ms = now() - t;
    const bState = await B.call("state");
    const acOk = meshComplete(await meshStatus([A, C]), [A, C], true);
    const bRemovedFor = B.events.filter((e) => e.type === "peerRemoved").map((e) => byId.get(e.userId));
    record("switch channel tears down bob<->alice/carol", ok && bState.openPcs === 0 && acOk, [
      `teardown observed in ${ms} ms: ${ok}; bob peerRemoved for [${bRemovedFor.join(",")}]; bob open RTCPeerConnections: ${bState.openPcs}; bob channel=${bState.channel === gaming ? "Gaming" : bState.channel}`,
      `alice<->carol still connected: ${acOk}`,
      ...fmtMesh(await meshStatus(trio)),
    ]);
  }

  // 6. glare / scale: 5 simultaneous joins ------------------------------------------
  {
    for (const c of all) await c.call("leave");
    await waitFor(async () => {
      for (const c of all) if ((await c.peers()).length !== 0) return false;
      return true;
    }, 5000, "everyone out of voice");
    await drainAll(all);
    for (const c of all) c.events = [];
    await Promise.all(all.map((c) => c.call("join", hangout)));
    const m = await waitMesh(all, 25_000);
    await drainAll(all);
    const status = m.status;
    let pairs = 0;
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = status[all[i].name]?.[all[j].name];
        const b = status[all[j].name]?.[all[i].name];
        if (a?.state === "connected" && b?.state === "connected") pairs++;
      }
    const resets = [];
    for (const c of all) {
      const created = c.events.filter((e) => e.type === "peer" && e.state === "new").length;
      resets.push(`${c.name}: peer objects created=${created}`);
    }
    record("5 peers joining simultaneously -> 10 connections", m.ok && pairs === 10, [
      `connected pairs: ${pairs}/10; all connected after ${m.connectedMs ?? "never"} ms, all direct after ${m.ok ? m.directMs : "never"} ms`,
      ...fmtMesh(status),
      resets.join("; "),
      ...errorsOf(all),
      ...(m.ok && !VERBOSE ? [] : await debugDump(all, stuckNames(status, all))),
    ]);
  }
}

// ---------------------------------------------------------------------------
// screen share scenarios

const kb = (x) => (x == null ? "?" : `${Math.round(x)}`);
function fmtVideo(v) {
  if (!v) return "none";
  return `${v.w ?? "?"}x${v.h ?? "?"} @${v.fps ?? "?"}fps codec=${v.codec ?? "?"}${v.encoder ? ` enc=${v.encoder}` : ""}${v.decoder ? ` dec=${v.decoder}` : ""}${v.qlr ? ` qlr=${v.qlr}` : ""}`;
}
function rateKbps(a, b, key = "bytes") {
  if (!a || !b || b.ts <= a.ts) return null;
  return ((b[key] - a[key]) * 8) / (b.ts - a.ts);
}
function evs(c, type, pred = () => true) {
  return c.events.filter((e) => e.type === type && pred(e));
}
function lastEv(c, type, pred = () => true) {
  const l = evs(c, type, pred);
  return l[l.length - 1];
}
async function waitEvent(clients, c, type, pred, timeoutMs, what) {
  const t = now();
  await waitFor(
    async () => {
      await drainAll(clients);
      return !!lastEv(c, type, pred);
    },
    timeoutMs,
    what,
    100,
  );
  return now() - t;
}

async function screenScenarios({ all, trio, A, B, C, D, E, byId, hangout }) {
  // Back to a 3-person channel.
  for (const c of [D, E]) await c.call("leave");
  let m = await waitMesh(trio, 15_000);
  if (!m.ok) {
    for (const c of trio) await c.call("join", hangout);
    m = await waitMesh(trio, 15_000);
  }
  await drainAll(all);
  for (const c of all) c.events = [];
  if (!m.ok) {
    record("screen: precondition 3-peer mesh", false, fmtMesh(m.status));
    return;
  }
  const name = (id) => byId.get(id) || id;

  // S1. alice shares (gaming), bob watches ---------------------------------------
  let s1ok = false;
  {
    const lines = [];
    const started = await A.call("startShare", "gaming");
    lines.push(`alice capture: ${started.settings.width}x${started.settings.height}@${started.settings.frameRate} contentHint=${started.contentHint} tracks=${started.tracks}`);
    await sleep(300);
    const t0 = now();
    await B.call("watch", A.id, true);
    let firstMs = null;
    try {
      firstMs = await waitEvent(all, B, "remoteScreen", (e) => e.userId === A.id && e.stream, 5000, "bob remoteScreen(alice)");
    } catch {}
    const rs = lastEv(B, "remoteScreen", (e) => e.userId === A.id && e.stream);
    // Poll inbound video until >= 1280x720 @ >= 30 fps.
    const timeline = [];
    let reachedMs = null;
    let prevIn = null;
    let last = null;
    while (now() - t0 < 9000) {
      const st = await B.call("mediaStats");
      const vi = st[A.id]?.videoIn;
      if (vi) {
        const r = rateKbps(prevIn, vi);
        timeline.push(`${((now() - t0) / 1000).toFixed(1)}s ${vi.w}x${vi.h}@${vi.fps ?? "?"} ${kb(r)}kbps`);
        prevIn = vi;
        last = { ...vi, kbps: r };
        if (reachedMs === null && vi.w >= 1280 && vi.h >= 720 && (vi.fps ?? 0) >= 30) reachedMs = now() - t0;
      }
      if (reachedMs !== null && now() - t0 > reachedMs + 2500) break;
      await sleep(500);
    }
    const aStats = await A.call("mediaStats");
    const out = aStats[B.id];
    const probe = await B.call("probeRemoteVideo", A.id, 1500);
    await drainAll(all);
    const viewers = lastEv(A, "viewers");
    const recvStats = lastEv(B, "streamStats", (e) => e.direction === "recv" && e.userId === A.id);
    const sendStats = lastEv(A, "streamStats", (e) => e.direction === "send" && e.viewerId === B.id);
    s1ok = !!rs && firstMs !== null && reachedMs !== null && reachedMs <= 6000 && viewers?.userIds?.length === 1 && viewers.userIds[0] === B.id;
    lines.push(
      `bob remoteScreen after ${firstMs ?? "never"} ms (${rs?.tracks ?? "-"}); inbound >=1280x720@>=30fps after ${reachedMs ?? "never"} ms`,
      `bob inbound: ${fmtVideo(last)} ~${kb(last?.kbps)} kbps`,
      `alice outbound->bob: ${fmtVideo(out?.videoOut)} target=${kb((out?.videoOut?.target ?? 0) / 1000)}kbps powerEfficient=${out?.videoOut?.powerEfficient}`,
      `alice sender params: ${JSON.stringify(out?.videoSenderParams)}`,
      `alice capture source (media-source stats): ${JSON.stringify(out?.videoSource)}; canvas draws so far: ${await A.exec("window.__drawCount ? window.__drawCount() : -1")}`,
      `<video muted> renders ${probe.videoWidth}x${probe.videoHeight} ~${probe.renderedFps}fps (audio tracks in stream: ${probe.audioTracksInStream})`,
      `engine streamStats recv: ${JSON.stringify(recvStats && { ...recvStats, t: undefined, type: undefined, userId: name(recvStats.userId) })}`,
      `engine streamStats send: ${JSON.stringify(sendStats && { ...sendStats, t: undefined, type: undefined, userId: name(sendStats.userId), viewerId: name(sendStats.viewerId) })}`,
      `alice viewers: [${(viewers?.userIds ?? []).map(name)}]`,
      `timeline: ${timeline.join(" | ")}`,
      ...errorsOf(trio),
    );
    record("screen 1: alice shares, bob watches -> remoteScreen + >=720p30 within ~5s", s1ok, lines);
  }

  // S2. screen audio -----------------------------------------------------------------
  {
    await A.call("setMuted", true); // mic silent: any 'speaking' for alice at bob would come from screen audio
    await sleep(800);
    await drainAll(all);
    const a0 = (await A.call("mediaStats"))[B.id]?.screenAudioOut;
    const an = await B.call("analyseScreenAudio", A.id, 3000);
    const a1 = (await A.call("mediaStats"))[B.id]?.screenAudioOut;
    const aIn = (await B.call("mediaStats"))[A.id]?.screenAudioIn;
    await B.call("setStreamVolume", A.id, 0);
    await sleep(400);
    const anMuted = await B.call("analyseScreenAudio", A.id, 800);
    await B.call("setStreamVolume", A.id, 1);
    await A.call("setMuted", false);
    await sleep(1000);
    const micBack = await B.call("analyseScreenAudio", A.id, 1500);
    await drainAll(all);
    const near = (hz, want) => Math.abs(hz - want) <= 25;
    const hasTone = near(an.leftHz, 1000) || near(an.rightHz, 1000);
    const stereo = near(an.leftHz, 1000) && near(an.rightHz, 1500);
    const screenKbps = rateKbps(a0, a1);
    const ok =
      !an.error &&
      hasTone &&
      an.speakingOn === 0 &&
      an.engineStreamLevelMax > 0.05 &&
      anMuted.engineStreamLevelMax < 0.02 &&
      an.micMsidDiffers &&
      an.screenAudioSameMsidAsVideo;
    record("screen 2: bob hears alice's screen audio separately from her mic; no speaking indicator", ok, [
      `screen audio at bob: L=${an.leftHz} Hz R=${an.rightHz} Hz (sent L=1000 R=1500) -> ${stereo ? "STEREO preserved" : "not stereo"}; rms L=${an.rmsL} R=${an.rmsR}`,
      `mic track at bob (alice muted): dominant ${an.micHz} Hz; after unmute: ${micBack.micHz} Hz (fake-device beep)`,
      `msid streams: screen audio ${JSON.stringify(an.msid?.screenAudio)} video ${JSON.stringify(an.msid?.screenVideo)} mic ${JSON.stringify(an.msid?.mic)}`,
      `engine screen-audio level (after stream volume): ${an.engineStreamLevelMax}; with setStreamVolume(0): ${anMuted.engineStreamLevelMax}`,
      `speaking-on events for alice at bob while only screen audio plays: ${an.speakingOn}`,
      `alice screen-audio out: ~${kb(screenKbps)} kbps, codec ${a1?.codec}; bob screen-audio in codec ${aIn?.codec}`,
      ...(an.error ? [`error: ${JSON.stringify(an)}`] : []),
    ]);
  }

  // S3. carol does not watch --------------------------------------------------------------
  {
    const c0 = (await C.call("mediaStats"))[A.id];
    const a0 = (await A.call("mediaStats"))[C.id];
    await sleep(2000);
    const c1 = (await C.call("mediaStats"))[A.id];
    const a1 = (await A.call("mediaStats"))[C.id];
    await drainAll(all);
    const viewers = lastEv(A, "viewers");
    const carolBytes = (c1?.videoIn?.bytes ?? 0) - (c0?.videoIn?.bytes ?? 0);
    const aliceToCarol = (a1?.videoOut?.bytes ?? 0) - (a0?.videoOut?.bytes ?? 0);
    const carolScreens = evs(C, "remoteScreen");
    const ok = (c1?.videoIn?.bytes ?? 0) === 0 && aliceToCarol === 0 && viewers?.userIds?.length === 1 && viewers.userIds[0] === B.id && carolScreens.length === 0;
    record("screen 3: carol doesn't watch -> no video bytes to carol; viewers = [bob]", ok, [
      `carol inbound video bytes total=${c1?.videoIn?.bytes ?? 0} (+${carolBytes} in 2s); alice outbound video to carol +${aliceToCarol} B`,
      `carol transceivers with alice: ${c1?.transceivers}`,
      `alice viewers: [${(viewers?.userIds ?? []).map(name)}]; carol remoteScreen events: ${carolScreens.length}`,
    ]);
  }

  // S4. bob unwatches, then watches again ---------------------------------------------------
  {
    for (const c of all) c.events = [];
    await B.call("watch", A.id, false);
    let nullMs = null;
    let viewersEmptyMs = null;
    try {
      nullMs = await waitEvent(all, B, "remoteScreen", (e) => e.userId === A.id && !e.stream, 3000, "bob remoteScreen null");
      viewersEmptyMs = await waitEvent(all, A, "viewers", (e) => e.userIds.length === 0, 3000, "alice viewers []");
    } catch {}
    await sleep(1000);
    const o0 = (await A.call("mediaStats"))[B.id]?.videoOut;
    await sleep(1500);
    const o1 = (await A.call("mediaStats"))[B.id]?.videoOut;
    const stoppedSending = (o1?.bytes ?? 0) - (o0?.bytes ?? 0) === 0;
    const bobAudio = await B.call("mediaStats");
    for (const c of all) c.events = [];
    const t = now();
    await B.call("watch", A.id, true);
    let againMs = null;
    try {
      againMs = await waitEvent(all, B, "remoteScreen", (e) => e.userId === A.id && e.stream, 5000, "bob remoteScreen again");
    } catch {}
    await sleep(1500);
    const i0 = (await B.call("mediaStats"))[A.id]?.videoIn;
    await sleep(1000);
    const i1 = (await B.call("mediaStats"))[A.id]?.videoIn;
    await drainAll(all);
    const viewers = lastEv(A, "viewers");
    const flowing = (i1?.framesDecoded ?? 0) > (i0?.framesDecoded ?? 0);
    const ok = nullMs !== null && viewersEmptyMs !== null && stoppedSending && againMs !== null && flowing && viewers?.userIds?.[0] === B.id;
    record("screen 4: unwatch -> null + viewers []; watch again -> works", ok, [
      `unwatch: bob remoteScreen null after ${nullMs ?? "never"} ms; alice viewers [] after ${viewersEmptyMs ?? "never"} ms; alice->bob video stopped: ${stoppedSending}`,
      `bob<->alice transceivers after unwatch: ${bobAudio[A.id]?.transceivers}`,
      `re-watch: remoteScreen after ${againMs ?? "never"} ms (${now() - t} ms total); frames decoding: ${flowing} (${fmtVideo(i1)}); alice viewers: [${(viewers?.userIds ?? []).map(name)}]`,
    ]);
  }

  // S5. preset gaming -> text -----------------------------------------------------------------
  {
    await sleep(2500);
    await drainAll(all);
    const before = lastEv(A, "streamStats", (e) => e.direction === "send" && e.viewerId === B.id);
    const beforeRecv = lastEv(B, "streamStats", (e) => e.direction === "recv" && e.userId === A.id);
    const beforeParams = (await A.call("mediaStats"))[B.id]?.videoSenderParams;
    for (const c of all) c.events = [];
    const settings = await A.call("setPreset", "text");
    await sleep(5000);
    await drainAll(all);
    const after = lastEv(A, "streamStats", (e) => e.direction === "send" && e.viewerId === B.id);
    const afterRecv = lastEv(B, "streamStats", (e) => e.direction === "recv" && e.userId === A.id);
    const params = (await A.call("mediaStats"))[B.id]?.videoSenderParams;
    const f = (s) => (s ? `${s.width}x${s.height}@${s.fps}fps ${s.bitrateKbps}kbps ${s.codec} ql=${s.qualityLimitation ?? "-"}` : "none");
    const ok =
      !!after &&
      (after.fps ?? 99) <= 17 &&
      (after.width ?? 0) >= 1280 &&
      params?.enc?.maxFramerate === 15 &&
      params?.enc?.maxBitrate === 5_000_000 &&
      params?.degradationPreference === "maintain-resolution" &&
      (!!afterRecv && (afterRecv.fps ?? 99) <= 17);
    record("screen 5: preset gaming -> text is applied live and visible in stats", ok, [
      `gaming: send ${f(before)} | recv ${f(beforeRecv)} | params ${JSON.stringify(beforeParams)}`,
      `text:   send ${f(after)} | recv ${f(afterRecv)} | params ${JSON.stringify(params)}`,
      `capture settings after setPreset: ${settings ? `${settings.width}x${settings.height}@${settings.frameRate}` : "?"}`,
    ]);
  }

  // S6. stop -> null; restart; rejoin + rewatch; replacement; OS-ended -------------------------------
  {
    for (const c of all) c.events = [];
    await A.call("stopShare");
    let nullMs = null;
    try {
      nullMs = await waitEvent(all, B, "remoteScreen", (e) => e.userId === A.id && !e.stream, 3000, "bob null after stop");
    } catch {}
    await drainAll(all);
    const viewersAfterStop = lastEv(A, "viewers");
    const sharingAfterStop = (await A.call("screenState")).sharing;

    // Restart: bob's watch intent is remembered on both sides -> bob gets it again.
    for (const c of all) c.events = [];
    await A.call("startShare", "balanced");
    let restartMs = null;
    try {
      restartMs = await waitEvent(all, B, "remoteScreen", (e) => e.userId === A.id && e.stream, 5000, "bob stream after restart");
    } catch {}

    // Carol leaves, rejoins during the share and watches (+ watch sent before her connection exists).
    await C.call("leave");
    await sleep(500);
    await C.call("watch", A.id, true); // no connection yet: must be sent once the peer is created
    await C.call("join", hangout);
    let carolMs = null;
    const tc = now();
    try {
      await waitEvent(all, C, "remoteScreen", (e) => e.userId === A.id && e.stream, 12_000, "carol stream after rejoin");
      carolMs = now() - tc;
    } catch {}
    await drainAll(all);
    const viewersBoth = lastEv(A, "viewers");

    // Replacement share keeps viewers without a null blip (replaceTrack).
    for (const c of all) c.events = [];
    await A.call("startShare", "gaming");
    await sleep(2500);
    await drainAll(all);
    const blips = evs(B, "remoteScreen", (e) => e.userId === A.id && !e.stream).length + evs(C, "remoteScreen", (e) => e.userId === A.id && !e.stream).length;
    const i0 = await B.call("mediaStats");
    await sleep(1000);
    const i1 = await B.call("mediaStats");
    const replaceFlowing = (i1[A.id]?.videoIn?.framesDecoded ?? 0) > (i0[A.id]?.videoIn?.framesDecoded ?? 0);

    // Bob's connection to alice is recreated mid-share (reset): the watch is re-sent
    // on the new connection and alice (remote-restarted) re-attaches.
    for (const c of all) c.events = [];
    await B.call("forceReset", A.id);
    let resetMs = null;
    const tr = now();
    try {
      await waitEvent(all, B, "remoteScreen", (e) => e.userId === A.id && e.stream, 12_000, "bob stream after reset");
      resetMs = now() - tr;
    } catch {}
    await drainAll(all);
    const bobNullOnReset = evs(B, "remoteScreen", (e) => e.userId === A.id && !e.stream).length;
    const viewersAfterReset = lastEv(A, "viewers") ?? { userIds: ["(unchanged)"] };

    // OS ends the capture -> localScreenEnded + viewers get null.
    for (const c of all) c.events = [];
    await A.call("endShareExternally");
    let endedOk = false;
    try {
      await waitEvent(all, A, "localScreenEnded", () => true, 2000, "localScreenEnded");
      await waitEvent(all, B, "remoteScreen", (e) => e.userId === A.id && !e.stream, 3000, "bob null after OS end");
      await waitEvent(all, C, "remoteScreen", (e) => e.userId === A.id && !e.stream, 3000, "carol null after OS end");
      endedOk = true;
    } catch {}
    const sharingAfterEnd = (await A.call("screenState")).sharing;
    const ok =
      nullMs !== null &&
      viewersAfterStop?.userIds?.length === 0 &&
      !sharingAfterStop &&
      restartMs !== null &&
      carolMs !== null &&
      viewersBoth?.userIds?.length === 2 &&
      blips === 0 &&
      replaceFlowing &&
      resetMs !== null &&
      endedOk &&
      !sharingAfterEnd;
    record("screen 6: stop -> null; restart, rejoin+watch, replacement, connection reset and OS-ended all work", ok, [
      `stop: bob null after ${nullMs ?? "never"} ms; alice viewers [${(viewersAfterStop?.userIds ?? []).map(name)}]; isScreenSharing=${sharingAfterStop}`,
      `restart (balanced): bob receives again after ${restartMs ?? "never"} ms (remembered watch)`,
      `carol leave -> watch (before connection) -> rejoin: remoteScreen after ${carolMs ?? "never"} ms; alice viewers [${(viewersBoth?.userIds ?? []).map(name)}]`,
      `replacement share: null blips=${blips}, bob still decoding=${replaceFlowing}`,
      `bob's connection to alice reset mid-share: null x${bobNullOnReset}, stream again after ${resetMs ?? "never"} ms; alice viewers event after reset: [${(viewersAfterReset.userIds ?? []).map(name)}]`,
      `OS-ended capture: localScreenEnded + viewers null: ${endedOk}; isScreenSharing=${sharingAfterEnd}`,
      ...errorsOf(trio),
    ]);
  }

  // S7. voice still fine after all the renegotiations ---------------------------------------------
  {
    const m2 = await waitMesh(trio, 10_000);
    const samples = await Promise.all(trio.map((c) => c.call("sampleAudio", 2500)));
    let ok = m2.ok;
    const lines = [];
    trio.forEach((rx, i) => {
      for (const tx of trio) {
        if (tx === rx) continue;
        const s = samples[i][tx.id];
        const good = !!s && s.bytes > 0 && (s.maxLevel > 0.01 || s.meterPeak > 0.01);
        if (!good) ok = false;
        lines.push(`${rx.name} <- ${tx.name}: ${fmtAudio(s)} ${good ? "" : "<-- no audio"}`);
      }
    });
    await drainAll(all);
    record("screen 7: voice still flows on every leg after screen-share renegotiations", ok, [...fmtMesh(m2.status), ...lines, ...errorsOf(trio)]);
  }
}


// ---------------------------------------------------------------------------
// camera scenarios

const fmtCam = (v) => (v ? `${v.w ?? "?"}x${v.h ?? "?"}@${v.fps ?? "?"}fps ${v.codec ? v.codec.split(" ")[0] : "?"}` : "none");

async function camRate(rx, txId, ms) {
  const a = (await rx.call("cameraStats"))[txId]?.in;
  await sleep(ms);
  const b = (await rx.call("cameraStats"))[txId]?.in;
  return { bytes: (b?.bytes ?? 0) - (a?.bytes ?? 0), frames: (b?.framesDecoded ?? 0) - (a?.framesDecoded ?? 0), kbps: rateKbps(a, b), last: b };
}

/** Poll until the inbound camera from tx at rx is stable in height (or timeout). */
async function settleCam(rx, txId, ms) {
  const deadline = now() + ms;
  let last = null;
  let same = 0;
  while (now() < deadline) {
    const v = (await rx.call("cameraStats"))[txId]?.in;
    if (v?.h && last?.h === v.h) same++;
    else same = 0;
    last = v;
    if (same >= 4) break;
    await sleep(500);
  }
  return last;
}

async function cameraScenarios({ all, trio, A, B, C, D, E, byId, hangout }) {
  for (const c of [D, E]) await c.call("leave");
  let m = await waitMesh(trio, 15_000);
  if (!m.ok) {
    for (const c of trio) await c.call("join", hangout);
    m = await waitMesh(trio, 15_000);
  }
  await drainAll(all);
  await drainAll(all);
    for (const c of all) c.events = [];
  if (!m.ok) {
    record("camera: precondition 3-peer mesh", false, fmtMesh(m.status));
    return;
  }
  const name = (id) => byId.get(id) || id;
  const others = [B, C];

  // C1. alice turns on the camera -> bob & carol get it ---------------------------------
  {
    const t0 = now();
    const started = await A.call("startCamera");
    const got = {};
    try {
      await waitFor(
        async () => {
          await drainAll(all);
          for (const rx of others) if (got[rx.name] == null && lastEv(rx, "remoteCamera", (e) => e.userId === A.id && e.stream)) got[rx.name] = now() - t0;
          return others.every((rx) => got[rx.name] != null);
        },
        8000,
        "remoteCamera(alice)",
        100,
      );
    } catch {}
    const settled = await Promise.all(others.map((rx) => settleCam(rx, A.id, 8000)));
    const rates = await Promise.all(others.map((rx) => camRate(rx, A.id, 1500)));
    const aStats = await A.call("cameraStats");
    await drainAll(all);
    const lines = [`alice capture: ${started.settings?.width}x${started.settings?.height}@${started.settings?.frameRate} contentHint=${started.contentHint}`];
    let ok = true;
    others.forEach((rx, i) => {
      const fast = got[rx.name] != null && got[rx.name] <= 3500;
      const flowing = rates[i].frames > 10;
      if (!fast || !flowing) ok = false;
      const out = aStats[rx.id];
      lines.push(
        `${rx.name}: remoteCamera after ${got[rx.name] ?? "never"} ms; inbound ${fmtCam(rates[i].last)} ~${kb(rates[i].kbps)} kbps (+${rates[i].frames} frames/1.5s) ${fast && flowing ? "" : "<-- FAIL"}`,
        `   alice->${rx.name} out ${fmtCam(out?.out)} qlr=${out?.out?.qlr} params ${JSON.stringify(out?.params)}`,
      );
    });
    const sendStats = lastEv(A, "streamStats", (e) => e.kind === "camera" && e.direction === "send");
    const recvStats = lastEv(B, "streamStats", (e) => e.kind === "camera" && e.direction === "recv");
    lines.push(`engine streamStats camera send: ${JSON.stringify(sendStats && { ...sendStats, t: undefined, type: undefined, userId: name(sendStats.userId), viewerId: name(sendStats.viewerId) })}`);
    lines.push(`engine streamStats camera recv (bob): ${JSON.stringify(recvStats && { ...recvStats, t: undefined, type: undefined, userId: name(recvStats.userId) })}`);
    if (!sendStats?.viewerId || !recvStats) ok = false;
    lines.push(...errorsOf(trio));
    record("camera 1: alice camera on -> bob & carol get remoteCamera with live video (3 people: 720p tier)", ok, lines);
  }

  // C2. off -> null, capture ended, no renegotiation; on again -> back, no renegotiation ----------
  {
    await drainAll(all);
    for (const c of all) c.events = [];
    const offers0 = await Promise.all(trio.map((c) => c.call("cameraState").then((s) => s.offers)));
    const t = now();
    const stopped = await A.call("stopCamera");
    const nulls = {};
    try {
      await waitFor(
        async () => {
          await drainAll(all);
          for (const rx of others) if (nulls[rx.name] == null && lastEv(rx, "remoteCamera", (e) => e.userId === A.id && !e.stream)) nulls[rx.name] = now() - t;
          return others.every((rx) => nulls[rx.name] != null);
        },
        5000,
        "remoteCamera null",
        100,
      );
    } catch {}
    const localNull = !!lastEv(A, "localCamera", (e) => !e.stream);
    await sleep(1000);
    const offers1 = await Promise.all(trio.map((c) => c.call("cameraState").then((s) => s.offers)));
    await drainAll(all);
    for (const c of all) c.events = [];
    const t2 = now();
    await A.call("startCamera");
    const back = {};
    try {
      await waitFor(
        async () => {
          await drainAll(all);
          for (const rx of others) if (back[rx.name] == null && lastEv(rx, "remoteCamera", (e) => e.userId === A.id && e.stream)) back[rx.name] = now() - t2;
          return others.every((rx) => back[rx.name] != null);
        },
        5000,
        "remoteCamera back",
        100,
      );
    } catch {}
    const flowing = await camRate(B, A.id, 1500);
    await sleep(500);
    const offers2 = await Promise.all(trio.map((c) => c.call("cameraState").then((s) => s.offers)));
    const noReneg = offers0.every((o, i) => o === offers1[i] && o === offers2[i]);
    const ok = others.every((rx) => nulls[rx.name] != null && back[rx.name] != null) && stopped.lastTrackState === "ended" && !stopped.on && localNull && noReneg && flowing.frames > 10;
    record("camera 2: off -> null + capture track ended, on again -> back; no renegotiation either way", ok, [
      `off: null at ${others.map((rx) => `${rx.name}=${nulls[rx.name] ?? "never"}ms`).join(" ")}; alice capture track readyState=${stopped.lastTrackState}; localCamera(null)=${localNull}`,
      `on:  stream at ${others.map((rx) => `${rx.name}=${back[rx.name] ?? "never"}ms`).join(" ")}; bob decoding +${flowing.frames} frames/1.5s ${fmtCam(flowing.last)}`,
      `offers (sent+received) alice/bob/carol: before ${offers0.join("/")}, after off ${offers1.join("/")}, after on ${offers2.join("/")} -> renegotiation: ${noReneg ? "none" : "YES"}`,
      ...errorsOf(trio),
    ]);
  }

  // C3. per-viewer preference ---------------------------------------------------------------
  {
    await drainAll(all);
    for (const c of all) c.events = [];
    await B.call("setCameraPreference", A.id, "off");
    await sleep(1500);
    const [bOff, cOff] = await Promise.all([camRate(B, A.id, 2000), camRate(C, A.id, 2000)]);
    const paramsOff = (await A.call("cameraStats"))[B.id]?.params?.enc;
    await drainAll(all);
    const bobNullWhileOff = evs(B, "remoteCamera", (e) => e.userId === A.id && !e.stream).length;
    await B.call("setCameraPreference", A.id, "low");
    await sleep(1000);
    const low = await settleCam(B, A.id, 8000);
    const lowRate = await camRate(B, A.id, 2000);
    const paramsLow = (await A.call("cameraStats"))[B.id]?.params?.enc;
    const carolDuringLow = await camRate(C, A.id, 1000);
    await B.call("setCameraPreference", A.id, "high");
    await sleep(1000);
    const high = await settleCam(B, A.id, 10_000);
    const highRate = await camRate(B, A.id, 1500);
    const paramsHigh = (await A.call("cameraStats"))[B.id]?.params?.enc;
    const ok =
      bOff.frames === 0 && bOff.bytes < 25_000 && // no media; BWE padding/probing may still arrive
      cOff.frames > 10 &&
      paramsOff?.active === false &&
      (lowRate.last?.h ?? 999) <= 200 &&
      lowRate.frames > 5 &&
      (lowRate.kbps ?? 999) < 250 &&
      (highRate.last?.h ?? 0) > 200 &&
      highRate.frames > 10 &&
      carolDuringLow.last?.h > 200;
    record("camera 3: bob's preference for alice: off -> ~0 bytes (carol unaffected), low -> <=~200p, high -> restored", ok, [
      `off:  bob +${bOff.bytes} B/+${bOff.frames} frames in 2s; carol +${cOff.frames} frames ${fmtCam(cOff.last)}; alice enc->bob ${JSON.stringify(paramsOff)}; bob remoteCamera null events while off: ${bobNullWhileOff}`,
      `low:  bob ${fmtCam(lowRate.last)} ~${kb(lowRate.kbps)} kbps (+${lowRate.frames} frames/2s); alice enc->bob ${JSON.stringify(paramsLow)}; carol meanwhile ${fmtCam(carolDuringLow.last)}`,
      `high: bob ${fmtCam(highRate.last)} ~${kb(highRate.kbps)} kbps; alice enc->bob ${JSON.stringify(paramsHigh)}`,
      ...errorsOf(trio),
    ]);
  }

  // C4. camera + screen share from the same user ----------------------------------------------
  {
    await drainAll(all);
    for (const c of all) c.events = [];
    await A.call("startShare", "balanced");
    await B.call("watch", A.id, true);
    let ok = false;
    const lines = [];
    try {
      await waitEvent(all, B, "remoteScreen", (e) => e.userId === A.id && e.stream, 6000, "bob remoteScreen");
    } catch {}
    await sleep(2000);
    const id = await B.call("identify", A.id);
    const camR = await camRate(B, A.id, 1500);
    const scr = (await B.call("mediaStats"))[A.id];
    const an = await B.call("analyseScreenAudio", A.id, 2000);
    const audio = await B.call("sampleAudio", 2000);
    await drainAll(all);
    const camNulls = evs(B, "remoteCamera", (e) => e.userId === A.id && !e.stream).length;
    const camTrail = evs(B, "remoteCamera", (e) => e.userId === A.id).map((e) => `${e.stream ? "on" : "null"}@${e.t}`).join(" ");
    const shareAt = lastEv(B, "remoteScreen", (e) => e.userId === A.id && e.stream)?.t;
    const micOk = !!audio[A.id] && audio[A.id].bytes > 0;
    ok =
      id.distinct &&
      id.cameraMidMatches &&
      id.screenMidMatches &&
      String(id.cameraMsid[0]).startsWith("cam-") &&
      String(id.screenMsid[0]).startsWith("scr-") &&
      String(id.micMsid[0]).startsWith("mic-") &&
      camR.frames > 10 &&
      (scr?.videoIn?.framesDecoded ?? 0) > 0 &&
      camNulls === 0 &&
      !an.error &&
      an.screenAudioSameMsidAsVideo &&
      an.micMsidDiffers &&
      micOk;
    lines.push(
      `bob receives from alice: camera track ${id.cameraTrack} msid ${JSON.stringify(id.cameraMsid)} | screen track ${id.screenTrack} msid ${JSON.stringify(id.screenMsid)} | distinct=${id.distinct}`,
      `mids ${JSON.stringify(id.mids)}; camera mid matches=${id.cameraMidMatches}, screen mid matches=${id.screenMidMatches}`,
      `mic msid ${JSON.stringify(id.micMsid)}; screen audio msid ${JSON.stringify(id.screenAudioMsid)}; screen audio tone L=${an.leftHz}Hz R=${an.rightHz}Hz`,
      `camera still decoding: +${camR.frames} frames/1.5s ${fmtCam(camR.last)}; screen inbound ${fmtVideo(scr?.videoIn)}; camera null blips: ${camNulls} (trail ${camTrail}; screen arrived @${shareAt})`,
      `mic from alice at bob: ${fmtAudio(audio[A.id])}`,
      ...errorsOf(trio),
    );
    record("camera 4: camera + screen share from alice at once -> bob gets both, correctly identified; screen audio separate from mic", ok, lines);
    await B.call("watch", A.id, false);
    await A.call("stopShare");
    await sleep(1000);
  }

  // C5. five people with cameras -> 480p tier -----------------------------------------------------
  {
    for (const c of [D, E]) await c.call("join", hangout);
    const m5 = await waitMesh(all, 25_000);
    for (const c of [B, C, D, E]) await c.call("startCamera");
    // Each receiver should see 4 remote cameras.
    let allCams = false;
    try {
      await waitFor(
        async () => {
          for (const rx of all) {
            const st = await rx.call("cameraState");
            if (st.remote.filter(([, on]) => on).length !== 4) return false;
          }
          return true;
        },
        15_000,
        "everyone sees 4 cameras",
        300,
      );
      allCams = true;
    } catch {}
    await sleep(6000);
    const lines = [`mesh: ${m5.ok ? "complete" : "INCOMPLETE"}; everyone sees 4 remote cameras: ${allCams}`];
    let ok = m5.ok && allCams;
    for (const tx of all) {
      const st = await tx.call("cameraStats");
      const row = [];
      for (const rx of all) {
        if (rx === tx) continue;
        const r = st[rx.id];
        const enc = r?.params?.enc;
        const good = enc && enc.maxBitrate === 800_000 && enc.maxFramerate === 30 && (r?.out?.h ?? 999) <= 480 && enc.active !== false;
        if (!good) ok = false;
        row.push(`->${rx.name} ${fmtCam(r?.out)} [maxBitrate=${enc?.maxBitrate} maxFps=${enc?.maxFramerate} scale=${enc?.scaleResolutionDownBy}]${good ? "" : " <--"}`);
      }
      lines.push(`${tx.name}: ${row.join(" | ")}`);
    }
    const recv = await B.call("cameraStats");
    lines.push(`bob inbound: ${all.filter((c) => c !== B).map((c) => `${c.name}=${fmtCam(recv[c.id]?.in)}`).join(" ")}`);
    lines.push(...errorsOf(all));
    record("camera 5: 5 people with cameras on -> every per-viewer cap at the 480p tier (800 kbps, 30 fps)", ok, lines);
  }

  // C6. late joiner gets the existing cameras immediately -------------------------------------------
  {
    await E.call("leave");
    await waitFor(async () => (await E.peers()).length === 0, 5000, "erin out");
    await sleep(800);
    await drainAll(all);
    await drainAll(all);
    for (const c of all) c.events = [];
    const t = now();
    await E.call("join", hangout);
    const got = {};
    try {
      await waitFor(
        async () => {
          await drainAll([E]);
          for (const tx of [A, B, C, D]) if (got[tx.name] == null && lastEv(E, "remoteCamera", (e) => e.userId === tx.id && e.stream)) got[tx.name] = now() - t;
          return [A, B, C, D].every((tx) => got[tx.name] != null);
        },
        15_000,
        "erin gets all cameras",
        100,
      );
    } catch {}
    await sleep(1500);
    const rows = await E.call("cameraStats");
    const ok = [A, B, C, D].every((tx) => got[tx.name] != null && got[tx.name] <= 8000 && (rows[tx.id]?.in?.framesDecoded ?? 0) > 0);
    record("camera 6: late joiner (erin) receives the 4 existing cameras right away", ok, [
      `after join: ${[A, B, C, D].map((tx) => `${tx.name}=${got[tx.name] ?? "never"}ms`).join(" ")}`,
      `erin inbound: ${[A, B, C, D].map((tx) => `${tx.name}=${fmtCam(rows[tx.id]?.in)}`).join(" ")}`,
      ...errorsOf(all),
    ]);
  }

  // C7. everyone off; voice fine --------------------------------------------------------------------
  {
    for (const c of all) await c.call("stopCamera");
    await sleep(3000);
    await drainAll(all);
    const states = await Promise.all(all.map((c) => c.call("cameraState")));
    const leftover = states.map((s, i) => `${all[i].name}: remote on=[${s.remote.filter(([, on]) => on).map(([u]) => name(u))}] local tracks=${s.localTracks.join(",")}`);
    const samples = await Promise.all(trio.map((c) => c.call("sampleAudio", 2000)));
    let ok = states.every((s) => !s.on && s.remote.every(([, on]) => !on) && s.localTracks.every((r) => r === "ended"));
    const lines = [...leftover];
    trio.forEach((rx, i) => {
      for (const tx of trio) {
        if (tx === rx) continue;
        const s = samples[i][tx.id];
        const good = !!s && s.bytes > 0 && (s.maxLevel > 0.01 || s.meterPeak > 0.01);
        if (!good) ok = false;
        lines.push(`${rx.name} <- ${tx.name}: ${fmtAudio(s)} ${good ? "" : "<-- no audio"}`);
      }
    });
    if (!ok || VERBOSE) for (const c of trio) lines.push(...(await c.call("pcSummary")).map((l) => `${c.name} (t0): ${l.replace(/[0-9A-Z]{26}/g, (id) => name(id))}`));
    if (!ok || VERBOSE) await sleep(1000);
    if (!ok || VERBOSE) for (const c of trio) lines.push(...(await c.call("pcSummary")).map((l) => `${c.name}: ${l.replace(/[0-9A-Z]{26}/g, (id) => name(id))}`));
    record("camera 7: all cameras off -> no remote cameras, all capture tracks ended; voice still flows", ok, [...lines, ...errorsOf(all)]);
  }
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await main();
    code = results.every((r) => r.pass) && results.length > 0 ? 0 : 1;
  } catch (err) {
    console.log(`\nFAIL  harness error: ${err && err.stack ? err.stack : err}`);
    code = 1;
  }
  printSummary();
  finish(code);
});
app.on("window-all-closed", () => {});
