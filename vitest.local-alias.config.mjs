import path from "node:path";
import { defineConfig } from "vitest/config";

const ROOT = "/tmp/zuuvf-gate2";

// Local-only alias: point @getpaseo/plugin at the worktree source because
// packages/plugin has no built dist here. Never commit this file.
export default defineConfig({
  root: ROOT,
  resolve: {
    dedupe: ["zod"],
    alias: [
      {
        find: "@getpaseo/plugin/server/provider",
        replacement: path.join(ROOT, "packages/plugin/src/server/provider.ts"),
      },
      {
        find: "@getpaseo/plugin/server/usage",
        replacement: path.join(ROOT, "packages/plugin/src/server/usage.ts"),
      },
      {
        find: "@getpaseo/plugin/server",
        replacement: path.join(ROOT, "packages/plugin/src/server/index.ts"),
      },
      {
        find: /^@getpaseo\/protocol\/(.*)$/,
        replacement: path.join(ROOT, "packages/protocol/src/$1.ts"),
      },
      {
        find: "@getpaseo/plugin",
        replacement: path.join(ROOT, "packages/plugin/src/index.ts"),
      },
    ],
  },
  optimizeDeps: { exclude: ["zod"] },
  test: {
    env: { PASEO_GIT_MAX_PROCESSES_PER_SECOND: "10000" },
  },
});
