/**
 * Usage: npm run create-invite -w @shpihcord/hub -- [--uses N] [--days D]
 * (--days 0 = never expires). Uses DATA_DIR like the server; safe to run while it is up (WAL).
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { Store } from "../db.js";

const { values } = parseArgs({
  options: {
    uses: { type: "string", default: "1" },
    days: { type: "string", default: "7" },
  },
});

const uses = Number(values.uses);
const days = Number(values.days);
if (!Number.isInteger(uses) || uses < 1 || !Number.isFinite(days) || days < 0) {
  console.error("Invalid --uses / --days");
  process.exit(1);
}

const config = loadConfig();
const store = new Store(config.dataDir);
try {
  const invite = store.createInvite({ uses, expiresInMs: days === 0 ? null : days * 24 * 3600_000 });
  const expires = invite.expires_at ? new Date(invite.expires_at).toISOString() : "never";
  console.log(`Invite code: ${invite.code}  (uses: ${invite.uses_left}, expires: ${expires})`);
} finally {
  store.close();
}
