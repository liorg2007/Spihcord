/**
 * Signed update manifests (security C2).
 *
 * The release workflow signs each electron-updater manifest (latest.yml,
 * latest-mac.yml, latest-linux[-arm64].yml) with an Ed25519 key kept as a
 * GitHub secret and uploads `<manifest>.sig` next to it. After electron-updater
 * has downloaded an update (and checked it against the unsigned manifest's
 * sha512), we additionally:
 *   1. download the manifest and its .sig from the release of that version,
 *   2. verify the signature with the public key compiled into this app,
 *   3. require the signed manifest to name the same version and to list the
 *      sha512 of the file that was actually downloaded (hashed again here).
 * Only then may the update be installed. So publishing a release (a leaked
 * GitHub token, a compromised account) is not enough to push code to clients:
 * the attacker also needs the signing key, which never touches GitHub releases.
 *
 * Pure helpers here (unit-tested); the network + events live in updater.ts.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";

/** electron-updater's manifest file name for this platform/arch (default channel). */
export function manifestName(platform: string, arch: string): string {
  if (platform === "win32") return "latest.yml";
  if (platform === "darwin") return "latest-mac.yml";
  return arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

export function verifyManifestSignature(manifest: Buffer, signatureB64: string, publicKeyPem: string): boolean {
  try {
    const sig = Buffer.from(signatureB64.trim(), "base64");
    if (sig.length !== 64) return false;
    return verify(null, manifest, createPublicKey(publicKeyPem), sig);
  } catch {
    return false;
  }
}

function yamlScalar(v: string): string {
  const t = v.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
}

/**
 * True if the (already signature-checked) manifest is for `version` and lists
 * `sha512` (base64, electron-builder's format) for one of its files. Parsed
 * line-wise: electron-builder writes flat `key: value` lines.
 */
export function manifestCovers(manifest: string, version: string, sha512: string): boolean {
  let versionOk = false;
  let hashOk = false;
  for (const line of manifest.split(/\r?\n/)) {
    const m = /^\s*(?:-\s+)?(version|sha512)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = yamlScalar(m[2]!);
    if (m[1] === "version" && !/^\s/.test(line) && value === version) versionOk = true;
    if (m[1] === "sha512" && value === sha512) hashOk = true;
  }
  return versionOk && hashOk;
}

export function sha512File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha512");
    createReadStream(path)
      .on("data", (chunk) => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("base64")));
  });
}
