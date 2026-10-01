import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";

export const resourceKeys = ["PLAYWRIGHT_MODULE", "CHROMIUM_EXECUTABLE", "VISUALIZE_ASSETS"] as const;
export type ResourceKey = typeof resourceKeys[number];
export type ReviewResources = Partial<Record<ResourceKey, string>>;
export const legacyReviewConfig = ".pi/hyperion-review.json";
export function reviewConfigPath(source: string): string {
  const configured = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const agent = path.resolve(configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured);
  const id = createHash("sha256").update(fs.realpathSync(source)).digest("hex");
  return path.join(agent, "hyperion", "review", id + ".json");
}
export function readReviewResources(source: string): ReviewResources {
  const resources: ReviewResources = {};
  for (const file of [path.join(source, legacyReviewConfig), reviewConfigPath(source)]) {
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Invalid resource configuration: ${file}`);
    // Backward compatibility: unknown keys never become executable commands.
    for (const key of resourceKeys) if (Object.hasOwn(data, key)) resources[key] = data[key];
  }
  for (const key of resourceKeys) if (process.env[key] !== undefined) resources[key] = process.env[key];
  return resources;
}
export function validateResource(key: ResourceKey, value: unknown): string | undefined {
  if (typeof value !== "string" || !path.isAbsolute(value)) return `${key}: expected an absolute resource path`;
  try {
    const stat = fs.statSync(value);
    if (key === "CHROMIUM_EXECUTABLE") {
      if (!stat.isFile()) return `${key}: expected an executable file`;
      fs.accessSync(value, fs.constants.X_OK);
    } else {
      if (!stat.isDirectory()) return `${key}: expected a directory`;
      const entries = key === "PLAYWRIGHT_MODULE" ? ["package.json"] : ["visualize.html", "visualize.css"];
      for (const entry of entries) if (!fs.statSync(path.join(value, entry)).isFile()) return `${key}: ${entry} missing`;
    }
  } catch { return `${key}: resource is missing or inaccessible`; }
  return undefined;
}
export function saveReviewResources(source: string, resources: ReviewResources): string {
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) throw new Error("Expected resource paths");
  for (const [key, value] of Object.entries(resources)) {
    if (!resourceKeys.includes(key as ResourceKey)) throw new Error(`Unsupported resource: ${key}`);
    const problem = validateResource(key as ResourceKey, value);
    if (problem) throw new Error(problem);
  }
  const file = reviewConfigPath(source), temp = file + "." + randomUUID() + ".tmp";
  const relative = path.relative(fs.realpathSync(source), file);
  if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw new Error("Review resource configuration must be outside the repository; choose an external PI_CODING_AGENT_DIR");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temp, JSON.stringify(resources, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return file;
}
