# Shpihcord hub. Build from the REPO ROOT (workspace packages are needed):
#   docker build -f deploy/Dockerfile -t shpihcord-hub .
# (docker compose in this folder already sets context: ..)

FROM node:22-slim AS deps
# Toolchain in case better-sqlite3 / argon2 have no prebuilt binary for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
# Every workspace manifest is copied so the lockfile stays consistent,
# but only the hub's dependency tree (+ root devDeps such as tsx) is installed.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/call-engine/package.json packages/call-engine/
COPY apps/hub/package.json apps/hub/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --workspace @shpihcord/hub --include-workspace-root

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8420 \
    DATA_DIR=/data \
    TRUST_PROXY=true \
    npm_config_update_notifier=false
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/hub/package.json apps/hub/tsconfig.json ./apps/hub/
COPY apps/hub/src ./apps/hub/src
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/apps/hub
VOLUME ["/data"]
EXPOSE 8420
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8420)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run node directly (not via npm) so SIGTERM reaches the process for a graceful shutdown.
CMD ["node", "--import", "tsx", "src/index.ts"]
