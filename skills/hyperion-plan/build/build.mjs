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
await build({
  entryPoints: ["src/pi/extension.ts"],
  outfile: "dist/hyperion-plan-pi.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox", "proper-lockfile"],
  banner: {
    js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));',
  },
  sourcemap: false,
});
// Opt-in coordinator API, not an auto-loaded extension or model-callable tool.
await build({
  entryPoints: ["src/pi/runner.ts"],
  outfile: "dist/pi-runner.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["@earendil-works/pi-coding-agent", "proper-lockfile"],
  banner: {
    js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));',
  },
});
// Session-free handover bookkeeping foundation; no SDK or native navigation.
await build({
  entryPoints: ["src/pi/handover-journal.ts"],
  outfile: "dist/pi-handover-journal.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["proper-lockfile"],
  banner: {
    js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));',
  },
});
await build({
  entryPoints: ["src/pi/handover-navigation.ts"],
  outfile: "dist/pi-handover-navigation.js",
  bundle: true, platform: "node", target: "node22", format: "esm",
  external: ["proper-lockfile"],
  banner: { js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));' },
});
await build({
  entryPoints: ["src/pi/handover-readiness.ts"], outfile: "dist/pi-handover-readiness.js",
  bundle: true, platform: "node", target: "node22", format: "esm",
  external: ["@earendil-works/pi-coding-agent", "proper-lockfile"],
  banner: { js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));' },
});
chmodSync("dist/plan.cjs", 0o755);
