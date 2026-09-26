# CLAUDE.md

Shpihcord: a small self-hosted Discord for friends. Text chat goes through a hub; voice, video and screen share are P2P WebRTC (TURN only as fallback). See `PLAN.md` for the full design.

## Layout
- `apps/desktop` — Electron + React client (`src/main`, `src/renderer`, `src/shared/ipc.ts`)
- `apps/hub` — Node/TS + SQLite server (auth, chat, presence, call signaling)
- `packages/call-engine` — WebRTC mesh logic, incl. DTLS identity pinning (`identity.ts`)
- `packages/protocol` — shared wire types between hub and clients
- `tests/e2e` — Electron-driven end-to-end scenarios
- `deploy/`, `security/` — hosting and security notes

## Commands
- `npm run typecheck` / `npm test` — all workspaces
- `npm run test:e2e` — builds and runs the e2e harness
- `npm run dev:hub`, `npm run dev:desktop`
- Needs Node >= 22.12 (the WSL default Node is too old — run from Windows or use a newer Node)

## Conventions
- Security matters here: peer keys are pinned TOFU-style with safety numbers; a key mismatch must block media until the user decides. Don't add paths that skip this check.
- Update signatures are verified (`apps/desktop/src/main/updateSignature.ts`) — keep it that way.
- Keep UI copy plain and friendly; explain security features in the app, not just the docs.

## Vibe
It's a hobby project for friends. Keep it small, fast and cheap to run. 🎧
