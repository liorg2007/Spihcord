// Generates app + tray icons from build/icon.svg.
// Usage: npm run icons -w @shpihcord/desktop  (outputs are committed; rerun after editing the SVG)
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, "build");
const svg = readFileSync(join(build, "icon.svg"));
const png = (size, src = svg) => sharp(src, { density: 384 }).resize(size, size).png().toBuffer();

// 1024 master (electron-builder also uses this for Linux icons).
writeFileSync(join(build, "icon.png"), await png(1024));

// Windows .ico: 16..256.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(join(build, "icon.ico"), await pngToIco(await Promise.all(icoSizes.map((s) => png(s)))));

// macOS .icns with PNG-encoded entries (supported since 10.7).
const icnsTypes = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]];
const chunks = [];
for (const [type, size] of icnsTypes) {
  const data = await png(size);
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(data.length + 8, 4);
  chunks.push(head, data);
}
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(body.length + 8, 4);
writeFileSync(join(build, "icon.icns"), Buffer.concat([header, body]));

// Window + tray icons: the bubble without the tile, cropped tight so it reads at 16-22px.
const trayDir = join(root, "resources");
mkdirSync(trayDir, { recursive: true });
const traySvg = Buffer.from(
  svg.toString()
    .replace(/<rect x="100"[^>]*\/>/, "")
    .replace('viewBox="0 0 1024 1024"', 'viewBox="195 200 624 624"'),
);
for (const [name, size] of [["icon.png", 256], ["tray.png", 32], ["tray@2x.png", 64], ["tray-16.png", 16], ["tray-22.png", 22]]) {
  writeFileSync(join(trayDir, name), await png(size, traySvg));
}
console.log("icons written to build/ and resources/");
