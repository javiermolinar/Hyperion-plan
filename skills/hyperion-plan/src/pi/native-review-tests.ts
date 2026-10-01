import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ControlledReviewTest } from "./review-tests";
import { runReviewCommand } from "./review-process";
import { resolveReviewResources } from "./review-resources";

import { legacyReviewConfig as CONFIG, readReviewResources, validateResource, type ResourceKey, type ReviewResources } from "./review-config";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const slash = (p: string) => p.split(path.sep).join("/");
export interface NativeReviewSuites { tests: Record<string, ControlledReviewTest>; required: string[]; setupProblems: string[]; resources: ResourceKey[]; resolvedResources: ReviewResources }
interface Suite { id: string; description: string; args: string[]; browser?: boolean }

/** Fixed native presets, not repository-discovered command strings. Review
 * authority includes execution of this project's captured tests as trusted local
 * code. HOME/env/dependencies are isolated; this is NOT an OS/network sandbox. */
export function nativeReviewTests(source: string, files: string[]): NativeReviewSuites {
  const tests: Record<string, ControlledReviewTest> = Object.create(null);
  const setupProblems: string[] = [], resources = new Set<ResourceKey>();
  let configured: ReviewResources = {};
  try { configured = readReviewResources(source); } catch (e) { setupProblems.push(String(e)); }
  const packages = files.filter(f => path.basename(f) === "package.json" && !f.split("/").some(p => ["tests", "fixtures", "docs", "node_modules"].includes(p)));
  for (const pkg of packages) {
    const relative = path.posix.dirname(pkg), prefix = relative === "." ? "" : relative + "/";
    const testDir = path.join(source, prefix, "tests");
    if (!fs.existsSync(testDir)) continue;
    const testFiles = fs.readdirSync(testDir).filter(f => /^[^/]+\.test\.[cm]?js$/.test(f)).map(f => prefix + "tests/" + f).sort();
    if (!testFiles.length) continue;
    let metadata: { name?: string };
    try { metadata = JSON.parse(fs.readFileSync(path.join(source, pkg), "utf8")); } catch { continue; }
    const suites: Suite[] = [{ id: "node", description: "Node regression and offline SDK tests (captured tests/*.test.{js,cjs,mjs})", args: ["--test", ...testFiles.map(f => f.slice(prefix.length))] }];
    if (fs.existsSync(path.join(source, prefix, "tsconfig.json"))) suites.unshift({ id: "typecheck", description: "Strict TypeScript check; no emit", args: ["node_modules/typescript/bin/tsc", "--noEmit"] });
    // These are fixed Hyperion entry points, not package.json scripts. Source
    // package identity alone grants no authority: canonical review admission and
    // current user permission are enforced before any callback can execute.
    if (metadata.name === "hyperion-plan") {
      for (const [id, entry, description] of [
        ["build", "build/build.mjs", "Rebuild captured Hyperion bundles"],
        ["browser", "tests/browser/run.cjs", "Existing simulated-Codex browser regression suites"],
        ["terminal-execution", "tests/pi/terminal-execution.cjs", "Installed Pi terminal wave/review/effort fixture (offline provider)"],
        ["terminal-handover", "tests/pi/terminal-handover.cjs", "Installed Pi terminal handover fixture (offline provider)"],
      ]) if (fs.existsSync(path.join(source, prefix, entry))) suites.push({ id, args: [entry], description, browser: id !== "build" });
    }
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(source, prefix, "package-lock.json"), "utf8"));
      const installed = JSON.parse(fs.readFileSync(path.join(source, prefix, "node_modules/.package-lock.json"), "utf8"));
      for (const [name, entry] of Object.entries(lock.packages ?? {}) as [string, any][]) {
        if (!name || entry.optional && !installed.packages?.[name]) continue;
        if (!installed.packages?.[name] || entry.version !== installed.packages[name].version || entry.integrity !== installed.packages[name].integrity) throw new Error("installed lock differs");
      }
    } catch { setupProblems.push(`${relative}: matching package-lock.json and installed dependencies required; installs need separate permission`); }
    if (suites.some(s => s.id === "typecheck") && !fs.existsSync(path.join(source, prefix, "node_modules/typescript/bin/tsc"))) setupProblems.push(`${relative}: installed TypeScript compiler missing`);
    if (suites.some(s => s.id.startsWith("terminal-")) && !(process.env.PATH ?? "").split(path.delimiter).some(dir => {
      try { const file = path.join(dir, "ttyd"); fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
    })) setupProblems.push("ttyd: terminal test runtime missing from PATH; installation requires separate permission");
    for (const suite of suites) {
      if (suite.browser) {
        resources.add("PLAYWRIGHT_MODULE"); resources.add("CHROMIUM_EXECUTABLE");
        if (suite.id === "browser") resources.add("VISUALIZE_ASSETS");
      }
      const id = `${relative}:${suite.id}`;
      tests[id] = { description: suite.description, run: (cwd, signal) => executeSuite(source, cwd, prefix, pkg, files, suite, signal, configured) };
    }
  }
  configured = resolveReviewResources(source, packages, configured, [...resources]);
  for (const key of resources) {
    const problem = validateResource(key, configured[key]);
    if (problem) setupProblems.push(problem);
  }
  return { tests, required: Object.keys(tests), setupProblems, resources: [...resources], resolvedResources: configured };
}

/** Include the resource-only config if present, never a script/command config. */
export function nativeReviewFiles(source: string, files: string[]): string[] {
  files = [...new Set(files)];
  if (files.some(f => !f || path.isAbsolute(f) || /[\\\\\x00-\x1f\x7f]/.test(f) || f.split("/").some(p => !p || p === "." || p === ".."))) throw new Error("Native review paths must be repository-relative source files");
  return fs.existsSync(path.join(source, CONFIG)) && !files.includes(CONFIG) ? [...files, CONFIG] : files;
}

// Clone dependencies, including internal relative symlinks, with no install or
// shared writable mount. Reject links outside the installed tree. Hash both
// trees afterward to reject a concurrent install/drift during the copy.
async function treeDigest(root: string, signal: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  async function walk(dir: string) {
    for (const name of (await fsp.readdir(dir)).sort()) {
      signal.throwIfAborted();
      const full = path.join(dir, name), stat = await fsp.lstat(full), relative = slash(path.relative(root, full));
      digest.update(JSON.stringify([relative, stat.mode & 0o777]));
      if (stat.isSymbolicLink()) {
        const target = await fsp.realpath(full);
        if (!target.startsWith(root + path.sep)) throw new Error(`External dependency symlink: ${relative}`);
        digest.update(await fsp.readlink(full));
      } else if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) digest.update(hash(await fsp.readFile(full)));
      else throw new Error(`Unsupported dependency entry: ${relative}`);
    }
  }
  await walk(root); return digest.digest("hex");
}
async function copyDependencies(from: string, to: string, signal: AbortSignal): Promise<string> {
  const source = await fsp.realpath(from);
  await treeDigest(source, signal); // validate links before any copying
  await fsp.cp(source, to, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
    filter: () => { signal.throwIfAborted(); return true; } });
  const copied = await treeDigest(to, signal);
  if (copied !== await treeDigest(source, signal)) throw new Error("Installed dependencies changed while cloning");
  return copied;
}

async function executeSuite(source: string, root: string, prefix: string, pkg: string, files: string[], suite: Suite, signal: AbortSignal, configured: ReviewResources) {
  const artifact = ".hyperion-test-results", outputs = path.join(root, artifact);
  fs.mkdirSync(outputs, { recursive: true });
  const quiet = { state: "verified" as const, evidence: ["No suite process launched; preparation is awaited and uses no subprocesses."] };
  const unavailable = (reason: string) => {
    fs.writeFileSync(path.join(outputs, "unavailable.txt"), reason + "\n");
    return { status: "not-verified" as const, evidence: reason, quiescence: quiet, artifact_directory: artifact };
  };
  const cwd = path.join(root, prefix), dependencyPath = path.join(source, prefix, "node_modules");
  // Captures may be intentionally scoped. Do not silently run a partial suite.
  if (!fs.existsSync(path.join(source, prefix, "tests"))) return unavailable("Source test directory disappeared before execution.");
  const sourceTests = fs.readdirSync(path.join(source, prefix, "tests")).filter(f => /\.test\.[cm]?js$/.test(f)).sort();
  const missing = sourceTests.filter(f => !files.includes(prefix + "tests/" + f));
  if (missing.length) return unavailable(`Capture is missing test files: ${missing.join(", ")}. Recapture before review; no partial-suite pass.`);
  const entry = suite.id === "typecheck" ? "tsconfig.json" : suite.id === "node" ? undefined : suite.args[0];
  if (entry && !files.includes(prefix + entry)) return unavailable(`Capture is missing ${prefix + entry}; no suite executed.`);
  if (!files.includes(prefix + "package-lock.json")) return unavailable(`Capture must include ${prefix}package-lock.json for dependency provenance.`);
  let dependencyDigest: string;
  const resourceDigests: Record<string, string> = Object.create(null);
  const runtime = path.join(root, ".hyperion-test-runtime"), temp = path.join(runtime, "tmp"), home = path.join(runtime, "home");
  fs.mkdirSync(temp, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp,
    LANG: "en_US.UTF-8", PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PI_OFFLINE: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", HYPERION_REVIEW_SUITE: "1" };
  try {
    signal.throwIfAborted();
    if (hash(fs.readFileSync(path.join(source, pkg))) !== hash(fs.readFileSync(path.join(root, pkg))) ||
        hash(fs.readFileSync(path.join(source, prefix, "package-lock.json"))) !== hash(fs.readFileSync(path.join(cwd, "package-lock.json")))) return unavailable("Dependency package/lockfile drifted since capture.");
    const capturedLock = JSON.parse(fs.readFileSync(path.join(cwd, "package-lock.json"), "utf8"));
    const installedLock = JSON.parse(fs.readFileSync(path.join(dependencyPath, ".package-lock.json"), "utf8"));
    for (const [name, entry] of Object.entries(capturedLock.packages ?? {}) as [string, any][]) {
      if (!name || entry.optional && !installedLock.packages?.[name]) continue;
      const installed = installedLock.packages?.[name];
      if (!installed || entry.version !== installed.version || entry.integrity !== installed.integrity) return unavailable(`Installed dependencies do not match captured lockfile: ${name}. Install separately; reviews never install dependencies.`);
    }
    dependencyDigest = await copyDependencies(dependencyPath, path.join(cwd, "node_modules"), signal);
    if (suite.browser) {
      for (const key of (suite.id === "browser" ? ["PLAYWRIGHT_MODULE", "CHROMIUM_EXECUTABLE", "VISUALIZE_ASSETS"] : ["PLAYWRIGHT_MODULE", "CHROMIUM_EXECUTABLE"]) as ResourceKey[]) {
        const value = configured[key];
        const problem = validateResource(key, value);
        if (problem || !value) return unavailable(`${problem}. This suite could not run; source review can continue.`);
        if (key === "CHROMIUM_EXECUTABLE") {
          env[key] = value; resourceDigests[key] = hash(fs.readFileSync(value));
        } else {
          const copy = path.join(runtime, key.toLowerCase());
          resourceDigests[key] = await copyDependencies(value, copy, signal); env[key] = copy;
        }
      }
      // Chromium is an external host runtime, not a writable dependency mount.
      // Its bytes are identified; we make no OS isolation claim.
    }
  } catch (e) { return unavailable(`Suite preparation unavailable: ${e instanceof Error ? e.message : String(e)}`); }
  const provenance = { suite: suite.id, command: [process.execPath, ...suite.args], cwd, node: process.version,
    lockfile_sha256: hash(fs.readFileSync(path.join(cwd, "package-lock.json"))), dependency_tree_sha256: dependencyDigest,
    source_resources: configured,
    resources: { PLAYWRIGHT_MODULE: env.PLAYWRIGHT_MODULE, CHROMIUM_EXECUTABLE: env.CHROMIUM_EXECUTABLE, VISUALIZE_ASSETS: env.VISUALIZE_ASSETS }, resource_sha256: resourceDigests,
    limitation: "Trusted local test code; isolated writable copy/HOME/dependencies, not an OS or network sandbox. Scripted SDK/terminal providers do not prove live-model routing." };
  fs.writeFileSync(path.join(outputs, "provenance.json"), JSON.stringify(provenance, null, 2));
  const result = await runReviewCommand({ executable: process.execPath, args: suite.args, cwd, env, timeoutMs: 300_000, log: path.join(outputs, "suite.log") }, signal);
  if (suite.id === "build" && result.status === "passed") {
    const drift = files.filter(f => f.startsWith(prefix + "dist/") && fs.existsSync(path.join(root, f)) && hash(fs.readFileSync(path.join(root, f))) !== hash(fs.readFileSync(path.join(source, f))));
    if (drift.length) { result.status = "finding"; result.evidence += `; shipped bundles differ from captured rebuild: ${drift.join(", ")}`; }
  }
  fs.writeFileSync(path.join(outputs, "result.json"), JSON.stringify(result, null, 2));
  // Keep unknown-writer workspaces intact. After verified settlement remove only
  // cloned dependency/resource inputs; retain all generated scratch evidence.
  // Publish bounded logs/provenance, plus terminal screenshots/result summaries.
  if (result.quiescence.state === "verified") {
    for (const input of [path.join(cwd, "node_modules"), path.join(runtime, "playwright_module"), path.join(runtime, "visualize_assets")]) fs.rmSync(input, { recursive: true, force: true });
    let bytes = 0;
    for (const dir of fs.readdirSync(temp)) {
      if (!dir.startsWith("hyperion-terminal-")) continue;
      const full = path.join(temp, dir);
      if (!fs.lstatSync(full).isDirectory()) continue;
      for (const file of fs.readdirSync(full)) {
        const p = path.join(full, file), stat = fs.lstatSync(p);
        if (!stat.isFile() || !/\.(png|txt|json|log)$/.test(file) || bytes + stat.size > 8 * 1024 * 1024) continue;
        const dest = path.join(outputs, dir, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(p, dest); bytes += stat.size;
      }
    }
  }
  return { ...result, evidence: `${result.evidence}; suite ${suite.id}; dependencies ${dependencyDigest}; retained workspace ${root}. See provenance.json and result.json.`, artifact_directory: artifact };
}
