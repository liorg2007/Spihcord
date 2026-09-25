# Shpihcord

A small, self-hosted Discord-like app for a group of friends: text channels,
peer-to-peer voice, camera video and high-quality screen sharing. One person
runs a tiny **hub** server. Everyone else installs the **desktop app**.

- Desktop app: Electron (Windows, macOS, Linux) and updates itself automatically.
- Hub: Node.js + SQLite, shipped as a Docker image (`ghcr.io/liorg2007/shpihcord-hub`).
- Voice and video go directly between friends (P2P mesh). The hub only relays signaling and chat.

---

## For friends

1. Open the latest release: **<https://github.com/liorg2007/Spihcord/releases/latest>**
2. Download the file for your computer:

   | You have | Download |
   |---|---|
   | Windows | `Shpihcord-Setup-x.y.z.exe` |
   | Mac with Apple silicon (M1 or newer) | `Shpihcord-x.y.z-arm64.dmg` |
   | Intel Mac | `Shpihcord-x.y.z-x64.dmg` |
   | Linux (any distro) | `Shpihcord-x.y.z-x86_64.AppImage` |
   | Debian / Ubuntu | `Shpihcord-x.y.z-amd64.deb` |

3. Install and open it. Enter the **server address** and **invite code** your host
   sent you, then create your account.
4. Allow microphone access when asked (and camera or screen recording if you use them).

After that the app updates itself. When a new version has downloaded it
installs the next time you quit, or right away if you pick "restart".

### Windows: "Windows protected your PC"
The installer isn't code-signed yet, so SmartScreen warns about it. Click
**More info**, then **Run anyway**. It installs for your user only and doesn't need admin rights.

### macOS: "cannot be opened because it is from an unidentified developer"
Builds are not signed with an Apple Developer ID yet. The first time only:

1. Drag Shpihcord into **Applications**.
2. In Applications, **right-click (or Control-click) Shpihcord, then choose Open**, then click **Open** in the dialog.
   - On macOS 15 (Sequoia) or newer: try to open it once, then go to
     **System Settings > Privacy & Security**, scroll down and click **Open Anyway**.
   - If macOS says the app "is damaged", run this in Terminal:
     `xattr -dr com.apple.quarantine /Applications/Shpihcord.app`
3. To share your screen, allow Shpihcord in **System Settings > Privacy & Security > Screen Recording**, then restart the app.

Unsigned Mac builds can't update themselves. The app shows a "new version available"
link instead, and you download the new `.dmg` the same way.

### Linux
AppImage:
```bash
chmod +x Shpihcord-*.AppImage
./Shpihcord-*.AppImage
```
If it complains about FUSE, install `libfuse2` (Ubuntu 22.04+: `sudo apt install libfuse2t64`, or
`libfuse2` on older releases). The AppImage updates itself.

Debian/Ubuntu: `sudo apt install ./Shpihcord-*.deb`.

---

## For the host

You need one always-on machine that your friends can reach.

### Option A: a Linux VPS (recommended, about $5/month)

1. Rent a small VPS (Hetzner, DigitalOcean, and so on) and point a domain's DNS **A record** at its IP.
2. Run this on the VPS:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/liorg2007/Spihcord/main/deploy/install.sh | sudo bash
   ```

   It installs Docker if needed, asks for your domain, generates secrets, starts
   the hub with automatic HTTPS (Caddy) and a TURN relay (coturn), and then prints
   the **server address** and an **invite code** to send your friends.
3. Open these ports in your provider's firewall: `80/tcp`, `443/tcp+udp`,
   `3478/tcp+udp`, `49160-49200/udp`.

Update the hub with `cd /opt/shpihcord && docker compose pull && docker compose up -d`.
Create more invites with `docker compose exec hub npm run create-invite -- --uses 5 --days 7`.
For the details (manual setup, backups, TURNS), see [deploy/README.md](deploy/README.md).

### Option B: your own PC (Windows, macOS or Linux)

Good for trying things out, or when everyone is on the same VPN.

1. Install [Node.js 22.12+](https://nodejs.org/) and [Git](https://git-scm.com/).
2. Run:

   ```bash
   git clone https://github.com/liorg2007/Spihcord.git shpihcord
   cd shpihcord
   npm install
   npm run hub
   ```

   The hub listens on port **8420**, stores its data in `apps/hub/data`, and
   prints a first-run invite code. More invites: `npm run hub:invite -- --uses 5 --days 7`.
   The hub runs only while this terminal is open.
3. Let your friends reach it. Pick one:
   - **Tailscale (easiest, no port forwarding):** install [Tailscale](https://tailscale.com/)
     on your PC and invite your friends to your tailnet (or share the machine with them).
     They use `http://<your-pc-name>:8420` (or its `100.x.y.z` address) as the server address.
     To make it public over HTTPS without them joining, run `tailscale funnel 8420`
     and share the `https://<pc>.<tailnet>.ts.net` address.
   - **Cloudflare Tunnel:** `cloudflared tunnel --url http://localhost:8420` gives you a public HTTPS address.
   - **Port forwarding:** forward TCP 8420 on your router to this PC and allow it in the
     Windows firewall. Friends use `http://<your-public-ip>:8420`. This isn't encrypted,
     so prefer one of the options above.

   Without a TURN server, calls between some networks (strict NAT, mobile hotspots)
   may fail to connect. If that happens, a VPS (option A) or Tailscale fixes it.

---

## For developers

Requirements: **Node.js >= 22.12** and npm 10+.

```bash
npm install
npm run dev:hub        # hub on http://localhost:8420 (auto-reload)
npm run dev:desktop    # Electron app with hot reload
```

| Command | What |
|---|---|
| `npm run typecheck` | TypeScript across all workspaces |
| `npm test` | Unit tests (vitest) |
| `npm run test:e2e` | End-to-end call tests in hidden Electron windows |
| `npm run dist` | Build an installer for the current OS into `apps/desktop/release/<version>/` |
| `npm run icons -w @shpihcord/desktop` | Regenerate icons from `apps/desktop/build/icon.svg` |

Layout: `apps/desktop` (Electron), `apps/hub` (server), `packages/protocol`
(shared zod schemas), `packages/call-engine` (WebRTC), `deploy/` (Docker, Caddy, coturn).
See [PLAN.md](PLAN.md) for the design.

### Cutting a release

1. Bump the version in `apps/desktop/package.json` (CI also sets it from the tag).
2. Tag and push:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. The **Release** workflow builds Windows, macOS and Linux installers, uploads them to a
   **draft** GitHub Release, and pushes `ghcr.io/liorg2007/shpihcord-hub:0.2.0` and `:latest`.
4. Check the draft on GitHub and click **Publish release**. Installed apps pick it up
   within 6 hours, or on their next start.

#### Release security (do this once)

Anyone who can publish a GitHub Release can otherwise push code to every installed app, so:

1. **2FA:** turn on two-factor authentication for every account with write access
   (Settings → Password and authentication), and require it for the organisation if there is one.
2. **Branch protection:** Settings → Branches → add a rule (or ruleset) for `main`: require a pull
   request and passing **CI** checks, block force pushes and deletion. Add a tag ruleset for
   `v*` so that only maintainers can create release tags.
3. **Protected `release` environment:** Settings → Environments → **New environment** `release`:
   - **Required reviewers:** yourself (every release run waits for your approval);
   - **Deployment branches and tags:** "Selected" → tag pattern `v*`;
   - add the environment secret **`UPDATE_SIGNING_KEY`** (below) and the signing secrets from the table.
   The desktop release job only runs in this environment, and it only creates **draft** releases.
4. **Update-signing key:** `node apps/desktop/scripts/gen-update-key.mjs` creates an Ed25519 keypair.
   It writes the private key to `~/.shpihcord/update-signing-key.pem`, outside the repo, and embeds the
   public key in `apps/desktop/src/main/updatePublicKey.ts` (commit that file). Paste the whole PEM
   file into the `UPDATE_SIGNING_KEY` secret and keep an offline backup. The release job signs every
   `latest*.yml` update manifest and uploads a `.sig` next to it. The app installs an update only
   if that signature verifies with the embedded key and the signed manifest lists the SHA-512 of the
   downloaded file. If you lose the key, users must install the next version by hand.
   Never commit the private key.

Optional environment secrets, used for code signing when they are set (once a Windows
certificate exists, also set `win.signtoolOptions.publisherName` in `electron-builder.yml`):

| Secret | Purpose |
|---|---|
| `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD` | Apple "Developer ID Application" certificate (base64 .p12) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization |
| `WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD` | Windows code-signing certificate |

Without them, builds are still produced, but they're unsigned.
