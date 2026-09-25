#!/usr/bin/env bash
# Shpihcord hub installer for a Linux VPS (Debian/Ubuntu/Fedora/...).
#
#   curl -fsSL https://raw.githubusercontent.com/liorg2007/Spihcord/main/deploy/install.sh | sudo bash
#
# Installs Docker if missing, asks for your domain, writes .env with fresh
# secrets, starts hub + caddy (HTTPS) + coturn, and prints the first invite.
# Re-running it is safe: an existing .env is kept.
set -euo pipefail

REPO_RAW="${SHPIHCORD_RAW:-https://raw.githubusercontent.com/liorg2007/Spihcord/main}"
INSTALL_DIR="${SHPIHCORD_DIR:-/opt/shpihcord}"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (e.g. with sudo)"
# Reading answers works even when the script is piped into bash.
exec 3</dev/tty || die "no terminal to ask questions on; set DOMAIN=... and run again"

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing (install docker-compose-plugin)"
systemctl enable --now docker >/dev/null 2>&1 || true

# 2. Files: use this checkout's deploy/ if we're inside one, else download.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
if [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/Caddyfile" ]; then
  INSTALL_DIR="$SCRIPT_DIR"
else
  mkdir -p "$INSTALL_DIR"
  for f in docker-compose.yml Caddyfile turnserver.conf; do
    curl -fsSL "$REPO_RAW/deploy/$f" -o "$INSTALL_DIR/$f"
  done
fi
cd "$INSTALL_DIR"
say "Using $INSTALL_DIR"

# 3. .env
if [ ! -f .env ]; then
  DOMAIN="${DOMAIN:-}"
  while [ -z "$DOMAIN" ]; do
    printf 'Domain for the hub (DNS A record must point here), e.g. chat.example.com: '
    read -r DOMAIN <&3
  done
  PUBLIC_IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || true)"
  RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
  if [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
    say "Warning: $DOMAIN resolves to '${RESOLVED:-nothing}', this server is $PUBLIC_IP. HTTPS will fail until DNS is fixed."
  fi
  umask 077
  cat > .env <<ENV
DOMAIN=$DOMAIN
TURN_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
# HUB_TAG=latest
ENV
  say "Wrote .env"
else
  say "Keeping existing .env"
fi

# 4. Firewall (only if ufw is active)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Opening firewall ports (ufw)"
  ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp
  ufw allow 3478/tcp; ufw allow 3478/udp; ufw allow 49160:49200/udp
fi

# 5. Start
say "Starting containers"
docker compose pull --ignore-pull-failures || true
docker compose up -d

# 6. Invite
say "Waiting for the hub"
INVITE=""
for _ in $(seq 1 30); do
  INVITE="$(docker compose logs hub 2>/dev/null | sed -n 's/.*First-run invite code:[[:space:]]*\([^[:space:]]*\).*/\1/p' | tail -1)"
  [ -n "$INVITE" ] && break
  sleep 2
done
if [ -z "$INVITE" ]; then
  # Not a first run (users exist): mint a fresh invite instead.
  INVITE="$(docker compose exec -T hub npm run -s create-invite -- --uses 5 --days 7 2>/dev/null | sed -n 's/^Invite code: \([^ ]*\).*/\1/p')"
fi

DOMAIN_NOW="$(sed -n 's/^DOMAIN=//p' .env)"
echo
say "Shpihcord hub is running."
echo "   Server address:  https://$DOMAIN_NOW"
echo "   Invite code:     ${INVITE:-<see: docker compose -f $INSTALL_DIR/docker-compose.yml logs hub>}"
echo
echo "   Send your friends the installer link and these two values:"
echo "   https://github.com/liorg2007/Spihcord/releases/latest"
echo
echo "   Make sure these ports are open in your cloud provider's firewall:"
echo "   80/tcp, 443/tcp+udp, 3478/tcp+udp, 49160-49200/udp"
echo "   More invites:  cd $INSTALL_DIR && docker compose exec hub npm run create-invite -- --uses 5 --days 7"
