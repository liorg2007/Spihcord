/**
 * Authorization, input-validation and DoS attack tests against the hub gateway.
 * Uses the hub's own test helpers (starts a real server on 127.0.0.1:0).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@shpihcord/protocol";
import { connect, post, register, startHub, TestClient, type TestHub } from "../../apps/hub/test/helpers.js";

let t: TestHub;
beforeAll(async () => {
  t = await startHub();
});
afterAll(async () => {
  await t.stop();
});

/** Put a client into a given voice channel (by index into listed voice channels). */
async function joinVoice(t: TestHub, token: string, voiceIndex = 0) {
  const { client, ready } = await connect(t, token);
  const voice = ready.channels.filter((c) => c.type === "voice");
  client.send({ type: "voice.join", channelId: voice[voiceIndex].id });
  await client.next("voice.state", (m) => m.voiceState.userId === ready.self.id);
  return { client, ready, channelId: voice[voiceIndex].id };
}

describe("authorization: rtc.signal", () => {
  it("does NOT forward a signal to a user in a different channel", async () => {
    const a = await register(t, "sig_a");
    const b = await register(t, "sig_b");
    const A = await joinVoice(t, a.token, 0);
    const B = await joinVoice(t, b.token, 1); // different voice channel

    A.client.send({
      type: "rtc.signal",
      to: b.user.id,
      data: { kind: "stream", action: "watch" },
    });
    expect(await B.client.none("rtc.signal", 400)).toBe(true);
    A.client.close();
    B.client.close();
  });

  it("forwards within the same channel and stamps `from` server-side (no spoofing)", async () => {
    const a = await register(t, "sig_c");
    const b = await register(t, "sig_d");
    const A = await joinVoice(t, a.token, 0);
    const B = await joinVoice(t, b.token, 0);

    // Attacker tries to spoof `from` as an arbitrary victim id.
    A.client.send({
      type: "rtc.signal",
      to: b.user.id,
      from: "SPOOFED_VICTIM_ID",
      data: { kind: "stream", action: "watch" },
    } as any);
    const got = await B.client.next("rtc.signal");
    expect(got.from).toBe(a.user.id); // server-stamped, spoof ignored
    A.client.close();
    B.client.close();
  });

  it("drops a signal to a user who is not in voice at all", async () => {
    const a = await register(t, "sig_e");
    const b = await register(t, "sig_f");
    const A = await joinVoice(t, a.token, 0);
    const { client: Bc } = await connect(t, b.token); // online but not in voice
    A.client.send({ type: "rtc.signal", to: b.user.id, data: { kind: "stream", action: "watch" } });
    expect(await Bc.none("rtc.signal", 400)).toBe(true);
    A.client.close();
    Bc.close();
  });
});

describe("input validation / strictness", () => {
  it("strips unknown extra keys but still relays a valid signal (schema is non-strict)", async () => {
    const a = await register(t, "val_a");
    const b = await register(t, "val_b");
    const A = await joinVoice(t, a.token, 0);
    const B = await joinVoice(t, b.token, 0);
    A.client.send({
      type: "rtc.signal",
      to: b.user.id,
      data: { kind: "stream", action: "watch", evil: "x", __proto__: { polluted: true } },
      injected: "should-be-stripped",
    } as any);
    const got = await B.client.next("rtc.signal");
    expect((got.data as any).evil).toBeUndefined();
    // prototype pollution check on the receiving process
    expect(({} as any).polluted).toBeUndefined();
    A.client.close();
    B.client.close();
  });

  it("FIXED B3: drops an oversized SDP (per-field .max()) instead of relaying it", async () => {
    const a = await register(t, "val_c");
    const b = await register(t, "val_d");
    const A = await joinVoice(t, a.token, 0);
    const B = await joinVoice(t, b.token, 0);
    const bigSdp = "v=0\r\n" + "a=x".repeat(19000); // ~57KB, under 64KB frame cap
    A.client.send({
      type: "rtc.signal",
      to: b.user.id,
      data: { kind: "description", description: { type: "offer", sdp: bigSdp } },
    });
    expect((await A.client.next("error")).code).toBe("invalid_message");
    expect(await B.client.none("rtc.signal", 500)).toBe(true);
    A.client.close();
    B.client.close();
  });

  it("rejects a malformed-JSON frame from an authed client with an error (not a crash)", async () => {
    const a = await register(t, "val_e");
    const { client } = await connect(t, a.token);
    client.ws.send("{not json");
    const err = await client.next("error");
    expect(err.code).toBe("invalid_message");
    client.close();
  });
});

describe("voice channel authorization", () => {
  it("rejects joining a text channel as voice", async () => {
    const a = await register(t, "vc_a");
    const { client, ready } = await connect(t, a.token);
    const text = ready.channels.find((c) => c.type === "text")!;
    client.send({ type: "voice.join", channelId: text.id });
    const err = await client.next("error");
    expect(err.code).toBe("invalid_channel");
    client.close();
  });

  it("rejects joining a non-existent channel id", async () => {
    const a = await register(t, "vc_b");
    const { client } = await connect(t, a.token);
    client.send({ type: "voice.join", channelId: "does-not-exist" });
    const err = await client.next("error");
    expect(err.code).toBe("invalid_channel");
    client.close();
  });
});

describe("admin authorization", () => {
  it("forbids a non-admin from creating invites via /api/invites", async () => {
    // first registered user is admin; make a second, non-admin user
    await register(t, "admin_seed");
    const nonAdmin = await register(t, "nonadmin_x");
    const res = await post(t.base, "/api/invites", { uses: 5 }, nonAdmin.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("rejects /api/invites with no token", async () => {
    const res = await post(t.base, "/api/invites", { uses: 5 });
    expect(res.status).toBe(401);
  });
});

describe("pre-auth DoS surface", () => {
  it("closes a socket that sends a non-auth message first", async () => {
    const client = new TestClient(t.wsUrl);
    await client.opened;
    client.send({ type: "voice.leave" });
    const { code } = await client.closed;
    expect(code).toBe(4001);
  });

  it("closes an unauthenticated socket after the auth timeout", async () => {
    const short = await startHub({ authTimeoutMs: 300 });
    try {
      const client = new TestClient(short.wsUrl);
      await client.opened;
      const { code } = await client.closed;
      expect(code).toBe(4004);
    } finally {
      await short.stop();
    }
  });

  it("FIXED B9: caps unauthenticated sockets per IP (default 20): of 60, the rest are refused", async () => {
    const socks: WebSocket[] = [];
    try {
      const results = await Promise.all(
        Array.from({ length: 60 }, () => {
          const ws = new WebSocket(t.wsUrl);
          socks.push(ws);
          return new Promise<number | "open">((res) => {
            ws.once("open", () => res("open"));
            ws.once("unexpected-response", (_req, r) => res(r.statusCode ?? 0));
            ws.once("error", () => res(0));
          });
        }),
      );
      expect(results.filter((r) => r === "open").length).toBe(20);
      expect(results.filter((r) => r === 429).length).toBe(40);
    } finally {
      await Promise.all(
        socks.map((s) =>
          s.readyState === WebSocket.OPEN
            ? new Promise<void>((res) => {
                s.once("close", () => res());
                s.close();
              })
            : Promise.resolve(),
        ),
      );
      await new Promise((r) => setTimeout(r, 100)); // let the hub release the slots
    }
  });

  it("closes a frame larger than the 64KB maxPayload", async () => {
    const client = new TestClient(t.wsUrl);
    await client.opened;
    const huge = JSON.stringify({ type: "auth", token: "x".repeat(70_000), protocolVersion: PROTOCOL_VERSION });
    const closed = new Promise<number>((res) => client.ws.once("close", (c) => res(c)));
    client.ws.send(huge);
    const code = await closed;
    expect(code).toBeGreaterThanOrEqual(1000); // ws 1009 (too big) or app close
  });
});

describe("session replacement abuse", () => {
  it("FIXED A7: a stolen token can only kick the user a few times, and the victim is told where from", async () => {
    const a = await register(t, "steal_victim");
    let current = await connect(t, a.token);
    // Default: 5 replacements per 10 minutes per user.
    for (let i = 0; i < 5; i++) {
      const next = await connect(t, a.token);
      const err = await current.client.next("error");
      expect(err.code).toBe("session_replaced");
      expect(err.message).toMatch(/IP 127\.0\.0\.1/);
      expect((await current.client.closed).code).toBe(4003);
      current = next;
    }
    const attacker = new TestClient(t.wsUrl);
    await attacker.opened;
    attacker.send({ type: "auth", token: a.token, protocolVersion: PROTOCOL_VERSION });
    expect((await attacker.next("error")).code).toBe("session_replace_limited");
    expect((await attacker.closed).code).toBe(4008);
    expect(await current.client.none("error")).toBe(true); // victim stays connected
    // The real fix for a stolen token is revocation: revoke-all kills it everywhere.
    expect((await post(t.base, "/api/sessions/revoke-all", {}, a.token)).status).toBe(200);
    expect((await current.client.closed).code).toBe(4001);
  });
});

describe("rate limiting (per-connection token bucket)", () => {
  it("emits a rate_limited error under a burst beyond the bucket", async () => {
    const a = await register(t, "flood_a");
    const { client } = await connect(t, a.token);
    // Bucket capacity 200; send 400 cheap frames fast.
    for (let i = 0; i < 400; i++) client.send({ type: "pong" });
    const err = await client.next("error", (m) => m.code === "rate_limited", 4000);
    expect(err.code).toBe("rate_limited");
    client.close();
  });
});

describe("broadcast amplification (voice.update spam)", () => {
  // Kept by design: the sidebar shows who is in every voice channel, so voice.* goes to everyone.
  it("one voice.update produces a broadcast to every online user (O(N), by design)", async () => {
    const sender = await register(t, "amp_sender");
    const S = await joinVoice(t, sender.token, 0);
    // Two bystanders NOT in voice: they still receive every voice.state broadcast.
    const w1 = await register(t, "amp_w1");
    const w2 = await register(t, "amp_w2");
    const c1 = await connect(t, w1.token);
    const c2 = await connect(t, w2.token);
    S.client.send({ type: "voice.update", muted: true, deafened: false });
    const g1 = await c1.client.next("voice.state");
    const g2 = await c2.client.next("voice.state");
    expect(g1.voiceState.userId).toBe(sender.user.id);
    expect(g2.voiceState.userId).toBe(sender.user.id);
    S.client.close();
    c1.client.close();
    c2.client.close();
  });
});
