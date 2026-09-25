/**
 * Authentication, secrets-at-rest and rate-limit tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import { hashToken, issueToken, SESSION_TTL_MS } from "../../apps/hub/src/auth.js";
import { Store } from "../../apps/hub/src/db.js";
import { post, register, startHub, type TestHub } from "../../apps/hub/test/helpers.js";

const hubs: TestHub[] = [];
async function hub(overrides = {}) {
  const t = await startHub(overrides);
  hubs.push(t);
  return t;
}
afterEach(async () => {
  while (hubs.length) await hubs.pop()!.stop();
});

describe("argon2id parameters (OWASP minimum m>=19MiB, t>=2, p>=1)", () => {
  it("uses argon2id with memory>=19456 KiB, iterations>=2, parallelism>=1", async () => {
    const h = await hash("password-under-test"); // @node-rs/argon2 defaults
    // PHC string: $argon2id$v=19$m=19456,t=2,p=1$...
    expect(h.startsWith("$argon2id$")).toBe(true);
    const m = /m=(\d+)/.exec(h)![1];
    const tt = /t=(\d+)/.exec(h)![1];
    const p = /p=(\d+)/.exec(h)![1];
    expect(Number(m)).toBeGreaterThanOrEqual(19456);
    expect(Number(tt)).toBeGreaterThanOrEqual(2);
    expect(Number(p)).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log(`ARGON2 params: m=${m} KiB, t=${tt}, p=${p}`);
  });
});

describe("token storage & entropy", () => {
  it("stores only the SHA-256 hash of the session token, never the raw token", async () => {
    const t = await hub();
    const a = await register(t, "tok_a");
    const store = t.hub.store as any;
    // The raw token must NOT appear as a primary key in sessions.
    const rawRow = store.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(a.token);
    expect(rawRow).toBeUndefined();
    // The sha256 hash must be present.
    const hashedRow = store.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(a.token));
    expect(hashedRow).toBeTruthy();
  });

  it("issues a fresh high-entropy token each call (256-bit, base64url)", async () => {
    const t = await hub();
    const a = await register(t, "tok_b");
    const store = t.hub.store as any;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(issueToken(store, a.user.id));
    expect(seen.size).toBe(200);
    // base64url of 32 bytes -> 43 chars, no padding
    for (const tk of seen) expect(tk).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("has NO revocation path: password change / logout / revoke-all are absent", () => {
    // Documented gap: the Store exposes createSession/getUserBySessionHash/pruneSessions only.
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "rev-")));
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    expect(methods).not.toContain("deleteSession");
    expect(methods).not.toContain("deleteSessionsForUser");
    expect(SESSION_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000); // 90-day non-revocable tokens
    store.close();
  });
});

describe("login timing: unknown user vs wrong password", () => {
  it("burns comparable time for an unknown user and a wrong password", async () => {
    const t = await hub();
    await register(t, "timing_user", "correct-horse");
    const N = 12;
    const time = async (body: any) => {
      const s = performance.now();
      await post(t.base, "/api/login", body);
      return performance.now() - s;
    };
    // warm up argon2/dummy hash
    await time({ username: "timing_user", password: "wrong" });
    await time({ username: "nobody_here", password: "wrong" });
    let unknown = 0;
    let wrong = 0;
    for (let i = 0; i < N; i++) {
      wrong += await time({ username: "timing_user", password: "wrong-pw" });
      unknown += await time({ username: "ghost_" + i, password: "wrong-pw" });
    }
    const wrongAvg = wrong / N;
    const unknownAvg = unknown / N;
    const ratio = unknownAvg / wrongAvg;
    // eslint-disable-next-line no-console
    console.log(`LOGIN timing: wrong-pw=${wrongAvg.toFixed(1)}ms unknown-user=${unknownAvg.toFixed(1)}ms ratio=${ratio.toFixed(2)}`);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
  });
});

describe("HTTP rate limiting & X-Forwarded-For", () => {
  it("rate-limits credential endpoints per IP (20/min)", async () => {
    const t = await hub();
    let limited = false;
    for (let i = 0; i < 30; i++) {
      const res = await post(t.base, "/api/login", { username: "x", password: "y" });
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("with trustProxy ON, a rotating X-Forwarded-For bypasses the per-IP limiter", async () => {
    const t = await hub({ trustProxy: true });
    let sawLimit = false;
    for (let i = 0; i < 60; i++) {
      const res = await fetch(t.base + "/api/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}` },
        body: JSON.stringify({ username: "x", password: "y" }),
      });
      if (res.status === 429) sawLimit = true;
    }
    expect(sawLimit).toBe(false); // 60 attempts, never limited -> bypass confirmed
  });
});

describe("invite codes: case handling & consumption", () => {
  it("normalizes invite code to uppercase (lowercase invite still works)", async () => {
    const t = await hub();
    const res = await post(t.base, "/api/register", {
      username: "inv_case",
      password: "hunter22",
      inviteCode: t.invite.toLowerCase(),
    });
    expect(res.status).toBe(201);
  });

  it("uses 10 Crockford-base32 chars (~50 bits) and rejects unknown codes", async () => {
    const t = await hub();
    expect(t.invite).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    const res = await post(t.base, "/api/register", {
      username: "inv_bad",
      password: "hunter22",
      inviteCode: "AAAAAAAAAA",
    });
    expect(res.status).toBe(403);
  });
});

describe("SQL injection (prepared statements)", () => {
  it("does not allow SQLi via username on login/register", async () => {
    const t = await hub();
    const evil = "robert'); DROP TABLE users;--";
    const reg = await post(t.base, "/api/register", { username: evil, password: "hunter22", inviteCode: t.invite });
    // username fails the regex (400), but the point is no crash / tables intact
    const login = await post(t.base, "/api/login", { username: evil, password: "x" });
    expect([400, 401]).toContain(login.status);
    // users table still exists & queryable
    const store = t.hub.store as any;
    expect(() => store.countUsers()).not.toThrow();
    expect(reg.status).toBeGreaterThanOrEqual(400);
  });
});

describe("password policy", () => {
  it("accepts a 6-char password with no complexity requirement", async () => {
    const t = await hub();
    const res = await post(t.base, "/api/register", { username: "weakpw", password: "aaaaaa", inviteCode: t.invite });
    expect(res.status).toBe(201);
  });
});
