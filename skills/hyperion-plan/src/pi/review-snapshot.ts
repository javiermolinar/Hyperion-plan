import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { requireValue as require } from "../model";
import { digestText } from "../transitions";
import { atomicWrite, canonicalPath } from "../storage";

export interface ReviewSnapshot {
  source: string;
  root: string;
  head: string;
  files: Record<string, { working: string | null; baseline: string | null; index: string | null; working_mode: number | null; baseline_mode: string | null; index_mode: string | null }>;
  digest: string;
}
const git = (cwd: string, args: string[]) => execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", ...args], { cwd, timeout: 5000, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
function relativeFile(file: string): void {
  require(file.length > 0 && !/[\x00-\x1f\x7f\\]/.test(file) && !path.isAbsolute(file) && !file.split(/[\\/]/).some(p => !p || p === "." || p === ".." || [".git", "node_modules", ".hyperion-dispatch", ".plan-history"].includes(p)) && !file.endsWith(".jsonl"), "Review paths must be explicit source files, not sessions, dependencies or control artifacts");
}
function mode(source: string, head: string | null, file: string): string | null {
  const entries = git(source, head ? ["ls-tree", "-z", head, "--", file] : ["ls-files", "--stage", "-z", "--", file]).toString().split("\0").filter(Boolean);
  require(entries.length <= 1, "Unmerged index is not a supported review snapshot");
  if (!entries.length) return null;
  require(head ? /^\d+ blob /.test(entries[0]) : /^\d+ [a-f0-9]+ 0\t/.test(entries[0]), "Review capture requires a blob and a resolved index");
  return entries[0].split(" ")[0];
}
function blob(source: string, ref: string, present: boolean): Buffer | null {
  if (!present) return null;
  const data = git(source, ["show", ref]);
  require(data.length <= 2 * 1024 * 1024, "Review Git blob exceeds 2 MiB capture limit");
  return data;
}
function workingMode(source: string, file: string): number | null {
  return fs.existsSync(path.join(source, file)) ? fs.lstatSync(path.join(source, file)).mode & 0o777 : null;
}
function bytes(source: string, file: string): Buffer | null {
  const full = path.join(source, file);
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return null;
  require(canonicalPath(full) === full && stat.isFile(), "Review capture rejects symlinks and non-regular files");
  require(fs.statSync(full).size <= 2 * 1024 * 1024, "Review file exceeds 2 MiB capture limit");
  return fs.readFileSync(full);
}
const hash = (data: Buffer | null) => data === null ? null : digestText(data.toString("base64"));

/** Caller drains all known writers before capture. No Git/worktree mutation. */
export function captureReviewSnapshot(sourcePath: string, destination: string, paths: string[]): ReviewSnapshot {
  const source = canonicalPath(sourcePath), root = canonicalPath(destination);
  require(git(source, ["rev-parse", "--show-prefix"]).toString().trim() === "", "Review source must be the Git repository root");
  require(paths.length > 0 && paths.length <= 2000 && new Set(paths).size === paths.length, "Supply 1-2000 unique relevant review files");
  paths.forEach(relativeFile);
  require(!fs.existsSync(root), "Review snapshot already exists; inspect it rather than recapture/relaunch");
  const head = git(source, ["rev-parse", "HEAD"]).toString().trim();
  const temp = `${root}.capture-${randomUUID()}`;
  const files: ReviewSnapshot["files"] = Object.create(null);
  let size = 0;
  try {
    fs.mkdirSync(temp, { recursive: true });
    for (const file of [...paths].sort()) {
      const baselineMode = mode(source, head, file), indexMode = mode(source, null, file);
      const content = { working: bytes(source, file), baseline: blob(source, `${head}:${file}`, baselineMode !== null), index: blob(source, `:${file}`, indexMode !== null) };
      require(Object.values(content).some(v => v !== null), `Review file does not exist in worktree, index or baseline: ${file}`);
      files[file] = { working: hash(content.working), baseline: hash(content.baseline), index: hash(content.index), working_mode: workingMode(source, file), baseline_mode: baselineMode, index_mode: indexMode };
      for (const [kind, data] of Object.entries(content)) if (data !== null) {
        size += data.length;
        require(size <= 16 * 1024 * 1024, "Review capture exceeds 16 MiB limit");
        const target = path.join(temp, kind, file);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, { mode: 0o400 });
      }
    }
    const snapshot: ReviewSnapshot = { source, root, head, files, digest: digestText(JSON.stringify({ head, files })) };
    assertReviewSnapshotCurrent(snapshot, false);
    atomicWrite(path.join(temp, "manifest.json"), snapshot);
    fs.mkdirSync(path.dirname(root), { recursive: true }); fs.renameSync(temp, root);
    return snapshot;
  } finally { if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true }); }
}
export function assertReviewSnapshotCurrent(snapshot: ReviewSnapshot, checkCapture = true): void {
  if (checkCapture) require(JSON.stringify(JSON.parse(fs.readFileSync(path.join(snapshot.root, "manifest.json"), "utf8"))) === JSON.stringify(snapshot), "Captured review manifest drifted");
  require(git(snapshot.source, ["rev-parse", "HEAD"]).toString().trim() === snapshot.head, "Review baseline drifted");
  require(digestText(JSON.stringify({ head: snapshot.head, files: snapshot.files })) === snapshot.digest, "Review manifest digest mismatch");
  for (const [file, expected] of Object.entries(snapshot.files)) {
    relativeFile(file);
    require(hash(bytes(snapshot.source, file)) === expected.working && hash(blob(snapshot.source, `:${file}`, mode(snapshot.source, null, file) !== null)) === expected.index, "Review source/index drifted; reconcile before accepting the report");
    require(workingMode(snapshot.source, file) === expected.working_mode && mode(snapshot.source, null, file) === expected.index_mode, "Review source/index mode drifted");
    if (checkCapture) for (const kind of ["working", "baseline", "index"] as const) {
      require(hash(bytes(snapshot.root, path.join(kind, file))) === expected[kind], "Captured review files drifted");
    }
  }
}
