import { build } from "esbuild";
import { mkdirSync, chmodSync } from "node:fs";
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/plan.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
});
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
});
await build({
  entryPoints: ["src/browser.ts"],
  outfile: "dist/browser.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
});
chmodSync("dist/plan.cjs", 0o755);
