import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { validateResource, type ResourceKey, type ReviewResources } from "./review-config";

// Inspect only conventional tool/cache locations. Never run a package, install,
// read credentials, recursively crawl HOME, or persist inferred configuration.
function directories(root: string): string[] {
  let dir: fs.Dir | undefined;
  const found: string[] = [];
  try {
    dir = fs.opendirSync(root);
    for (let i = 0; i < 128; i++) {
      const entry = dir.readSync();
      if (!entry) break;
      if (entry.isDirectory() && !entry.name.startsWith(".")) found.push(entry.name);
    }
  } catch { /* Missing/inaccessible caches are ordinary misses. */ }
  finally { dir?.closeSync(); }
  return found.sort((a, b) => b.localeCompare(a, "en", { numeric: true })).map(name => path.join(root, name));
}

export function resolveReviewResources(
  source: string, packages: string[], configured: ReviewResources, required: ResourceKey[],
  options: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): ReviewResources {
  const home = options.home ?? os.homedir(), env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolved = { ...configured };
  const absolute = (value: string | undefined, fallback: string) => value && path.isAbsolute(value) ? value : fallback;
  for (const key of required) {
    // Explicit environment overrides stay authoritative, including invalid ones.
    // A stale saved/cache path, however, must not force another user interaction.
    if (env[key] !== undefined) { resolved[key] = env[key]; continue; }
    if (!validateResource(key, resolved[key])) continue;
    const candidates: string[] = [];
    if (key === "PLAYWRIGHT_MODULE") {
      for (const pkg of packages) {
        try {
          const require = createRequire(path.resolve(source, pkg));
          candidates.push(path.dirname(require.resolve("playwright-core/package.json")));
        } catch { /* This package has no installed Playwright. */ }
      }
      const pi = absolute(env.PI_CODING_AGENT_DIR, path.join(home, ".pi", "agent"));
      for (const root of [path.dirname(pi), pi]) {
        for (const dir of [root, ...directories(root)]) candidates.push(path.join(dir, "node_modules", "playwright-core"));
      }
    } else if (key === "VISUALIZE_ASSETS") {
      const codex = absolute(env.CODEX_HOME, path.join(home, ".codex"));
      const roots = directories(path.join(codex, "plugins", "cache")).map(dir => path.join(dir, "visualize"));
      const previous = configured[key];
      if (previous && path.isAbsolute(previous) && previous.endsWith(path.join("skills", "visualize", "assets")))
        roots.unshift(path.resolve(previous, "../../../.."));
      for (const root of roots) for (const version of directories(root))
        candidates.push(path.join(version, "skills", "visualize", "assets"));
    } else {
      for (const dir of (env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir)))
        for (const name of ["chromium", "chromium-browser", "google-chrome"]) candidates.push(path.join(dir, name));
      if (platform === "darwin") for (const root of ["/Applications", path.join(home, "Applications")])
        for (const name of ["Chromium", "Google Chrome"]) candidates.push(path.join(root, `${name}.app`, "Contents", "MacOS", name));
      const cache = absolute(env.XDG_CACHE_HOME, path.join(home, ".cache"));
      const browserCaches = [absolute(env.PLAYWRIGHT_BROWSERS_PATH, path.join(platform === "darwin" ? path.join(home, "Library", "Caches") : cache, "ms-playwright")),
        path.join(cache, "rod", "browser")];
      for (const root of browserCaches) for (const version of directories(root).filter(dir => /^chromium[-_]\d+$/.test(path.basename(dir)))) {
        candidates.push(path.join(version, "Chromium.app", "Contents", "MacOS", "Chromium"));
        for (const dir of ["chrome-linux", "chrome-linux64", "chrome-mac", "chrome-mac-arm64", "chrome-mac-x64"])
          candidates.push(path.join(version, dir, dir.startsWith("chrome-mac") ? "Chromium.app/Contents/MacOS/Chromium" : "chrome"));
      }
    }
    const found = candidates.find(candidate => {
      if (validateResource(key, candidate)) return false;
      if (key !== "PLAYWRIGHT_MODULE") return true;
      try { return JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")).name === "playwright-core"; }
      catch { return false; }
    });
    if (found) resolved[key] = found;
  }
  return resolved;
}
