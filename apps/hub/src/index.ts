import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const hub = await createServer(config);

if (hub.firstRunInvite) {
  const line = "=".repeat(60);
  console.log(
    [
      "",
      line,
      "  Shpihcord hub: no accounts yet.",
      `  First-run invite code:  ${hub.firstRunInvite}`,
      "  The first account registered becomes the admin.",
      line,
      "",
    ].join("\n"),
  );
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  hub.app.log.info(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await hub.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
