// koffi 3 ships its native binary in per-platform optional packages
// (@koromix/koffi-<os>-<arch>) and npm installs only the host's one. When
// cross-building (e.g. macOS arm64 runner -> x64 app, Linux x64 -> arm64),
// fetch the other arches' packages so electron-builder can bundle them.
// uiohook-napi already bundles prebuilds for every OS/arch.
//
// Usage: node apps/desktop/scripts/fetch-native-prebuilds.mjs darwin-x64 darwin-arm64
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// koffi's "exports" hides package.json, so walk up to find node_modules/koffi.
let koffiDir = null;
for (let dir = join(here, ".."); ; dir = dirname(dir)) {
  if (existsSync(join(dir, "node_modules", "koffi", "package.json"))) {
    koffiDir = join(dir, "node_modules", "koffi");
    break;
  }
  if (dirname(dir) === dir) throw new Error("koffi is not installed");
}
const version = JSON.parse(readFileSync(join(koffiDir, "package.json"), "utf8")).version;
const modulesDir = dirname(koffiDir); // the node_modules that holds koffi
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

for (const target of process.argv.slice(2)) {
  const name = `koffi-${target}`;
  const dest = join(modulesDir, "@koromix", name);
  if (existsSync(join(dest, "package.json"))) {
    console.log(`@koromix/${name} already present`);
    continue;
  }
  const tmp = mkdtempSync(join(tmpdir(), "koffi-"));
  const out = execFileSync(npm, ["pack", `@koromix/${name}@${version}`, "--pack-destination", tmp, "--silent"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  }).trim().split(/\r?\n/).pop();
  mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", join(tmp, out), "-C", dest, "--strip-components=1"]);
  console.log(`fetched @koromix/${name}@${version}`);
}
