# Shpihcord Hub — Security Audit

Scope: `apps/hub` (Fastify + `ws` + better-sqlite3 + `@node-rs/argon2`), `packages/protocol`, plus a read-only review of the desktop session store. Areas: (A) authentication, sessions and secrets at rest; (B) authorization, input validation and DoS. Static review + a runnable attack suite (`security/hub/`, vitest, starts a real hub on 127.0.0.1:0). No source files modified.

## Running the attack tests
```
security\hub\run.bat
```
or `npx vitest run --config security/hub/vitest.config.ts` (Windows Node 22; WSL node v12 will not work).
Result: **28/28 pass** (`auth.test.ts`, `authz.test.ts`). `npm audit --omit=dev -w @shpihcord/hub`: **0 vulnerabilities**.
Measured: ARGON2 `m=19456 KiB, t=2, p=1`; LOGIN timing wrong-pw ~12.1 ms vs unknown-user ~11.2 ms (ratio ~0.92).

## A. Authentication, sessions, secrets
| # | Check | Verdict | Sev |
|---|---|---|---|
| A1 | argon2id vs OWASP | PASS | — |
| A2 | Password policy | RISK | Low |
| A3 | Token entropy & hash-only storage | PASS | — |
| A4 | Token comparison constant-time | PASS(note) | Low |
| A5 | Token never logged | PASS | — |
| A6 | Expiry/revocation/logout/pw-change | FAIL | Med |
| A7 | Session replacement abuse | RISK | Med |
| A8 | Login timing (enumeration) | PASS | — |
| A9 | Register `username_taken` enumeration | RISK(inherent) | Low |
| A10 | HTTP rate limit login/register | PASS | — |
| A11 | XFF rate-limit bypass | RISK | Med |
| A12 | Invite entropy/reuse/case | PASS | Low |
| A13 | First-run invite in logs | RISK | Low |
| A14 | DB file at rest | RISK | Low |
| A15 | Desktop stored session | RISK | Low |

**A1 PASS** — auth.ts:10 `hash(password)` uses `@node-rs/argon2` defaults; measured `$argon2id$v=19$m=19456,t=2,p=1` = exact OWASP minimum. At the floor; consider pinning explicitly.
**A2 RISK(Low)** — protocol index.ts password `min(6).max(128)`, no complexity/breach check; `aaaaaa` registers. OK for invite-gated group; consider min 8 + denylist.
**A3 PASS** — auth.ts:34 `randomBytes(32)` base64url (256-bit); only `sha256(token)` stored (`sessions.token_hash`). Test: raw token absent, 200 tokens unique, `^[A-Za-z0-9_-]{43}$`.
**A4 PASS(note)** — token lookup is SQL equality on a hash of a 256-bit secret; index timing not exploitable.
**A5 PASS** — no token in any log; register logs userId/username/admin only (http.ts:84).
**A6 FAIL(Med)** — SESSION_TTL_MS = 90 days (auth.ts:6); **no logout / revoke-all / password-change / per-session delete** (Store has only createSession/getUserBySessionHash/pruneSessions, db.ts). Leaked token valid 90 days, unkillable. Fix: add deleteSession/deleteSessionsForUser (db.ts), POST /api/logout + pw-change revocation (http.ts), short access-token TTL + refresh.
**A7 RISK(Med)** — onAuth (gateway.ts ~190) evicts prior socket on same-token auth (close 4003). With no revocation, a stolen token can repeatedly kick the real user offline. Fix: tie to A6.
**A8 PASS** — verifyDummy (auth.ts:22) hashes a cached dummy for unknown users; ratio 0.92. No timing enumeration.
**A9 RISK(inherent,Low)** — register returns 409 username_taken (http.ts ~78). Inherent UX, invite-gated. Noted.
**A10 PASS** — createIpLimiter(20,60000) on login/register (http.ts:56); 429 within 30 attempts. /api/invites unlimited but admin-only.
**A11 RISK(Med)** — limiter keys on req.ip (http.ts ~60). Safe with trustProxy:false (default). With TRUST_PROXY=1 (needed behind Caddy per PLAN §9), Fastify trusts full XFF and takes client-supplied leftmost; test: 60 logins with rotating XFF, never limited. Fix: trustProxy = hop count / proxy CIDR (config.ts/server.ts) and have Caddy overwrite XFF.
**A12 PASS(Low)** — randomCode(10) Crockford base32 ~50 bits (ids.ts); atomic consume w/ uses_left (db.ts); input trim().toUpperCase() (http.ts ~73), lowercase works. Brute force infeasible unless A11 bypassed.
**A13 RISK(Low)** — index.ts ~8 console.log prints first-run invite to stdout; persists in docker logs. By design (PLAN §9); consider writing to a 0600 file.
**A14 RISK(Low)** — hub.sqlite(+wal/shm) created with process umask (often 0644). Stores argon2id hashes + sha256 token hashes only (no plaintext secrets; a stolen hash is not a usable bearer token). Fix: data dir 0700, DB files 0600 (db.ts Store ctor).
**A15 RISK(Low, read-only)** — desktop/src/main/session.ts: safeStorage-encrypted 0600 atomic write (good); Linux-no-keyring falls back to plaintext session.json (0600) and signals "plaintext" so renderer warns (transparent). Residual: 90-day token in plaintext, unrevocable (A6).

## B. Authorization, validation, DoS
| # | Check | Verdict | Sev |
|---|---|---|---|
| B1 | rtc.signal cross-channel isolation | PASS | — |
| B2 | Spoof `from` | PASS | — |
| B3 | Schema strictness (extra keys/huge SDP) | RISK | Low |
| B4 | Prototype pollution via `__proto__` | PASS | — |
| B5 | Admin action as non-admin | PASS | — |
| B6 | Join text-as-voice / non-existent id | PASS | — |
| B7 | Everyone sees everything | Noted(design) | — |
| B8 | Pre-auth message / auth timeout | PASS | — |
| B9 | Unauthenticated connection cap | FAIL | Med |
| B10 | Oversized frames (maxPayload) | PASS | — |
| B11 | Malformed JSON / binary frames | PASS | — |
| B12 | Per-connection rate limit | PASS | — |
| B13 | Broadcast amplification (voice.* O(N)) | RISK | Med |
| B14 | SQL injection | PASS | — |
| B15 | CORS `*` with bearer tokens | PASS | — |
| B16 | Error messages leak | PASS | — |
| B17 | npm audit --omit=dev | PASS | — |

**B1 PASS** — onSignal (gateway.ts ~250) forwards only when both users in voice and same channelId. Tests: cross-channel dropped, not-in-voice dropped, same-channel delivered.
**B2 PASS** — `from` server-stamped from conn.user.id; client schema has no `from`; extra keys stripped. Test: spoofed from ignored.
**B3 RISK(Low)** — schemas are non-strict z.object → unknown keys stripped (safe). But no length cap on `sdp`/`candidate`; ~57 KB SDP relays fine (bounded only by 64 KB frame). Fix: add `.max()` in SignalDataSchema (protocol index.ts).
**B4 PASS** — JSON.parse+zod does not pollute Object.prototype; test injects `__proto__` in a relayed signal, `({}).polluted` undefined.
**B5 PASS** — POST /api/invites (http.ts ~104) requires bearer + is_admin; non-admin 403, no token 401. Only first user is admin.
**B6 PASS** — onVoiceJoin (gateway.ts ~215) rejects text/unknown channel with invalid_channel.
**B7 Noted(design)** — `ready` sends all users/channels/voiceStates to everyone; no channel-level read authz. Fine for one small guild; revisit for private channels/DMs.
**B8 PASS** — non-auth first msg → close 4001; auth timeout → 4004 (tested via 300 ms override).
**B9 FAIL(Med)** — no total or per-IP connection cap; WS server has only maxPayload (gateway.ts ~60). Test: 60 unauthenticated sockets all stay open. FD/memory exhaustion pre-auth. Fix: cap total + per-IP in handleUpgrade/onConnection and bound the pending set.
**B10 PASS** — wsMaxPayload 64 KB; 70 KB frame closes (≥1009). HTTP bodyLimit 64 KB.
**B11 PASS** — binary/unparseable frames: pre-auth close 4001, post-auth error invalid_message (tested). No crash.
**B12 PASS** — token bucket cap 200, 40/s (gateway.ts ~300); 400-frame burst → error rate_limited; >500 violations → close 4008.
**B13 RISK(Med)** — voice.join/update/left broadcast to every online user, not just channel members (gateway.ts). Test: bystanders not in channel still get each voice.state. 1 msg → N sends; within 40/s limit one attacker forces ~40×N frames/s via mute-flip loop. Bounded for small N. Fix: scope voice broadcasts to channel members and/or debounce voice.update / charge extra tokens.
**B14 PASS** — all db.ts queries use prepared statements with bound params. Test: `robert'); DROP TABLE users;--` — no crash, table intact.
**B15 PASS** — cors origin "*" (server.ts ~37) but auth is Authorization: Bearer, no cookies anywhere; no CSRF/credential path. Acceptable.
**B16 PASS** — errors return fixed {error,message}; no stack traces/internals; WS errors logged at debug.
**B17 PASS** — 0 vulnerabilities.

## Priority fixes
1. A6/A7 (Med): session revocation (logout/revoke-all/pw-change) + shorter access-token TTL. (db.ts, http.ts, auth.ts)
2. A11 (Med): never trustProxy:true — use hop count/proxy CIDR + Caddy overwrites XFF. (config.ts/server.ts, deploy)
3. B9 (Med): total + per-IP WS connection cap. (gateway.ts)
4. B13 (Med): scope voice broadcasts to channel members / debounce voice.update. (gateway.ts)
5. B3 (Low): `.max()` on sdp/candidate. (protocol index.ts)
6. A14 (Low): DB files 0600, data dir 0700. (db.ts)
