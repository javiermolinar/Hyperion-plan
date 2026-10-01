import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Quiescence, AssignmentResult } from "../hosts/contracts";
import type { ExecutionAuthority } from "../execution-policy";
import { requireValue as require } from "../model";
import { assertExecutionOwner } from "../handovers";
import { loadPlanSnapshot } from "../service";
import { withLock, canonicalPath } from "../storage";
import { digestText } from "../transitions";
import { readDispatchLedger, updateDispatch, setDispatchPhase, type DispatchRecord } from "./dispatch-ledger";
import { runPiAssignment, type PiAssignmentOptions } from "./runner";
import { validateReviewReport } from "./review-contract";
import { runPiReview, ReviewPreparationError, type PiReviewOptions } from "./review";

/** Foreground ownership, not a pool or scheduler. A stop is irreversible. */
export class PiAssignmentSupervisor {
  private stopped?: string;
  private active = new Map<string, { abort: AbortController; done: Promise<DispatchRecord> }>();
  private unknown = new Set<string>();
  run(options: PiAssignmentOptions): Promise<DispatchRecord> {
    require(!this.stopped, `Assignment supervisor stopped: ${this.stopped}`);
    require(this.unknown.size === 0, "Unknown supervised writers prohibit further dispatch and workspace reuse");
    const key = `${canonicalPath(options.assignment.plan_path)}\0${options.assignment.assignment_id}`;
    require(!this.active.has(key), "Assignment already active in this supervisor");
    return this.track(key, options.signal, signal => runPiAssignment({ ...options, signal }));
  }
  review(options: PiReviewOptions): Promise<DispatchRecord> {
    require(!this.stopped && this.unknown.size === 0, "Review supervisor is stopped or has unknown writers");
    const key = `${canonicalPath(options.planPath)}\0review:${options.authority().requestId}:${options.stepId ?? 'plan'}`;
    require(!this.active.has(key), "Review already active in this supervisor");
    return this.track(key, options.signal, signal => runPiReview({ ...options, signal }),
      error => error instanceof ReviewPreparationError);
  }
  private track(key: string, parent: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<DispatchRecord>,
    beforeLaunchError: (error: unknown) => boolean = () => false): Promise<DispatchRecord> {
    const abort = new AbortController();
    const signal = parent ? AbortSignal.any([parent, abort.signal]) : abort.signal;
    const done = Promise.resolve().then(() => execute(signal)).then(record => {
      if (!['settled', 'failed'].includes(record.phase) || record.result?.quiescence.state !== 'verified') this.unknown.add(key);
      return record;
    }, error => {
      // Failed input/capture preparation cannot leave a worker running. Preserve
      // conservative holds for every error after the SDK launch boundary.
      if (!beforeLaunchError(error)) this.unknown.add(key);
      throw error;
    }).finally(() => this.active.delete(key));
    this.active.set(key, { abort, done });
    // Callers must observe cleanup before a corrected/repeated request can run.
    return done;
  }
  async stop(reason: string): Promise<Quiescence> {
    this.stopped ??= reason;
    const writers = [...this.active.values()];
    for (const writer of writers) writer.abort.abort(new Error(reason));
    // Do not use an early-rejecting Promise.all: every affected assignment joins.
    await Promise.allSettled(writers.map(writer => writer.done));
    if (this.unknown.size) return { state: "unknown", reason: "Some assignments lack verified settlement; inspect their durable ledgers before workspace reuse or transfer." };
    return { state: "verified", evidence: [`Stopped foreground dispatch: ${this.stopped}`, "All supervised assignment promises settled with verified writer quiescence."] };
  }
  get activeCount(): number { return this.active.size; }
}

/** Embedding host hook; installation alone creates no session, watcher or timer. */
export function bindPiAssignmentLifecycle(pi: Pick<ExtensionAPI, "on">, supervisor: PiAssignmentSupervisor): () => void {
  const offShutdown = pi.on("session_shutdown", async () => { await supervisor.stop("session shutdown/reload"); });
  const offSwitch = pi.on("session_before_switch", async () => {
    const result = await supervisor.stop("session switch");
    return result.state === "unknown" ? { cancel: true } : undefined;
  });
  return () => { offShutdown(); offSwitch(); };
}

const fileDigest = (file: string) => fs.existsSync(file) ? digestText(fs.readFileSync(file).toString("base64")) : null;

/** Reconcile an already persisted result, never launch, resume, integrate or complete work. */
export async function recoverPiAssignment(planPath: string, assignmentId: string, authority: () => ExecutionAuthority): Promise<DispatchRecord> {
  return withLock(planPath, async () => {
    const snapshot = await loadPlanSnapshot(planPath, { followRedirects: false });
    const current = authority();
    require(current.currentRunAuthorized && current.implementationAllowed, "Explicit current recovery authority required");
    assertExecutionOwner(snapshot.plan, current.actorId);
    const record = readDispatchLedger(planPath).records.find(r => r.assignment.assignment_id === assignmentId);
    require(record, "Assignment not found; do not redispatch");
    require(record.assignment.owner.native_id === current.actorId && record.assignment.plan_id === snapshot.plan.plan_id, "Recovery owner/plan mismatch");
    // Pause/finish/new scope may forbid acceptance, but not inspection/recovery of
    // old evidence. verifyDispatch separately enforces current executable scope.
    if (record.phase === "settled" || record.phase === "failed") return record;
    require(record.handle && fs.existsSync(record.result_path), "No durable settled result; writer state remains unknown. Do not relaunch.");
    const resultFile = JSON.parse(fs.readFileSync(record.result_path, "utf8"));
    const entries = fs.readFileSync(record.handle.transcript_path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const tag = entries.find(e => e.type === "custom" && e.customType === "hyperion.assignment")?.data;
    require(entries[0]?.type === "session" && entries[0].id === record.handle.session.native_id &&
      tag?.assignment_id === assignmentId && tag.attempt_id === record.attempt_id && tag.plan_id === record.assignment.plan_id &&
      tag.request_id === record.assignment.approved_request_id && tag.step_id === record.assignment.step_id &&
      tag.scope_digest === record.assignment.scope_digest && tag.owner?.native_id === record.assignment.owner.native_id &&
      tag.wave_id === record.wave_id && JSON.stringify(tag.read_paths) === JSON.stringify(record.read_paths),
    "Recovery transcript correlation failed");
    require(resultFile.assignment_id === assignmentId && resultFile.session?.native_id === record.handle.session.native_id &&
      resultFile.session?.host === "pi" && ["succeeded", "failed", "cancelled", "interrupted"].includes(resultFile.outcome) &&
      resultFile.acceptance_verified === false && Array.isArray(resultFile.changed_paths) &&
      resultFile.changed_paths.every((file: unknown) => typeof file === "string" && record.assignment.owned_paths.includes(file)) &&
      Array.isArray(resultFile.evidence) && resultFile.evidence.every((e: unknown) => typeof e === "string") &&
      resultFile.effort?.requested === record.assignment.reasoning_effort && typeof resultFile.effort.actual === "string" &&
      resultFile.quiescence?.state === "verified" && resultFile.quiescence.evidence?.some((e: unknown) => typeof e === "string" && e.trim()) &&
      resultFile.workspace_files && Object.keys(resultFile.workspace_files).length === record.assignment.owned_paths.length &&
      record.assignment.owned_paths.every(file => Object.hasOwn(resultFile.workspace_files, file) && resultFile.workspace_files[file] === fileDigest(file)),
    "Recovery result correlation or workspace evidence failed; reconcile manually");
    const events = fs.readFileSync(record.events_path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const last = events.at(-1);
    require(last?.type === "agent_settled" && last.assignment_id === assignmentId && last.attempt_id === record.attempt_id && last.session?.native_id === record.handle.session.native_id, "No final correlated settlement event");
    if (record.review) {
      require(tag.snapshot_digest === record.review.snapshot.digest && tag.requirements_digest === record.review.requirements_digest, "Review snapshot correlation mismatch");
      validateReviewReport(resultFile.review_report, record.review);
    }
    const { worker_report: _report, acceptance_verified: _accepted, workspace_files: _files, review_report, controlled_tests, ...result } = resultFile;
    return updateDispatch(planPath, assignmentId, latest => {
      require(latest.attempt_id === record.attempt_id && latest.handle?.session.native_id === record.handle!.session.native_id, "Assignment changed during recovery");
      latest.result = result as AssignmentResult;
      if (record.review) { latest.review_report = review_report; latest.controlled_tests = controlled_tests; }
      delete latest.verification;
      latest.error = "Recovered previously persisted settled result; current-scope acceptance/integration not implied.";
      setDispatchPhase(latest, result.outcome === "succeeded" ? "settled" : "failed");
    });
  });
}
