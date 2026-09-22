import { defineConfig } from "vite";
import path from "node:path";

// Bundles the browser-side e2e harness (tests/e2e/page) into tests/e2e/dist.
export default defineConfig({
  root: path.resolve(__dirname, "page"),
  base: "./",
  logLevel: "warn",
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "chrome120",
    minify: false,
    sourcemap: true,
  },
});
