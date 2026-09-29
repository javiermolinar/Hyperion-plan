import * as fs from "node:fs";
import * as path from "node:path";
import { record } from "../model";
import { parseJSON } from "../json";
import { loadPlanSnapshot, type PlanSnapshot } from "../service";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 3000;
const MAX_DEPTH = 5;
const MAX_CANDIDATES = 30;
const EXCLUDED = new Set(["node_modules", "vendor", "dist", "build", "coverage", "test", "tests", "__tests__", "fixtures", "examples", "prototypes", "tmp", "temp"]);
export const DEMO_MARKER = "<!-- hyperion-plan-demo -->";
export interface PlanCandidate { path: string; plan_id: string; title: string; revision: number; lifecycle: string }
export interface DiscoveryResult {
  source: "project-default" | "discovery" | "disabled";
  candidates: PlanCandidate[];
  diagnostics: string[];
  truncated: boolean;
  selected?: PlanSnapshot;
}
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
function source(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Not a regular bounded plan file");
  return fs.readFileSync(file, "utf8");
}
function canonical(text: string, file: string): boolean {
  if (path.extname(file).toLowerCase() === ".md") {
    // Examples inside fenced code blocks are not canonical plan headers.
    let fence: { marker: string; length: number } | undefined;
    for (const line of text.split(/\r?\n/)) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim())
          fence = undefined;
        continue;
      }
      if (delimiter && (delimiter[1][0] !== "`" || !delimiter[2].includes("`"))) {
        fence = { marker: delimiter[1][0], length: delimiter[1].length };
        continue;
      }
      if (/^<!-- plan-companion: \{.*\} -->$/.test(line)) return true;
    }
    return false;
  }
  try {
    const data = parseJSON(text);
    return record(data) && data.format !== "plan-companion-redirect" &&
      data.schema_version === 1 && typeof data.plan_id === "string" && Array.isArray(data.steps);
  } catch { return false; }
}
function candidate(snapshot: PlanSnapshot): PlanCandidate {
  return { path: snapshot.path, plan_id: snapshot.plan.plan_id, title: snapshot.plan.title.slice(0, 160),
    revision: snapshot.plan.revision, lifecycle: snapshot.plan.lifecycle ?? "active" };
}
async function validateCandidate(file: string, root: string): Promise<PlanSnapshot> {
  if (!within(root, fs.realpathSync(file))) throw new Error("Plan resolves outside this workspace");
  // Do not follow execution-state symlinks during automatic discovery.
  if (file.toLowerCase().endsWith(".md")) {
    const state = file.slice(0, -3) + ".state.json";
    if (fs.existsSync(state)) {
      const stat = fs.lstatSync(state);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("Plan state is not a regular bounded file");
    }
  }
  // Discovery accepts canonical files, never migration aliases. Disable resolution
  // at the read boundary too, in case the file changed after the metadata check.
  const snapshot = await loadPlanSnapshot(file, { followRedirects: false });
  if (!within(root, fs.realpathSync(snapshot.path))) throw new Error("Plan resolves outside this workspace");
  return snapshot;
}

/** Bounded, read-only discovery. Ordinary Markdown is never initialized or converted. */
export async function discoverPlans(cwd: string): Promise<DiscoveryResult> {
  const root = fs.realpathSync(cwd);
  const result: DiscoveryResult = { source: "discovery", candidates: [], diagnostics: [], truncated: false };
  const configPath = path.join(root, ".pi", "hyperion-plan.json");
  if (fs.existsSync(configPath)) {
    try {
      if (!within(root, fs.realpathSync(configPath))) throw new Error("Configuration resolves outside this workspace");
      const config = parseJSON(source(configPath));
      if (!record(config) || Object.keys(config).some(key => !["default_plan", "discover"].includes(key)) ||
        (config.discover !== undefined && typeof config.discover !== "boolean") ||
        (config.default_plan !== undefined && (typeof config.default_plan !== "string" || !config.default_plan.trim())))
        throw new Error("Expected {default_plan?: string, discover?: boolean}");
      if (typeof config.default_plan === "string") {
        result.source = "project-default";
        const file = path.resolve(root, config.default_plan);
        if (!within(root, file) || !within(root, fs.realpathSync(file))) throw new Error("Default plan must be inside this workspace");
        const text = source(file);
        if (!canonical(text, file)) throw new Error("Default plan lacks canonical Hyperion metadata; conversion requires an explicit request");
        result.selected = await validateCandidate(file, root);
        result.candidates = [candidate(result.selected)];
        return result;
      }
      if (config.discover === false) return { ...result, source: "disabled" };
    } catch (error) {
      result.diagnostics.push(`Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
      // An invalid explicit default/config must never silently select a different plan.
      return result;
    }
  }
  let entries = 0, bytes = 0;
  const snapshots: PlanSnapshot[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    let children: fs.Dirent[];
    try { children = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { result.truncated = true; return; }
    for (const child of children) {
      if (++entries > MAX_ENTRIES || bytes >= MAX_TOTAL_BYTES || snapshots.length >= MAX_CANDIDATES) { result.truncated = true; return; }
      if (child.name.startsWith(".") || child.isSymbolicLink()) continue;
      const file = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (EXCLUDED.has(child.name.toLowerCase())) continue;
        if (depth >= MAX_DEPTH) { result.truncated = true; continue; }
        await walk(file, depth + 1);
      } else if (child.isFile() && /\.(md|json)$/i.test(child.name) && !/(?:-pr-notes|-review-brief|\.state)\.(md|json)$/i.test(child.name)) {
        try {
          const size = fs.statSync(file).size;
          if (size > MAX_FILE_BYTES) { result.truncated = true; continue; }
          if (bytes + size > MAX_TOTAL_BYTES) { result.truncated = true; return; }
          bytes += size;
          const text = source(file);
          if (text.includes(DEMO_MARKER) || !canonical(text, file)) continue;
          const snapshot = await validateCandidate(file, root);
          if (snapshot.plan.preamble?.includes(DEMO_MARKER)) continue;
          snapshots.push(snapshot);
        } catch (error) {
          if (result.diagnostics.length < 5) result.diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  };
  await walk(root, 0);
  result.candidates = snapshots.map(candidate);
  const active = snapshots.filter(snapshot => snapshot.plan.lifecycle !== "finished");
  if (!result.truncated && result.diagnostics.length === 0 && active.length === 1) result.selected = active[0];
  return result;
}
