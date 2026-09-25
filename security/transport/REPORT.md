# Transport encryption and TURN relay security audit

Scope: PLAN §2/§4.3/§8/§9. Static config audit (no Docker). Dynamic tests were localhost only.
Scripts in this folder:
- `turn-cred-check.mjs`: checks the hub's TURN credentials against coturn's REST algorithm. Run with `node --import tsx security/transport/turn-cred-check.mjs`. Result: **OK**.
- `ice-leak.cjs`: gathers candidates in a hidden, self-terminating Electron window, using the engine's `rtcConfig()` shape. Run with `npx electron security/transport/ice-leak.cjs`.

| # | Check | Result | Severity |
|---|---|---|---|
| 1a | Caddy HTTPS / HSTS / TLS versions | PASS / RISK (no HSTS) | Low |
| 1b | Hub port not public in plaintext | PASS (compose `expose`) / RISK (bare-metal) | Medium |
| 1c | Hub native TLS | RISK: not supported | Low |
| 2a | Client accepts http/ws to remote hosts | **FAIL** | High |
| 2b | Electron certificate-error handling | PASS | n/a |
| 3 | TURN REST credentials | PASS | n/a |
| 4 | coturn hardening | PASS with gaps (TLS 5349 off, no bps-capacity, weak example secret) | Medium |
| 5a | forceRelay leaks no non-relay candidates | PASS | n/a |
| 5b | Default mode exposes raw LAN, VPN and global IPv6 addresses to peers | **RISK** (by design, but undocumented) | Medium |
| 6 | Hub IP exposure / signaling rate limit | PASS | Low |

## 1. TLS to the hub
**1a. Caddyfile: PASS, with RISK.** `{$DOMAIN} { ... }` gets automatic HTTPS. Caddy redirects :80 to :443, uses TLS 1.2 and 1.3 only by default, and handles `/ws` only on the TLS site. A `ws://` connection to :80 gets a 308 redirect, and browsers or Electron won't follow that for WebSocket, so `/ws` is effectively wss-only. HSTS is **not** set. Fix:
```
{$DOMAIN} {
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	header -Server
	...
}
```
**1b. Compose: PASS.** The hub uses `expose: - "8420"` (internal network only, no `ports:`), so there's no plaintext bypass. **RISK** for bare-metal or dev runs: `config.ts` sets `host: env.HOST || "0.0.0.0"`, so running `node apps/hub` directly listens on every interface in cleartext. Fix: default `HOST` to `127.0.0.1` and document `HOST=0.0.0.0` only for use behind a proxy or on a trusted LAN. Also set `HOST=0.0.0.0` explicitly in compose.
**1c. Hub native TLS: RISK (Low).** `server.ts` calls `app.listen({port, host})` with no `https` option, so TLS always depends on a reverse proxy. Optional fix: add `TLS_CERT` and `TLS_KEY` env vars and pass `https: { cert, key }` to `Fastify({...})`.

## 2. Client accepting plaintext: FAIL (High)
- `api.ts:3` sets `DEFAULT_SERVER_URL = "http://localhost:8420"`. `normalizeServerUrl` (line 19) prepends **`http://`** to any bare host, so typing `chat.example.com` gives `http://chat.example.com`. It accepts `http:` and `ws:` for any host and shows no warning.
- The following travels in cleartext over `http://`/`ws://`:
  - `POST /api/login` with body `{"username":"...","password":"..."}`, the plaintext password (`api.ts:75-80`, which also carries `inviteCode` for register).
  - The response `{"token":"<bearer>","user":{...}}`.
  - The WS frame `{"type":"auth","token":"<bearer>","protocolVersion":3}` (`hub.ts:192`), then all chat, presence and **SDP/ICE signaling**, including the peers' IP addresses and DTLS fingerprints. A MITM who can rewrite `a=fingerprint` can also break DTLS-SRTP media confidentiality, so plaintext signaling weakens the E2E media claim too.
- Fix (in `normalizeServerUrl`):
```ts
if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = (isLocalHost(s) ? "http://" : "https://") + s;
...
if (url.protocol === "http:" && !isLocalOrPrivate(url.hostname))
  throw new ApiError("insecure_url", "Remote servers must use https://");
// isLocalOrPrivate: localhost, 127/8, ::1, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, *.local
```
  At minimum, show a red "Unencrypted connection: your password is sent in plain text" confirmation before submitting. Apply the same rule to the stored `serverUrl` in `loginWith`/session restore.

**2b. certificate-error: PASS.** There's no `certificate-error` handler, no `setCertificateVerifyProc` and no `ignore-certificate-errors` switch in `apps/desktop/src` or `packages`, so Chromium rejects bad certs by default. Keep it that way. Consider a lint or test that greps for these.

## 3. TURN credentials (`apps/hub/src/turn.ts`): PASS
- The format is `username = "<unixExpiry>:<userId>"` and `credential = base64(HMAC-SHA1(secret, username))`. This matches coturn `use-auth-secret` exactly (verified by `turn-cred-check.mjs`, which uses an independent HMAC and checks 28-char base64).
- TTL: `TURN_TTL_SECONDS` defaults to 43200 (12 h). `ice.refresh` fires at 80% of the TTL through `scheduleIceRefresh(conn)` and is sent with `this.send(conn, ...)` to that connection only, carrying `iceServersFor(config, conn.user.id)`. Credentials are per user and only go to the owner (also in `ready`, `gateway.ts:216`).
- A user can't mint credentials for others: no client message carries a userId for TURN, and the secret never leaves the hub.
- Notes (Low): 12 h is long for a leaked credential. Consider 1-4 h, since the refresh already exists. Credentials are bearer tokens: anyone with one can use the relay until it expires. That's inherent to the REST scheme; the bps and quota limits below limit the damage.

## 4. coturn (`deploy/turnserver.conf`, compose)
Present: `use-auth-secret` (no open relay), realm via `--realm=${DOMAIN}`, `fingerprint`, `stale-nonce=600`, `user-quota=12`, `total-quota=1200`, `no-multicast-peers`, `no-cli`, `no-software-attribute`, `no-tlsv1`, `no-tlsv1_1`. The full `denied-peer-ip` set covers 0/8, 10/8, 100.64/10, 127/8, **169.254/16 (includes 169.254.169.254 metadata)**, 172.16/12, 192.168/16, the test nets, multicast/reserved, ::1, NAT64, v4-mapped, fc00::/7 (ULA) and fe80::/10 (link-local). The secret is passed on the CLI from `.env` and isn't committed.

Missing or recommended:
```
# bandwidth cap per session (bytes/s), stops the relay being used as a free proxy
max-bps=1000000
bps-capacity=100000000
# no unauthenticated STUN-only abuse surface beyond binding; prevents loopback relay
no-loopback-peers        # (deprecated alias; denied 127/8 already covers it)
denied-peer-ip=::-::     # unspecified v6 address
denied-peer-ip=ff00::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff   # v6 multicast
# TURNS: enable with a cert (commented out today)
tls-listening-port=5349
cert=/certs/fullchain.pem
pkey=/certs/privkey.pem
cipher-list="ECDHE+AESGCM:ECDHE+CHACHA20"
no-dtls                   # if DTLS-TURN is not needed
no-tcp-relay              # only UDP relay is needed for WebRTC media
secure-stun               # optional: require auth for STUN binding too (breaks plain STUN use)
```
Also allow the *public* IP of the TURN host itself if hub and coturn share a host (`allowed-peer-ip=<public-ip>`), or relaying to the hub's own public ports is possible.
- **TLS on 5349: RISK (Medium).** Disabled, and `TURN_URLS` only offers `turn:` udp/tcp. On networks that allow only 443/TLS the relay fails, and TURN's TCP control traffic is unencrypted. The media stays DTLS-SRTP-protected either way. Add `turns:${DOMAIN}:5349?transport=tcp` to `TURN_URLS` once the cert is mounted (e.g. from Caddy's cert volume).
- **Secret strength: RISK (Medium).** `deploy/.env.example` contains `TURN_SECRET=change-me`, and neither the hub nor compose rejects it. An operator who copies the file unchanged gives out a guessable secret, which anyone can use to mint unlimited relay credentials. Fix in `config.ts`: `if (turnSecret && (turnSecret === "change-me" || turnSecret.length < 32)) throw new Error("TURN_SECRET too weak; use openssl rand -hex 32")`.

## 5. Forced relay and IP exposure
Run of `ice-leak.cjs` (Electron 44, Windows host, TURN/STUN unreachable at 127.0.0.1:3479):
- `iceTransportPolicy:"relay"` gave **0 candidates** from `onicecandidate` and **0 `a=candidate` lines** in the SDP. No host, srflx or mDNS candidates were produced, so none can reach the SignalingTransport, and with no relay candidates ICE can't fall back to direct. **PASS.** `voiceCall.ts:381` passes `forceRelay ? "relay" : "all"` straight through, and the engine forwards only what `onicecandidate` or the SDP yields.
- `iceTransportPolicy:"all"` (the **default**, `settings.ts:53 forceRelay:false`) gave **20 host candidates with raw IPs, and no mDNS `.local` names** (Electron doesn't obfuscate like Chrome does for web pages). Seen: LAN `192.168.1.203`, the virtual adapters `172.24.240.1`, `172.22.48.1`, `192.168.56.1` and others, the Tailscale CGNAT `100.87.127.21` and ULA `fd7a:115c:a1e0::...`, plus **two global IPv6 addresses `2a0d:6fc2:4850:7b00:...`** that identify the user's home network publicly. With STUN reachable, the public IPv4 (srflx) is also sent.
- So a peer learns every local interface address, VPN/Tailscale addresses, global IPv6 addresses, and the public IPv4 (srflx), all through hub-relayed SDP/ICE. **RISK (Medium).** P2P needs this by design, but PLAN users should be told.
- Fixes: (a) in the Settings UI, label forceRelay as "Hide my IP address from other users" and explain the default. (b) In the engine, drop `typ host` candidates for non-private addresses when not on a LAN, or filter via `RTCPeerConnection` with `app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "default_public_interface_only")` in Electron main, which removes LAN/VPN/virtual adapter host candidates while keeping srflx for P2P. (c) Consider making forceRelay the default when TURN is configured.

## 6. The hub and IPs / signaling rate limit: PASS (Low)
- The hub doesn't collect or broadcast peer IPs. `onSignal` (`gateway.ts:288`) forwards `data` opaquely, and only between two users **in the same voice channel**, which limits exposure to call partners. It doesn't need IPs. It could strip `typ host` lines, but it's opaque by design. With TLS in place the hub operator still sees the candidates, so a malicious hub operator learns all IPs (inherent).
- Rate limiting: per-connection token bucket (capacity 200, refill 40/s), disconnect after 500 violations (`gateway.ts:30-34, 323-338`). HTTP login/register: 20 per minute per IP (`http.ts:56`). `TRUST_PROXY=true` in compose makes `req.ip` the real client behind Caddy. That's fine as long as the hub is not publicly reachable (1b). There's no size cap on `rtc.signal.data` beyond the protocol schema or ws maxPayload. Verify that `maxPayload` is set on the `WebSocketServer` (Low).

## Priority fixes
1. **High**: require https/wss for non-local hosts in `normalizeServerUrl`, and default bare hosts to https.
2. **Medium**: reject weak or example `TURN_SECRET`; add `max-bps`/`bps-capacity`; enable TURNS on 5349; tell users about the default IP exposure (or apply `default_public_interface_only`).
3. **Low**: HSTS header; hub `HOST` default 127.0.0.1; shorter TURN TTL; v6 multicast/unspecified deny lines.
