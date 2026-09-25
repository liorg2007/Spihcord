import { defineConfig } from "vitest/config";
import path from "node:path";

// Root is the repo root so workspace resolution (@shpihcord/*) works.
export default defineConfig({
  root: path.resolve(__dirname, "../.."),
  test: {
    include: ["security/hub/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
