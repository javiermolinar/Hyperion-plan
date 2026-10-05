import { build } from "esbuild";
import { mkdirSync, chmodSync } from "node:fs";
mkdirSync("dist", { recursive: true });
for (const [entry, outfile] of [["cli", "plan"], ["index", "index"]]) {
  await build({
    entryPoints: [`src/${entry}.ts`], outfile: `dist/${outfile}.cjs`,
    bundle: true, platform: "node", target: "node22", format: "cjs",
    ...(entry === "cli" ? { banner: { js: "#!/usr/bin/env node" } } : {}),
  });
}
await build({
  entryPoints: ["src/browser.ts"], outfile: "dist/browser.js",
  bundle: true, platform: "browser", target: "es2022", format: "iife",
});
await build({
  entryPoints: ["src/pi/extension.ts"], outfile: "dist/hyperion-plan-pi.js",
  bundle: true, platform: "node", target: "node22", format: "esm",
  external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox", "proper-lockfile"],
  banner: { js: 'import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirnameFromFile } from "node:path"; const __dirname = __dirnameFromFile(__fileURLToPath(import.meta.url));' },
});
chmodSync("dist/plan.cjs", 0o755);
