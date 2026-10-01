import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalPath } from "../storage";
import { digestText } from "../transitions";
import { requireValue as require, canonicalJSON } from "../model";

/** Read-only, bounded, explicitly scoped checkout observation. It includes HEAD,
 * the complete index and untracked inventory, plus exact declared working bytes.
 * The coordinator must include every relevant dirty/untracked/deleted source. */
export function handoverCodeDigest(cwd: string, files: string[], excluded: string[]): string {
  const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-C", cwd, ...args], {
    encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  require(canonicalPath(git("rev-parse", "--show-toplevel").trim()) === cwd, "Open the Git repository root for native handover");
  require(files.length > 0 && files.length <= 2000 && new Set(files).size === files.length, "Declare 1–2000 unique relevant source files");
  const ignored = (p: string) => excluded.some(e => p === e || p.startsWith(e + path.sep));
  let total = 0;
  const working = [...files].sort().map(file => {
    require(path.isAbsolute(file) && file === canonicalPath(file) && file.startsWith(cwd + path.sep) && !ignored(file), "Invalid or control-file code claim");
    if (!fs.existsSync(file)) return { file, hash: null };
    const s = fs.lstatSync(file); require(s.isFile() && s.nlink === 1 && s.size <= 2 * 1024 * 1024, "Unsafe or oversized handover input");
    total += s.size; require(total <= 32 * 1024 * 1024, "Handover code capture exceeds 32 MiB");
    return { file, hash: digestText(fs.readFileSync(file).toString("base64")), mode: s.mode & 0o777 };
  });
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
    .filter(f => !ignored(path.resolve(cwd, f))).sort();
  return digestText(canonicalJSON({ cwd, head: git("rev-parse", "HEAD").trim(), index: git("ls-files", "--stage", "-z"), untracked, working }));
}
