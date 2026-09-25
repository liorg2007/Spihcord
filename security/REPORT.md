# Shpihcord security review: combined report (2026-09-25)

Four areas were audited. Each has its own detailed report and scripts you can rerun:

| Area | Report | Rerun |
|---|---|---|
| Media encryption | `media/REPORT.md` | `media\run.bat` |
| Transport and TURN | `transport/REPORT.md` | `node transport/turn-cred-check.mjs`, `electron transport/ice-leak.cjs` |
| Hub auth and authorization | `hub/REPORT.md` | `hub\run.bat` (28 attack tests) |
| Electron client and supply chain | `client/REPORT.md` | `client/probe-main.mjs`, `client/read_fuses.py` |

## Bottom line
- **Encryption is solid on the wire.** All voice, screen and camera media uses DTLS 1.3 + SRTP over one bundled transport. There is no plaintext path, and the engine's SDP rewriting was fuzz-tested and never touches the security lines.
- **Main weakness: trust in the hub.** Whoever controls the hub, or a network that sees plain-http signaling, can silently man-in-the-middle calls. We proved it by decoding a victim's mic audio.
- **The desktop app is sandboxed.** The window is locked down, and a malicious hub cannot inject code. The gaps are in packaging (fuses, update signing) and a push-to-talk keylogger path.

## Fix list, ranked

### P0: High
| ID | Issue | Fix | Where |
|---|---|---|---|
| M1 | A malicious hub can MITM all media (proved by decoding audio) | TOFU-pin a long-term per-user DTLS certificate. Warn and block on mismatch. Show safety numbers. | `voiceCall.ts:374,237`, `peer.ts:163`, desktop `voice.ts` |
| M2 | A mid-call key change is accepted silently (`remote-restarted`) | Send it through the same pin check | `peer.ts:168-173`, `voiceCall.ts:478` |
| T1 | The client sends the password and token over plain http/ws to remote hosts | Default to https. Allow http only for loopback, LAN and Tailscale addresses, or after the user confirms. | desktop `api.ts:19`, `hub.ts`, `LoginScreen.tsx` |
| C1 | Electron fuses are unset: RunAsNode, NODE_OPTIONS, `--inspect`, no asar integrity | Upgrade to electron-builder 26 and set `electronFuses` | `electron-builder.yml` |
| C2 | Auto-update trusts GitHub alone: the build is unsigned and there's no `publisherName` | 2FA plus draft releases now; code signing later; optionally a signed manifest | release process, `electron-builder.yml` |

### P1: Medium
| ID | Issue | Fix |
|---|---|---|
| C3 | `ptt:record` captures the next key pressed anywhere, so it works as a keylogger | Record only while the window is focused (or use DOM `keydown`), and rate-limit `setBinding` |
| C4 | Screen capture has no user-gesture check and accepts source ids that were never listed | Require `request.userGesture` and `lastSources.has(id)` |
| H1 | No session revocation, and tokens last 90 days | Add logout, revoke-all and password change; use a shorter TTL with refresh |
| H2 | A stolen token can repeatedly kick the real user offline | Solved by H1, plus rate-limiting session replacement |
| H3 | `TRUST_PROXY` lets a spoofed X-Forwarded-For bypass the login rate limit | Set trustProxy to the hop count or Caddy's IP only |
| H4 | No cap on connections, including unauthenticated ones | Global and per-IP connection caps |
| T2 | Real IPs (LAN, Tailscale, public IPv6) are exposed to peers by default | `default_public_interface_only` IP policy, and/or relay on by default when TURN is set up; label the setting clearly |
| T3 | `TURN_SECRET=change-me` default, and weak secrets aren't rejected | The hub and `install.sh` refuse weak or default secrets (install.sh already generates one) |
| S1 | Build-time deps: 2 critical and 12 high advisories (tar, electron-builder 25, vite, vitest) | Upgrade electron-builder 26, vite/electron-vite, and vitest 3 or later |
| S2 | better-sqlite3 downloads unhashed prebuilds | `npm ci --ignore-scripts` plus an explicit rebuild, or switch to `node:sqlite` |

### P2: Low / hardening
- **Media:**
  - Pin sha-256 fingerprints and ECDSA P-256 only.
  - Optional privacy mode: CBR, no DTX, strip the `ssrc-audio-level` extension (they leak when you speak).
- **Transport:**
  - Add HSTS in the Caddyfile.
  - TURN credential TTL of 1–4 h.
  - Turn on TURNS on 5349.
  - Add coturn `max-bps` and `bps-capacity`, plus the IPv6 multicast deny lines.
  - Make the hub listen on 127.0.0.1 by default when it runs behind a proxy.
- **Hub:**
  - Minimum password length of 8 or more.
  - Stop printing the first-run invite to logs.
  - Make the DB files 0600.
  - Add `.max()` to the SDP and candidate strings.
  - Send broadcasts only to channel members.
- **Client:**
  - Remove DevTools from packaged builds on macOS.
  - Treat Linux `basic_text` safeStorage as unencrypted.
  - Drop hub frames over 4 MB and add schema limits.
  - Scope permissions by origin.
  - Serve the app from an `app://` protocol, drop `blob:` from `script-src`, and narrow `img-src`.
  - Add the frame check to the updater IPC.
  - Narrow the macOS entitlements.
- **Supply chain:**
  - Pin Docker images by digest.
  - Hub container: `read_only`, `cap_drop: ALL`, `no-new-privileges`.
  - Pin GitHub Actions to commit SHAs with minimal `permissions`. The workflows were added after this audit and need a re-check.

### Accepted / by design
- The hub sees channel membership, timing and SDP (including IPs). That is inherent to having a signaling server.
- Everyone on a hub can see all users and channels. It is a single friends' server; revisit this if private channels are added.
- A hub can hand out its own TURN servers. That's acceptable because media stays DTLS-encrypted.

## Verified PASS (with evidence)
- **Media:**
  - DTLS 1.3 and SRTP on every stream; SDES and no-fingerprint offers are rejected.
  - SDP munging fuzz tests: 20/20 across about 18,000 cases.
  - Persistent certificate pinning is feasible (same fingerprint across restarts).
- **Transport:**
  - The TURN REST credential scheme matches coturn and is per-user.
  - Forced relay leaks 0 non-relay candidates.
  - The Caddy/compose setup has no plaintext bypass, and bad certificates are rejected.
- **Hub:**
  - argon2id meets the OWASP minimum.
  - 256-bit tokens, stored as sha256 hashes only.
  - Login timing doesn't reveal whether a username exists.
  - Invites are about 50 bits and use-limited.
  - Signaling is isolated per channel and the sender id is stamped by the server.
  - Admin endpoints are enforced.
  - No SQL injection or prototype pollution.
  - 64 KB frame cap, auth timeout, and no stack traces leaked.
  - 0 runtime npm advisories.
- **Client:**
  - contextIsolation and sandbox are on, and there is no Node access in the page.
  - CSP blocks eval, inline scripts and iframes.
  - Dangerous URL schemes are refused.
  - No HTML injection from hub data, and all hub frames are validated with zod.
  - IPC checks the sender.
  - The token is encrypted at rest and never kept in localStorage.
  - The lockfile uses only registry.npmjs.org with integrity hashes.
