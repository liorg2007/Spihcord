import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { manifestCovers, manifestName, verifyManifestSignature } from "../updateSignature";
import { UPDATE_PUBLIC_KEY_PEM } from "../updatePublicKey";

const MANIFEST = `version: 0.2.0
files:
  - url: Shpihcord-Setup-0.2.0.exe
    sha512: AAAAhash==
    size: 100
path: Shpihcord-Setup-0.2.0.exe
sha512: AAAAhash==
releaseDate: '2026-09-25T00:00:00.000Z'
`;

describe("update manifest signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const data = Buffer.from(MANIFEST);
  const sig = sign(null, data, privateKey).toString("base64");

  it("accepts a valid signature", () => {
    expect(verifyManifestSignature(data, sig, pub)).toBe(true);
  });
  it("rejects a tampered manifest, a wrong key, or junk", () => {
    expect(verifyManifestSignature(Buffer.from(MANIFEST.replace("AAAAhash", "BBBBhash")), sig, pub)).toBe(false);
    expect(verifyManifestSignature(data, sig, UPDATE_PUBLIC_KEY_PEM)).toBe(false);
    expect(verifyManifestSignature(data, "", pub)).toBe(false);
    expect(verifyManifestSignature(data, "not base64!!", pub)).toBe(false);
  });
  it("the embedded key is a valid Ed25519 key", () => {
    expect(UPDATE_PUBLIC_KEY_PEM).toMatch(/^-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/);
  });
});

describe("manifestCovers", () => {
  it("requires the same version and the downloaded file's sha512", () => {
    expect(manifestCovers(MANIFEST, "0.2.0", "AAAAhash==")).toBe(true);
    expect(manifestCovers(MANIFEST, "0.3.0", "AAAAhash==")).toBe(false);
    expect(manifestCovers(MANIFEST, "0.2.0", "other==")).toBe(false);
  });
});

describe("manifestName", () => {
  it("matches electron-updater's per-platform file names", () => {
    expect(manifestName("win32", "x64")).toBe("latest.yml");
    expect(manifestName("darwin", "arm64")).toBe("latest-mac.yml");
    expect(manifestName("linux", "x64")).toBe("latest-linux.yml");
    expect(manifestName("linux", "arm64")).toBe("latest-linux-arm64.yml");
  });
});
