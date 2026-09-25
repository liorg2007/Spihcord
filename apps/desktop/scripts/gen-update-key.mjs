#!/usr/bin/env node
/**
 * Generate the Ed25519 keypair that signs auto-update manifests (security C2).
 *
 *   node apps/desktop/scripts/gen-update-key.mjs [--out <private.pem>] [--no-embed]
 *
 * - Writes the PRIVATE key (PKCS#8 PEM, mode 0600) OUTSIDE the repo, by default
 *   ~/.shpihcord/update-signing-key.pem. Refuses to overwrite an existing file.
 *   Put its full contents into the GitHub secret UPDATE_SIGNING_KEY (Settings ->
 *   Environments -> release -> secrets), keep an offline backup, then delete
 *   the local copy if you like. Never commit it.
 * - Embeds the PUBLIC key into src/main/updatePublicKey.ts (unless --no-embed),
 *   so apps built from then on only accept manifests signed by this key.
 *
 * Rotating the key: generate a new one and ship a release (signed with the OLD
 * key) whose app embeds the NEW public key; later releases use the new secret.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = resolve(outIdx >= 0 ? args[outIdx + 1] : join(homedir(), ".shpihcord", "update-signing-key.pem"));

if (out.startsWith(repoRoot + (process.platform === "win32" ? "\\" : "/"))) {
  console.error(`Refusing to write the private key inside the repository (${out}).`);
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`${out} already exists; not overwriting. Pass --out <path> for a new key.`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, privPem, { mode: 0o600 });
console.log(`Private key written to ${out}`);
console.log("Add its contents as the GitHub secret UPDATE_SIGNING_KEY (environment: release).\n");
console.log(pubPem);

if (!args.includes("--no-embed")) {
  const target = join(here, "..", "src", "main", "updatePublicKey.ts");
  const src = readFileSync(target, "utf8");
  const next = src.replace(/`-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`/, `\`${pubPem}\``);
  if (next === src) {
    console.error(`Couldn't find the PEM literal in ${target}; embed the key above by hand.`);
    process.exit(1);
  }
  writeFileSync(target, next);
  console.log(`\nEmbedded the public key in ${target}. Commit that file.`);
}
