# Deploying the Shpihcord hub

Runs three containers: **hub** (accounts, presence, voice signaling), **caddy**
(automatic HTTPS, proxies `/api` and `/ws` to the hub) and **coturn** (TURN relay
for peers that can't connect directly).

## Host setup

1. A Linux box with Docker + the compose plugin, and a DNS record (`A`/`AAAA`)
   for your domain pointing at it.
2. Open these ports (cloud firewall **and** `ufw`/router):

   | Port            | Proto    | What                                  |
   |-----------------|----------|---------------------------------------|
   | 80              | tcp      | Caddy (ACME challenge, redirect)      |
   | 443             | tcp+udp  | Caddy: HTTPS / WSS (udp = HTTP/3)     |
   | 3478            | udp+tcp  | TURN/STUN                             |
   | 49160-49200     | udp      | TURN relay range                      |
   | 5349            | tcp      | TURNS (only if you enable it, below)  |

3. Configure and start:

   ```bash
   git clone <repo> shpihcord && cd shpihcord/deploy
   cp .env.example .env
   # edit .env: DOMAIN=chat.example.com, TURN_SECRET=$(openssl rand -hex 32)
   docker compose up -d --build
   docker compose logs hub      # shows the first-run invite code
   ```

4. Register the first account with that invite code in the desktop app
   (server address: `https://<DOMAIN>`). The first account becomes admin.

## Invites

```bash
docker compose exec hub npm run create-invite -- --uses 5 --days 7   # --days 0 = never expires
```

Admins can also create invites from the app (`POST /api/invites`).

## Notes

- Data (SQLite) lives in the `hub_data` volume. Back it up with
  `docker compose cp hub:/data ./backup`.
- If the host is behind NAT (home PC, AWS/GCP), set `external-ip=` in
  `turnserver.conf`, and forward the ports above to the machine.
- coturn refuses to relay to private/LAN ranges (see `denied-peer-ip` in
  `turnserver.conf`), so it can't be used to reach your home network.
- Optional TURNS on 5349: provide a cert/key readable by coturn (e.g. mount
  certbot's `live/<domain>` dir to `/certs`), uncomment the TLS lines in
  `turnserver.conf`, and add `turns:<DOMAIN>:5349?transport=tcp` to `TURN_URLS`
  in `docker-compose.yml`.
- No VPS? Run the hub on your own PC (`npm run start -w @shpihcord/hub`, port 8420)
  and expose it with Tailscale Funnel or Cloudflare Tunnel. TURN is then optional.
