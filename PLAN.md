# Shpihcord — Design Plan

A small, self-hosted Discord-like app for a group of friends. It has text channels, peer-to-peer voice and video calls for several people, and high-quality screen sharing.

---

## 1. Goals and non-goals

**Goals**
- A desktop app (Windows first, then Linux and macOS) that friends install with a normal installer.
- Voice and video calls that go **peer to peer (P2P)**, so audio, video and screen streams never pass through a server when a direct path exists.
- Calls with **2–8 people** at once.
- **High-quality screen sharing**: up to 1440p at 60 fps or 4K at 30 fps, with system audio.
- Text channels with message history, images and file attachments, mentions and reactions.
- Cheap to run: one small VPS (about $5/month) or a friend's always-on PC.

**Non-goals (for now)**
- Public servers, discovery, or thousands of users.
- Bots, the Nitro-style extras, a mobile app (can come later; see Phase 5).
- Full end-to-end-encrypted text history (media is already encrypted in transit; see §8).

---

## 2. High-level architecture

```
 ┌──────────────────────┐        WebSocket (TLS)        ┌──────────────────────────┐
 │  Desktop client A     │◄─────────────────────────────►│        Hub server         │
 │  (Electron + React)   │   auth, text chat, presence,  │  Node/TS + SQLite         │
 └─────────┬────────────┘   call signaling (SDP/ICE)    │  - REST + WS API          │
           │                                             │  - file storage (disk/S3) │
           │  WebRTC (DTLS-SRTP), direct P2P             └──────────────────────────┘
           │  voice / camera / screen                          ▲
           ▼                                                   │
 ┌──────────────────────┐                             ┌────────┴─────────┐
 │  Desktop client B     │◄──── fallback relay ──────►│  coturn (TURN)   │
 └──────────────────────┘   only if direct P2P fails  └──────────────────┘
```

Three pieces:

1. **Client**: an Electron desktop app. It does all the media work: capture, encoding, WebRTC connections, and playback.
2. **Hub server**: small and stateful. It handles accounts, invites, text messages, presence and **signaling** (exchanging the connection offers that let peers find each other). It never touches call media.
3. **TURN server** (coturn): a relay used only when two peers can't connect directly, for example behind strict or symmetric NAT or a corporate firewall. Most home connections won't need it.

### Why a server at all?
A fully serverless setup is possible, but in practice you still need:
- a rendezvous point for peers to exchange WebRTC offers,
- somewhere to keep text history while people are offline,
- a TURN relay for the roughly 10–15% of connections that can't go direct.

The hub is small, and one Docker Compose file runs it anywhere. All **media stays P2P**, which is what makes calls cheap and low-latency.

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron** | Bundles Chromium, so WebRTC, hardware encoders, AV1/VP9/H.264 and `desktopCapturer` behave the same on every OS. Tauri is lighter, but its WebRTC depends on the system webview (weak on Linux WebKitGTK). |
| UI | React + TypeScript + Vite, Zustand for state, Tailwind | Fast to build, familiar |
| Media | Browser WebRTC API (inside Electron) | Mature, hardware-accelerated, encrypted by default |
| Noise suppression | RNNoise (WASM) or the built-in `noiseSuppression` | Discord-like "Krisp lite" |
| Hub server | Node.js + TypeScript, Fastify (REST) + `ws` (WebSocket) | Same language as the client, so shared types |
| Database | SQLite (via Drizzle ORM) | No separate DB server needed for a friend group |
| File storage | Local disk volume (optional S3/MinIO later) | Simple |
| NAT traversal | Public STUN + self-hosted **coturn** | Reliable connectivity |
| Packaging | electron-builder (NSIS `.exe`, AppImage/.deb, `.dmg`) | Real installers |
| Auto-update | electron-updater + GitHub Releases | Friends always run the same version |
| Deployment | Docker Compose (hub + coturn + Caddy for HTTPS) | One command setup |

### Repo layout (monorepo, pnpm workspaces)
```
shpihcord/
├─ apps/
│  ├─ desktop/          # Electron main + preload + React renderer
│  │  ├─ main/          # window mgmt, desktopCapturer, tray, auto-update, global PTT hotkey
│  │  ├─ preload/       # safe IPC bridge (contextIsolation on)
│  │  └─ renderer/      # React UI, WebRTC call engine
│  └─ hub/              # Fastify + ws server, SQLite, file uploads
├─ packages/
│  ├─ protocol/         # shared TS types + zod schemas for all WS/REST messages
│  └─ call-engine/      # mesh manager, bitrate control, stats (UI-agnostic)
├─ deploy/
│  ├─ docker-compose.yml
│  ├─ Caddyfile
│  └─ turnserver.conf
└─ PLAN.md
```

---

## 4. Peer-to-peer group calls

### 4.1 Topology: full mesh
Every participant keeps one `RTCPeerConnection` to every other participant.

- With N people, each client **sends** N−1 copies of its streams and **receives** N−1 streams.
- Voice (Opus at about 32–64 kbps) is cheap: 8 people cost about 0.5 Mbps up, which is fine.
- Camera video at 720p costs about 1.5 Mbps per peer, so it gets throttled automatically as the group grows (§4.4).
- Screen share is the heavy part (§5).

**Practical limits on a typical home connection (20–50 Mbps upload):**

| People | Voice | + Cameras | + One HQ screen share |
|---|---|---|---|
| 2–4 | ✅ | ✅ | ✅ 1440p60 |
| 5–6 | ✅ | ✅ (auto-reduced to 480p) | ✅ 1080p60 |
| 7–8 | ✅ | ⚠️ (360p or thumbnails) | ⚠️ 1080p30, or needs the SFU fallback |

> **Escape hatch (Phase 5):** an optional self-hosted SFU (LiveKit) that a group can enable when it regularly has 8+ people. The client's call engine hides the transport behind an interface, so switching from mesh to SFU won't change the UI.

### 4.2 Signaling flow (via the hub WebSocket)
```
A joins voice channel "general-vc"
  A → hub:  voice.join {channelId}
  hub → A:  voice.state {participants: [B, C]}
  hub → B,C: voice.peerJoined {userId: A}

For each existing peer (B, C), the NEWCOMER (A) creates the offer:
  A → hub → B: rtc.offer {sdp}
  B → hub → A: rtc.answer {sdp}
  A ⇄ hub ⇄ B: rtc.ice {candidate}   (trickle ICE)
```
- **Perfect negotiation pattern** (polite/impolite peer by comparing user IDs) makes renegotiation safe when someone starts a screen share or turns on their camera mid-call.
- The hub only forwards signaling messages between members of the same voice channel. It never inspects them.

### 4.3 ICE / NAT traversal
```ts
iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: ["turn:turn.yourdomain.com:3478", "turns:turn.yourdomain.com:5349"],
    username: <ephemeral>, credential: <HMAC> }   // coturn REST-auth, issued by hub, 12h TTL
]
```
- The hub issues **time-limited TURN credentials** (coturn `use-auth-secret`), so the relay can't be abused.
- The UI shows the connection type per peer: 🟢 Direct / 🟡 Relayed. This is useful when debugging a friend's router.

### 4.4 Audio
- Opus with `stereo=0; useinbandfec=1; usedtx=1` for voice. Music and screen audio use stereo at 128 kbps.
- Echo cancellation, AGC and noise suppression. An optional RNNoise AudioWorklet can replace the browser's suppressor.
- **Voice activity detection** drives the "speaking" ring around avatars and can gate the mic.
- **Push-to-talk** with a global hotkey registered in the Electron main process, so it works while in a game.
- Per-user volume sliders (0–200%) and local mute, using a Web Audio `GainNode` per remote stream.
- Output device selection via `setSinkId`.

### 4.5 Adaptive quality
The call engine polls `getStats()` every 2 s:
- It reads the available outgoing bitrate, packet loss and RTT for each peer.
- It sets `RTCRtpSender.setParameters({encodings:[{maxBitrate, scaleResolutionDownBy, maxFramerate}]})` for each peer, so one friend on bad Wi-Fi gets a lower-quality stream without lowering everyone else's.
- Cameras are paused automatically for peers that have the tile off-screen.

---

## 5. High-quality screen sharing

This is the main feature. Screen sharing goes on a **separate track and transceiver** from the camera, so a user can share a screen and use a camera at the same time.

### 5.1 Capture
- Electron `desktopCapturer.getSources({types:['screen','window'], thumbnailSize})` feeds a **custom picker UI** with thumbnails, like Discord's.
- Capture uses `getUserMedia` with `chromeMediaSource: 'desktop'` and the chosen source ID, or `session.setDisplayMediaRequestHandler` so the standard `getDisplayMedia()` works.
- **System audio:**
  - Windows: `audio: 'loopback'` in `setDisplayMediaRequestHandler` captures what you hear.
  - macOS: loopback requires macOS 13+ with ScreenCaptureKit (Electron ≥ 30 supports it); otherwise show a note.
  - Linux: PipeWire via the xdg-desktop-portal; audio through a PulseAudio monitor source.
  - Your own call audio has to be excluded from what gets shared, otherwise friends hear themselves echoed back. On Windows, capture the app's own voice output on a separate device or use per-process loopback exclusion (Chromium flag `--enable-features=...` / the native addon in Phase 4).

### 5.2 Quality presets (the sharer picks, like Discord)

| Preset | Resolution | FPS | Target bitrate | `contentHint` |
|---|---|---|---|---|
| Text / Code | Native (up to 4K) | 15–30 | 4–8 Mbps | `detail` / `text` |
| Balanced | 1080p | 60 | 6 Mbps | `motion` |
| Gaming | 1440p | 60 | 10–12 Mbps | `motion` |
| Source | Native | 60 | 15–20 Mbps | `motion` |

The key settings that make it look good (not the blurry default WebRTC result):
```ts
track.contentHint = preset.hint;                    // 'detail' keeps sharp text, 'motion' keeps FPS
sender.setParameters({
  degradationPreference: preset.hint === 'motion'
      ? 'maintain-framerate' : 'maintain-resolution',
  encodings: [{ maxBitrate: preset.bitrate, maxFramerate: preset.fps,
                scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high' }]
});
```
- **Codec preference** via `transceiver.setCodecPreferences()`:
  1. **AV1** if both sides support hardware encode (RTX 40xx, RX 7000, Intel Arc, Apple M3+). It gives the best quality per bit, which matters most in a mesh.
  2. **H.264 High (hardware, NVENC/AMF/QSV)**: the lowest CPU cost and the best choice for gaming.
  3. **VP9** (with `scalabilityMode: 'L1T3'`) as the software fallback.
- Chromium's default screen-share start bitrate is low. Modify the SDP with `x-google-start-bitrate` and `x-google-min-bitrate` so the stream is sharp from the first second instead of ramping up over 10 s.
- The native Chromium encoder can struggle at 4K60. Cap the "Source" preset to what `getStats().qualityLimitationReason` reports is sustainable (automatic downgrade when it reports `cpu`).

### 5.3 Bandwidth in a mesh
The sharer uploads one copy per viewer. At 10 Mbps × 4 viewers = 40 Mbps up, a typical connection won't keep up. Mitigations:
- **Opt-in watching (like Discord's "Watch Stream" button):** a peer only receives the screen track after clicking *Watch*. Until then the sharer's transceiver for that peer is `inactive`, so no bandwidth is used. In practice this is the biggest saving.
- **Per-viewer bitrate:** each viewer's copy adapts on its own (§4.5).
- **Upload budget check:** before starting, the client estimates available upload (from the stats of existing connections) and warns: *"Gaming preset for 4 viewers needs ~40 Mbps, you have ~25. Use Balanced?"*
- **Phase 5, "Relay via friend":** one friend with fast upload re-forwards the stream (a mini-SFU inside the client using insertable streams). Or enable the LiveKit SFU.

### 5.4 Viewer experience
- A stream tile appears with a **Watch** button. It can be pop-out, full-screen, or picture-in-picture.
- Viewers see live stats: resolution, FPS, bitrate, codec, and whether the connection is direct or relayed.
- A separate volume slider for stream audio.

---

## 5a. Camera video

The camera is a third kind of media next to mic audio and screen share. Each user can send a camera and a screen share at the same time.

### 5a.1 Behaviour
- **Off by default** on every join. A camera button in the voice bar turns it on or off. The OS camera light is the source of truth: turning the camera off **stops the capture track** so the light goes off. It doesn't just stop sending.
- **Sent automatically** to everyone in the channel, unlike screen share, which needs Watch. Each viewer can still pause any camera or all cameras.
- **Self-preview** is mirrored, like a mirror. Friends see it unmirrored.
- **Tiles:** a participant with the camera on shows video instead of the avatar. The speaking ring stays around the video. Muted and deafened icons are overlaid on it.
- **Stage view** (someone's screen share is focused): cameras move to a small strip below the stream at a lower quality (§5a.3).

### 5a.2 Media pipeline
- Capture with `getUserMedia({video: {deviceId, width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30}}})` and `contentHint = 'motion'`.
- The engine sends the camera on its **own transceiver and stream id**, separate from mic and screen, so the receiver can tell mic, camera and screen apart. It uses the same scheme as screen share.
- **The first time the camera is enabled**, `addTrack` runs, followed by one renegotiation.
- **Later off/on toggles** use `sender.replaceTrack(null | track)`, which needs no renegotiation. The receiver sees the track muted or unmuted, and `VoiceState.video` drives the UI immediately.
- **Switching camera device** is also a `replaceTrack` (new capture, then swap).
- **Codec order:** H.264 (hardware), then VP9, then VP8. No simulcast: in a mesh each peer connection already has its own encoder, so quality is adjusted per viewer with `setParameters`.

### 5a.3 Adaptive quality (mesh bandwidth)
The sender sets a quality cap per viewer from two inputs:

1. **Group size**, a sender-side default:

| People in call | Camera send cap (per viewer) |
|---|---|
| 2–3 | 720p30, 1.5 Mbps |
| 4–5 | 480p30, 800 kbps |
| 6–8 | 360p24, 400 kbps |

2. **The viewer's preference.** The viewer sends a signal (`{kind:'video-pref', camera:'off'|'low'|'high'}`) based on how big the tile is on their screen:
   - `high`: a big tile in the grid.
   - `low`: 180p15 at 150 kbps, for strip thumbnails while a stream is focused, or a small grid.
   - `off`: the tile is off-screen, the app is minimized, or the viewer paused that camera. The sender sets `encodings[0].active = false` for that viewer, so no bandwidth is spent.

On top of both, the same `getStats` adaptation as audio (§4.5) lowers bitrate on loss or bandwidth limits.

### 5a.4 Protocol and API changes
- `VoiceState.video: boolean`, and `voice.update { video? }`. Protocol v3.
- `SignalData` gains `{kind:'video-pref', camera:'off'|'low'|'high'}`. It is peer to peer and relayed by the hub like other signals.
- Engine additions:
  - `startCamera(deviceId?)` and `stopCamera()`
  - `setCameraDevice(id)`
  - `setCameraPreference(userId, 'off'|'low'|'high')`
  - event `remoteCamera {userId, stream|null}`
  - event `localCamera {stream|null}` for the self-preview
  - `streamStats` extended with `kind: 'screen'|'camera'`
- Desktop app:
  - camera button
  - camera picker and live preview in Settings → Voice & Video
  - video tiles
  - `IntersectionObserver` and `visibilitychange` to drive `video-pref`

### 5a.5 Testing
The e2e harness already uses Chromium's fake devices, which include a fake camera (a moving test pattern). The tests cover:
- Camera on reaches everyone at the expected cap for the group size.
- Toggling off and on causes no renegotiation.
- `video-pref: off` drops the received bytes to about 0.
- Camera and screen share can run from the same user at the same time.
- Device switching.
- Stopping the camera releases the capture track (`readyState === 'ended'`).

### 5a.6 Later
- Background blur or replacement (MediaPipe selfie segmentation in a worker) and noise-free low-light boost.

---

## 6. Text chat and the rest of the "Discord" part

All of this runs on the hub (it isn't P2P, which keeps history reliable when people are offline).

### Data model (SQLite)
```
users(id, username, display_name, avatar_url, password_hash, created_at)
servers(id, name, icon_url, owner_id)          -- "guilds"; usually just one
members(server_id, user_id, role, nickname, joined_at)
channels(id, server_id, name, type: 'text'|'voice', position, category)
messages(id, channel_id, author_id, content, reply_to, edited_at, created_at)
attachments(id, message_id, filename, mime, size, path)
reactions(message_id, user_id, emoji)
invites(code, server_id, created_by, uses_left, expires_at)
read_state(user_id, channel_id, last_read_message_id)
```
IDs use Snowflake-style time-sortable 64-bit integers, which makes pagination easy.

### Features by priority
1. Register or log in (username + password, argon2), then join with an invite link like `shpihcord://invite/abc123`.
2. Text channels with real-time messages, a typing indicator, edit/delete, and replies.
3. Markdown (bold, code blocks with syntax highlighting, spoilers), and link and image previews.
4. File and image upload (drag-and-drop, paste), with a configurable max size (e.g. 100 MB).
5. Presence (online / idle / DND / in voice) and who's in which voice channel shown in the sidebar.
6. Reactions, @mentions, unread badges, and desktop notifications.
7. DMs: a DM is a private 2-person channel, and a DM call is a voice channel with two members.
8. Roles and permissions, kept minimal: `owner`, `admin`, `member`.

### Real-time protocol (WS, JSON, zod-validated)
```
Client → Hub:  auth, msg.send, msg.edit, msg.delete, typing, presence.set,
               voice.join, voice.leave, voice.state (mute/deaf/video/screen),
               rtc.offer, rtc.answer, rtc.ice
Hub → Client:  ready (initial snapshot), msg.created/updated/deleted, typing,
               presence.update, voice.peerJoined/peerLeft/state, rtc.* (forwarded)
```
Clients reconnect with exponential backoff and resume from the last event sequence number.

---

## 7. Desktop client UI

A layout friends already know from Discord:
```
┌────┬──────────────┬─────────────────────────────────────┬──────────────┐
│ 🟣 │ # general    │  #general                           │ Online — 4   │
│    │ # memes      │  ─────────────────────────────────  │  alex        │
│ +  │ 🔊 Hangout   │  alex: anyone up for a game?        │  bob 🎮      │
│    │   🎙 alex    │  bob: yes, joining vc               │  carol       │
│    │   🎙 bob 🖥  │                                     │              │
│    │ 🔊 Gaming    │                                     │ Offline — 2  │
│    ├──────────────┤  [ message #general           ] 📎  │              │
│    │ 🎙🎧⚙ alex   │                                     │              │
└────┴──────────────┴─────────────────────────────────────┴──────────────┘
```
- **Call view:** a grid of participant tiles with a speaking indicator, and the screen share as a large focus tile with the others in a strip.
- **Voice controls:** mute, deafen, camera, share screen (opens the source picker + quality preset), disconnect.
- **Settings:** input/output devices, mic test with a level meter, PTT vs voice activity plus sensitivity, noise suppression toggle, default stream preset, hotkeys, theme.
- **Tray icon**, start minimized, launch on boot (optional).
- **Overlay** (in-game voice overlay): Phase 5, stretch goal.

---

## 8. Security and privacy

- **Media:** WebRTC always encrypts with DTLS-SRTP. With direct P2P, the hub never sees audio or video. TURN relays only forward encrypted packets and can't decrypt them.
- **Media identity (TOFU pinning + safety numbers; fixes audit M1/M2):** DTLS alone doesn't stop a malicious hub. The hub relays the SDP, so it could swap in its own `a=fingerprint` and sit in the middle.
  - Each install keeps a long-term ECDSA P-256 `RTCCertificate` in IndexedDB. It expires after 1 year and is regenerated when fewer than 30 days remain. The engine passes it as `certificates:[cert]` for every connection and hands the same object to `setConfiguration`.
  - Before any remote offer or answer is applied, the engine reads every `a=fingerprint` line. They must all be sha-256 and all agree. The `verifyFingerprint(userId, fp)` hook then checks the fingerprint against a TOFU pin keyed by server URL and userId.
  - On a mismatch, nothing is applied (no DTLS, so no media). The engine emits `identityMismatch {userId, expected, received}`.
  - The app then shows "X's security key changed — the connection may be intercepted. Compare safety numbers." with two choices:
    - **Trust new key:** re-pins the key and calls `retryPeer`.
    - **Disconnect:** leaves the call.
  - A remote restart is detected by a new fingerprint or a new `o=` session id, and it goes through the same check. A mid-call key change is therefore never accepted silently.
  - `getSafetyNumber(userId)` returns 5×5 digits from SHA-256 over the two sorted fingerprints, and both ends see the same value. The user popover shows it with "Mark as verified", which is persisted. Verified peers get a shield on their tile.
  - Limits:
    - The very first contact is trust-on-first-use.
    - A reinstall or a cleared profile shows up as a key change.
- **Optional true E2EE for calls** (Phase 5): insertable streams / SFrame with a key agreed per call. This matters only if the SFU fallback is used.
- **Transport:** hub behind Caddy with automatic HTTPS; WSS only.
- **Auth:** argon2id password hashes, short-lived JWT access token plus a refresh token stored with Electron `safeStorage` (OS keychain).
- **Electron hardening:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a strict CSP, only a whitelisted IPC surface in preload, and external links opened in the system browser.
- **Invite-only:** no public signup. The owner creates invite codes that can expire or have limited uses.
- **Uploads:** check size and MIME; serve with `Content-Disposition` and `X-Content-Type-Options: nosniff`.
- **IP privacy note:** in P2P, friends can see each other's IP addresses. That's fine among friends, but a "Force relay (hide my IP)" toggle (`iceTransportPolicy: 'relay'`) is available in settings.

---

## 9. Installation and deployment

### For the host (one person, once)
```bash
# on a VPS (Hetzner/DO ~$5) or an always-on home PC with ports forwarded
git clone https://github.com/<you>/shpihcord && cd shpihcord/deploy
cp .env.example .env         # set DOMAIN, TURN_SECRET, JWT_SECRET
docker compose up -d         # starts hub + coturn + caddy (HTTPS auto)
docker compose exec hub pnpm create-owner   # prints the first invite link
```
Ports: `443/tcp` (hub via Caddy), `3478/udp+tcp` and `5349/tcp` (TURN), and `49160-49200/udp` (TURN relay range).

*No VPS?* Run the hub on your own PC and expose it with Tailscale Funnel or Cloudflare Tunnel. TURN is then optional if everyone is on Tailscale.

### For friends
1. Download `Shpihcord-Setup-x.y.z.exe` (or the AppImage/.dmg) from GitHub Releases.
2. Open it, enter the server address (or just click the invite link), and create an account.
3. Auto-update keeps everyone on the same version after that.

Code signing: without a certificate, Windows SmartScreen shows a warning ("More info → Run anyway"). That's acceptable for friends. An Azure Trusted Signing cert (about $10/month) can come later if needed.

---

## 10. Roadmap

### Phase 0: Skeleton (week 1)
- Monorepo, Electron + React + Vite boilerplate, and the hub with Fastify + WS + SQLite.
- Shared `protocol` package with zod schemas.
- Docker Compose with Caddy.

### Phase 1: Text chat MVP (weeks 2–3)
- Auth, invites, a single server, text channels, real-time messages, history pagination.
- Presence, typing indicators, attachments.
- ✅ *Milestone: friends can install and chat.*

### Phase 2: P2P voice (weeks 4–5)
- Voice channels, the mesh call engine, perfect negotiation, TURN with ephemeral credentials.
- Mute/deafen, per-user volume, VAD speaking indicators, PTT global hotkey, device selection.
- A connection-quality indicator (direct/relayed, ping, loss).
- ✅ *Milestone: stable 5-person voice call across different home networks.*

### Phase 3: Screen share + video (weeks 6–8)
- Custom source picker, quality presets, codec preference (AV1 → H.264 HW → VP9).
- Bitrate and SDP tuning, and the opt-in *Watch Stream* flow.
- System audio capture (Windows first).
- Camera video with adaptive per-peer quality (see §5a).
- Stream stats overlay, pop-out/fullscreen viewer.
- ✅ *Milestone: 1440p60 game stream to 3 friends that looks sharp and smooth.*

### Phase 4: Polish (weeks 9–10)
- Installers for all 3 OSes, auto-update, tray, notifications, unread badges.
- DMs and DM calls, reactions, replies, markdown, link previews.
- RNNoise suppression, exclusion of your own call audio from shared system audio.
- Reconnect and ICE restart when the network changes (Wi-Fi ↔ Ethernet).

### Phase 5: Stretch
- Optional LiveKit SFU mode for large groups or low-upload hosts.
- E2EE via insertable streams.
- In-game overlay, soundboard, custom emoji.
- Mobile client (React Native + react-native-webrtc, sharing the `protocol` package).

---

## 11. Testing strategy

- **Unit:** protocol schemas, permission checks, message and pagination logic (Vitest).
- **Integration:** hub WS flows with multiple simulated clients.
- **Media:** Playwright plus Chromium `--use-fake-device-for-media-stream` spins up 4–6 headless clients in one call and checks that every pair reaches `connected` and that audio levels are > 0.
- **Network conditions:** run clients behind `tc netem` (latency, loss, bandwidth caps) in Docker to tune adaptive bitrate. Test the TURN path by blocking UDP between containers.
- **Real-world:** weekly session with friends; record `getStats()` dumps to a debug log (Settings → "Export call diagnostics").

---

## 12. Main risks and mitigations

| Risk | Mitigation |
|---|---|
| The sharer's upload isn't enough for HQ streams to many viewers | Opt-in watching, per-viewer bitrate, upload warning, SFU fallback |
| Some friends can't connect directly (CGNAT, strict NAT) | coturn TURN relay with TCP/TLS on 443 as a last resort |
| Mesh breaks down above about 8 people | Documented limit; LiveKit SFU mode in Phase 5 |
| System-audio capture differs by OS | Windows first (easiest); feature-flag macOS and Linux |
| Echo of call audio inside the shared system audio | Per-process loopback exclusion / a separate output device, plus AEC |
| Unsigned installer warnings | Acceptable for friends; optional code signing later |
| Keeping clients in sync | Auto-update plus a protocol version check on WS `auth` (hub rejects outdated clients with a friendly "please update") |
