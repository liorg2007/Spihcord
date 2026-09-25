#!/usr/bin/env node
/**
 * Sign electron-updater manifests (latest.yml, latest-mac.yml, latest-linux*.yml)
 * with Ed25519 (security C2). For each <file> writes <file>.sig containing the
 * base64 signature over the file's exact bytes.
 *
 *   UPDATE_SIGNING_KEY="<PKCS#8 PEM>" node apps/desktop/scripts/sign-update-manifests.mjs <file>...
 *   node apps/desktop/scripts/sign-update-manifests.mjs --verify <file>...   (uses the embedded public key)
 *
 * Signing also verifies against the public key embedded in the app
 * (src/main/updatePublicKey.ts) and fails if the secret doesn't match it, so a
 * wrong secret can't produce a release that every client would reject.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const embeddedSrc = readFileSync(join(here, "..", "src", "main", "updatePublicKey.ts"), "utf8");
const embeddedPem = /`(-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----)`/.exec(embeddedSrc)?.[1];
if (!embeddedPem) {
  console.error("No public key found in src/main/updatePublicKey.ts");
  process.exit(1);
}
const embedded = createPublicKey(embeddedPem);

const args = process.argv.slice(2);
const verifyOnly = args[0] === "--verify";
const files = verifyOnly ? args.slice(1) : args;
if (!files.length) {
  console.error("usage: sign-update-manifests.mjs [--verify] <latest*.yml>...");
  process.exit(2);
}

let failed = false;
if (verifyOnly) {
  for (const f of files) {
    const ok = verify(null, readFileSync(f), embedded, Buffer.from(readFileSync(`${f}.sig`, "utf8").trim(), "base64"));
    console.log(`${ok ? "OK  " : "BAD "} ${f}`);
    failed ||= !ok;
  }
  process.exit(failed ? 1 : 0);
}

const pem = process.env.UPDATE_SIGNING_KEY;
if (!pem) {
  console.error("UPDATE_SIGNING_KEY is not set");
  process.exit(1);
}
const key = createPrivateKey(pem.replace(/\\n/g, "\n"));
if (key.asymmetricKeyType !== "ed25519") {
  console.error(`UPDATE_SIGNING_KEY must be an Ed25519 key (got ${key.asymmetricKeyType})`);
  process.exit(1);
}
for (const f of files) {
  const data = readFileSync(f);
  const sig = sign(null, data, key);
  if (!verify(null, data, embedded, sig)) {
    console.error("UPDATE_SIGNING_KEY does not match the public key embedded in the app (src/main/updatePublicKey.ts).");
    process.exit(1);
  }
  writeFileSync(`${f}.sig`, sig.toString("base64") + "\n");
  console.log(`signed ${f}`);
}
