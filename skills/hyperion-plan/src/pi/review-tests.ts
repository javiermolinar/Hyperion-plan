import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Quiescence } from "../hosts/contracts";
import { requireValue as require } from "../model";
import { digestText } from "../transitions";
import { assertReviewSnapshotCurrent, type ReviewSnapshot } from "./review-snapshot";

/** Trusted host code only. Never construct one from a model-supplied command. */
export interface ControlledReviewTest {
  description: string;
  run: (cwd: string, signal: AbortSignal) => Promise<{ status: "passed" | "finding" | "not-verified"; evidence: string; quiescence: Quiescence;
    /** Host-selected relative output directory; dependencies/scratch remain retained
     * in the disposable workspace but are not exposed as review evidence. */
    artifact_directory?: string }>;
}
export interface ControlledTestEvidence {
  status: "passed" | "finding" | "not-verified";
  evidence: string;
  artifact_root?: string;
  files?: Record<string, string>;
}
export function assertControlledTestArtifacts(result: ControlledTestEvidence): void {
  if (!result.artifact_root) return;
  for (const [file, expected] of Object.entries(result.files ?? {})) {
    const target = path.resolve(result.artifact_root, file);
    require(target.startsWith(result.artifact_root + path.sep) && fs.lstatSync(target).isFile() && fs.realpathSync(target) === target && digestText(fs.readFileSync(target).toString("base64")) === expected, "Controlled review test artifacts drifted");
  }
}
export async function runCapturedReviewTest(snapshot: ReviewSnapshot, test: ControlledReviewTest | undefined, signal: AbortSignal): Promise<ControlledTestEvidence> {
  if (!test) return { status: "not-verified", evidence: "No vetted controlled test harness is available. Arbitrary shell/project commands are not permitted." };
  signal.throwIfAborted(); assertReviewSnapshotCurrent(snapshot);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-review-test-")));
  // Keep the captured review tree immutable; test outputs go to a separate copy.
  for (const [file, hashes] of Object.entries(snapshot.files)) if (hashes.working !== null) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(snapshot.root, "working", file), target); fs.chmodSync(target, 0o600 | ((hashes.working_mode ?? 0) & 0o111));
  }
  // A thrown/unknown harness never authorizes cleanup/reuse; preserve the copy.
  const result = await test.run(root, signal);
  require(result.quiescence.state === "verified" && result.quiescence.evidence.some(e => e.trim()), `Test writer quiescence unknown; preserved ${root}`);
  require(["passed", "finding", "not-verified"].includes(result.status) && typeof result.evidence === "string" && result.evidence.trim(), "Controlled test evidence is missing");
  assertReviewSnapshotCurrent(snapshot);
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      require(!entry.isSymbolicLink(), "Controlled test artifacts contain a symlink; inspect manually");
      if (entry.isDirectory()) walk(file);
      else {
        require(entry.isFile() && Object.keys(files).length < 2000, "Unsupported/oversized controlled test artifacts");
        bytes += fs.statSync(file).size; require(bytes <= 16 * 1024 * 1024, "Controlled test artifacts exceed limit");
        files[path.relative(root, file)] = digestText(fs.readFileSync(file).toString("base64"));
      }
    }
  };
  const artifacts = result.artifact_directory === undefined ? root : path.resolve(root, result.artifact_directory);
  require(artifacts === root || (artifacts.startsWith(root + path.sep) && fs.realpathSync(artifacts) === artifacts), "Test artifact directory must remain inside its disposable workspace");
  walk(artifacts);
  return { status: result.status, evidence: result.evidence, artifact_root: root, files };
}
