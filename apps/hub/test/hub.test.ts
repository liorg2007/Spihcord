import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type SignalData } from "@shpihcord/protocol";
import { turnCredentials } from "../src/turn.js";
import { newId } from "../src/ids.js";
import { connect, post, register, startHub, TestClient, type TestHub } from "./helpers.js";

let t: TestHub;
afterEach(async () => {
  await t?.stop();
});

const offer: SignalData = { kind: "description", description: { type: "offer", sdp: "v=0\r\nfake" } };

function voiceChannels(ready: { channels: { id: string; type: string; name: string }[] }) {
  return ready.channels.filter((c) => c.type === "voice");
}

describe("http api", () => {
  beforeEach(async () => {
    t = await startHub();
  });

  it("reports health", async () => {
    const res = await fetch(`${t.base}/api/health`);
    expect(await res.json()).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION });
  });

  it("creates a first-run invite and seeds channels", () => {
    expect(t.invite).toMatch(/^[0-9A-Z]{10}$/);
    const channels = t.hub.store.listChannels();
    expect(channels.map((c) => [c.name, c.type])).toEqual([
      ["general", "text"],
      ["Hangout", "voice"],
      ["Gaming", "voice"],
    ]);
  });

  it("registers with a valid invite, rejects invalid invites and duplicate names", async () => {
    const ok = await post(t.base, "/api/register", { username: "Alice", password: "secret1", inviteCode: t.invite });
    expect(ok.status).toBe(201);
    expect(ok.body.user).toMatchObject({ username: "Alice", displayName: "Alice" });
    expect(typeof ok.body.token).toBe("string");

    const bad = await post(t.base, "/api/register", { username: "bob", password: "secret1", inviteCode: "NOPE" });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe("invalid_invite");

    const dup = await post(t.base, "/api/register", { username: "alice", password: "secret1", inviteCode: t.invite });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("username_taken");

    const invalid = await post(t.base, "/api/register", { username: "x", password: "1", inviteCode: t.invite });
    expect(invalid.status).toBe(400);
  });

  it("enforces invite use counts", async () => {
    const one = t.hub.store.createInvite({ uses: 1 });
    const a = await post(t.base, "/api/register", { username: "u1", password: "secret1", inviteCode: one.code });
    expect(a.status).toBe(201);
    const b = await post(t.base, "/api/register", { username: "u2", password: "secret1", inviteCode: one.code });
    expect(b.status).toBe(403);
  });

  it("logs in with correct credentials and gives a generic error otherwise", async () => {
    await register(t, "alice", "secret1");
    const ok = await post(t.base, "/api/login", { username: "ALICE", password: "secret1" });
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe("alice");

    const wrongPw = await post(t.base, "/api/login", { username: "alice", password: "nope" });
    const noUser = await post(t.base, "/api/login", { username: "ghost", password: "nope" });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body).toEqual(noUser.body);
  });

  it("lets only admins create invites", async () => {
    const admin = await register(t, "admin");
    const user = await register(t, "user");
    expect((await post(t.base, "/api/invites", {}, user.token)).status).toBe(403);
    expect((await post(t.base, "/api/invites", {}, "garbage")).status).toBe(401);
    const res = await post(t.base, "/api/invites", {}, admin.token);
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[0-9A-Z]{10}$/);
    const reg = await post(t.base, "/api/register", { username: "newbie", password: "secret1", inviteCode: res.body.code });
    expect(reg.status).toBe(201);
  });
});

describe("gateway", () => {
  beforeEach(async () => {
    t = await startHub();
  });

  it("sends a ready snapshot after auth", async () => {
    const alice = await register(t, "alice");
    const { client, ready } = await connect(t, alice.token);
    expect(ready.self).toEqual(alice.user);
    expect(ready.users).toEqual([alice.user]);
    expect(ready.onlineUserIds).toEqual([alice.user.id]);
    expect(ready.channels).toHaveLength(3);
    expect(ready.voiceStates).toEqual([]);
    expect(ready.iceServers).toEqual([{ urls: ["stun:stun.l.google.com:19302"] }]);
    client.close();
  });

  it("rejects an outdated protocol version", async () => {
    const alice = await register(t, "alice");
    const c = new TestClient(t.wsUrl);
    await c.opened;
    c.send({ type: "auth", token: alice.token, protocolVersion: PROTOCOL_VERSION + 1 });
    const err = await c.next("error");
    expect(err.code).toBe("outdated_client");
    expect((await c.closed).code).toBe(4002);
  });

  it("rejects an invalid token", async () => {
    const c = new TestClient(t.wsUrl);
    await c.opened;
    c.send({ type: "auth", token: "nope", protocolVersion: PROTOCOL_VERSION });
    expect((await c.next("error")).code).toBe("unauthorized");
    expect((await c.closed).code).toBe(4001);
  });

  it("rejects a non-auth first message", async () => {
    const c = new TestClient(t.wsUrl);
    await c.opened;
    c.send({ type: "voice.leave" });
    expect((await c.next("error")).code).toBe("unauthorized");
    await c.closed;
  });

  it("broadcasts presence and user.upsert", async () => {
    const alice = await register(t, "alice");
    const { client: a } = await connect(t, alice.token);
    const bob = await register(t, "bob");
    expect((await a.next("user.upsert")).user).toEqual(bob.user);
    const { client: b, ready } = await connect(t, bob.token);
    expect(new Set(ready.onlineUserIds)).toEqual(new Set([alice.user.id, bob.user.id]));
    expect(await a.next("presence.update")).toMatchObject({ userId: bob.user.id, online: true });
    b.close();
    expect(await a.next("presence.update")).toMatchObject({ userId: bob.user.id, online: false });
    a.close();
  });

  it("broadcasts voice.state on join, switch, update and leave", async () => {
    const alice = await register(t, "alice");
    const bob = await register(t, "bob");
    const { client: a, ready } = await connect(t, alice.token);
    const { client: b } = await connect(t, bob.token);
    const [hangout, gaming] = voiceChannels(ready);

    a.send({ type: "voice.join", channelId: hangout.id });
    const expected = { userId: alice.user.id, channelId: hangout.id, muted: false, deafened: false };
    expect((await b.next("voice.state")).voiceState).toEqual(expected);
    expect((await a.next("voice.state")).voiceState).toEqual(expected);

    // Late joiner sees it in the snapshot.
    const carol = await register(t, "carol");
    const { client: c, ready: cReady } = await connect(t, carol.token);
    expect(cReady.voiceStates).toEqual([expected]);

    a.send({ type: "voice.update", muted: true, deafened: false });
    expect((await b.next("voice.state")).voiceState.muted).toBe(true);

    a.send({ type: "voice.join", channelId: gaming.id });
    expect(await b.next("voice.left")).toMatchObject({ userId: alice.user.id, channelId: hangout.id });
    expect((await b.next("voice.state")).voiceState).toEqual({ ...expected, channelId: gaming.id, muted: true });

    a.send({ type: "voice.leave" });
    expect(await b.next("voice.left")).toMatchObject({ userId: alice.user.id, channelId: gaming.id });

    const text = ready.channels.find((ch) => ch.type === "text")!;
    a.send({ type: "voice.join", channelId: text.id });
    expect((await a.next("error")).code).toBe("invalid_channel");
    a.close();
    b.close();
    c.close();
  });

  it("relays rtc.signal only within the same voice channel", async () => {
    const [alice, bob, carol] = [await register(t, "alice"), await register(t, "bob"), await register(t, "carol")];
    const { client: a, ready } = await connect(t, alice.token);
    const { client: b } = await connect(t, bob.token);
    const { client: c } = await connect(t, carol.token);
    const [hangout, gaming] = voiceChannels(ready);

    // Not in voice: dropped.
    a.send({ type: "rtc.signal", to: bob.user.id, data: offer });
    expect(await b.none("rtc.signal")).toBe(true);

    a.send({ type: "voice.join", channelId: hangout.id });
    b.send({ type: "voice.join", channelId: hangout.id });
    c.send({ type: "voice.join", channelId: gaming.id });
    await a.next("voice.state", (m) => m.voiceState.userId === carol.user.id);

    a.send({ type: "rtc.signal", to: bob.user.id, data: offer });
    expect(await b.next("rtc.signal")).toEqual({ type: "rtc.signal", from: alice.user.id, data: offer });

    const cand: SignalData = {
      kind: "candidate",
      candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    };
    b.send({ type: "rtc.signal", to: alice.user.id, data: cand });
    expect((await a.next("rtc.signal")).data).toEqual(cand);

    // Across channels: dropped.
    a.send({ type: "rtc.signal", to: carol.user.id, data: offer });
    c.send({ type: "rtc.signal", to: alice.user.id, data: offer });
    expect(await c.none("rtc.signal")).toBe(true);
    expect(await a.none("rtc.signal")).toBe(true);
    a.close();
    b.close();
    c.close();
  });

  it("cleans up voice and presence on disconnect", async () => {
    const alice = await register(t, "alice");
    const bob = await register(t, "bob");
    const { client: a, ready } = await connect(t, alice.token);
    const { client: b } = await connect(t, bob.token);
    const [hangout] = voiceChannels(ready);
    b.send({ type: "voice.join", channelId: hangout.id });
    await a.next("voice.state");
    b.close();
    expect(await a.next("voice.left")).toEqual({ type: "voice.left", userId: bob.user.id, channelId: hangout.id });
    expect(await a.next("presence.update", (m) => !m.online)).toEqual({ type: "presence.update", userId: bob.user.id, online: false });
    a.close();
  });

  it("replaces an older session for the same user", async () => {
    const alice = await register(t, "alice");
    const bob = await register(t, "bob");
    const { client: b } = await connect(t, bob.token);
    const { client: a1, ready } = await connect(t, alice.token);
    await b.next("presence.update", (m) => m.online);
    const [hangout] = voiceChannels(ready);
    a1.send({ type: "voice.join", channelId: hangout.id });
    await b.next("voice.state");

    const { client: a2, ready: ready2 } = await connect(t, alice.token);
    expect((await a1.next("error")).code).toBe("session_replaced");
    expect((await a1.closed).code).toBe(4003);
    expect(await b.next("voice.left")).toMatchObject({ userId: alice.user.id });
    expect(ready2.voiceStates).toEqual([]);
    expect(ready2.onlineUserIds).toContain(alice.user.id);
    // Old socket closing must not mark the user offline.
    expect(await b.none("presence.update")).toBe(true);

    // New session still works.
    a2.send({ type: "voice.join", channelId: hangout.id });
    expect((await b.next("voice.state")).voiceState.userId).toBe(alice.user.id);
    a2.close();
    b.close();
  });

  it("answers invalid frames with an error without disconnecting", async () => {
    const alice = await register(t, "alice");
    const { client: a } = await connect(t, alice.token);
    a.send({ type: "nope" });
    expect((await a.next("error")).code).toBe("invalid_message");
    a.ws.send("not json");
    expect((await a.next("error")).code).toBe("invalid_message");
    a.send({ type: "pong" });
    expect(a.ws.readyState).toBe(a.ws.OPEN);
    a.close();
  });
});

describe("heartbeat", () => {
  it("pings and drops silent clients", async () => {
    t = await startHub({ heartbeatIntervalMs: 50, heartbeatTimeoutMs: 200 });
    const alice = await register(t, "alice");
    const { client: a } = await connect(t, alice.token);
    await a.next("ping");
    const closed = await a.closed;
    expect(closed.code).toBe(1006); // terminated
  });

  it("keeps clients that answer pong", async () => {
    t = await startHub({ heartbeatIntervalMs: 50, heartbeatTimeoutMs: 200 });
    const alice = await register(t, "alice");
    const { client: a } = await connect(t, alice.token);
    a.ws.on("message", (d) => {
      if (JSON.parse(d.toString()).type === "ping") a.send({ type: "pong" });
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(a.ws.readyState).toBe(a.ws.OPEN);
    a.close();
  });
});

describe("turn", () => {
  it("issues coturn REST credentials with a valid HMAC", () => {
    const now = 1_700_000_000_000;
    const creds = turnCredentials("s3cret", "user123", 43200, now);
    expect(creds.username).toBe(`${1_700_000_000 + 43200}:user123`);
    const expected = createHmac("sha1", "s3cret").update(creds.username).digest("base64");
    expect(creds.credential).toBe(expected);
  });

  it("includes TURN servers in ready and pushes ice.refresh", async () => {
    t = await startHub({
      turnUrls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
      turnSecret: "s3cret",
      turnTtlSeconds: 1, // refresh after 800ms
    });
    const alice = await register(t, "alice");
    const { client: a, ready } = await connect(t, alice.token);
    const turn = ready.iceServers.find((s) => s.username)!;
    expect(turn.urls).toEqual(["turn:turn.example.com:3478", "turns:turn.example.com:5349"]);
    const [expiry, userId] = turn.username!.split(":");
    expect(userId).toBe(alice.user.id);
    expect(Number(expiry)).toBeGreaterThan(Date.now() / 1000);
    expect(turn.credential).toBe(createHmac("sha1", "s3cret").update(turn.username!).digest("base64"));

    const refresh = await a.next("ice.refresh", () => true, 3000);
    expect(refresh.iceServers.some((s) => s.username)).toBe(true);
    a.close();
  });
});

describe("ids", () => {
  it("are time-sortable and unique", () => {
    const ids = Array.from({ length: 1000 }, () => newId());
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
  });
});
