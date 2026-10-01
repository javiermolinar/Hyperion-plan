import * as fs from "node:fs";
import * as path from "node:path";
import { requireValue as require } from "../model";
import { stepFingerprint } from "../transitions";
import { loadPlanSnapshot } from "../service";
import { withLock, canonicalPath } from "../storage";
import { reviewBrief } from "../exports";
import type { ExecutionAuthority } from "../execution-policy";
import { assertReviewAllowed, independentReviewScope, reviewRequirementsDigest, type ReviewContext } from "./review-contract";
import { captureReviewSnapshot, assertReviewSnapshotCurrent, type ReviewSnapshot } from "./review-snapshot";
import { assignmentDirectory, readDispatchLedger, type DispatchRecord } from "./dispatch-ledger";
import { runPiAssignment, type PiAssignmentOptions } from "./runner";
export { captureReviewSnapshot, assertReviewSnapshotCurrent } from "./review-snapshot";

export interface PiReviewOptions {
  planPath: string;
  intent: ReviewContext["intent"];
  stepId?: string;
  source: string;
  files: string[];
  attemptId: string;
  authority: () => ExecutionAuthority;
  modelRuntime: PiAssignmentOptions["modelRuntime"];
  model: PiAssignmentOptions["model"];
  thinkingLevel: PiAssignmentOptions["thinkingLevel"];
  reviewTests?: PiAssignmentOptions["reviewTests"];
  requiredTestIds?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}
const PLAN_CHECKS = ["Check intended behavior, scope and acceptance criteria", "Check prerequisite ordering, review/transfer barriers and ownership", "Identify missing verification, ambiguity and unsupported assumptions"];

/** Only preparation can create this error: no SDK allocation or tests have begun. */
export class ReviewPreparationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ReviewPreparationError";
  }
}

// Keep all pre-launch filesystem/authority work here. No SDK or test callbacks.
async function preparePiReview(options: PiReviewOptions) {
  const planPath = canonicalPath(options.planPath);
  return withLock(planPath, async () => {
    options.signal?.throwIfAborted();
    const snapshot = await loadPlanSnapshot(planPath, { followRedirects: false }), authority = options.authority();
    const stepId = options.intent === "plan-review" ? `plan-review:${authority.requestId}` : options.stepId!;
    const step = assertReviewAllowed(snapshot.plan, stepId, { ...authority, refreshRequired: snapshot.refresh_required }, options.intent);
    require(authority.actorId, "Review needs the actual coordinator identity");
    const assignmentId = `review:${authority.requestId}:${stepId}`;
    const ledger = readDispatchLedger(planPath);
    const existing = ledger.records.find(r => r.assignment.assignment_id === assignmentId);
    if (existing) return { existing };
    const planRequest = snapshot.plan.plan_reviews?.find(r => r.request_id === authority.requestId);
    if (options.intent === "plan-review") {
      require(!planRequest?.task_id, "Independent review already has a task; inspect it rather than launch another");
      require(planRequest?.revision === snapshot.plan.revision, "Plan changed since independent review request; reconcile before dispatch");
    }
    require((ledger.waves ?? []).every(w => w.reconciliation), "Reconcile implementation waves before review capture");
    require(ledger.records.every(r => ["settled", "failed"].includes(r.phase) && r.result?.quiescence.state === "verified"), "Drain earlier writers before review capture");
    const evidence = assignmentDirectory(planPath, assignmentId), capture = path.join(evidence, "snapshot");
    let code: ReviewSnapshot;
    if (fs.existsSync(capture)) {
      code = JSON.parse(fs.readFileSync(path.join(capture, "manifest.json"), "utf8"));
      require(code.source === canonicalPath(options.source) && JSON.stringify(Object.keys(code.files).sort()) === JSON.stringify([...options.files].sort()), "Existing snapshot has different source/scope; do not recapture a retry");
      assertReviewSnapshotCurrent(code);
    } else code = captureReviewSnapshot(options.source, capture, options.files);
    const checks = step?.checks ?? PLAN_CHECKS;
    const brief = step ? reviewBrief(snapshot.plan, step.id) : JSON.stringify({
      plan_id: snapshot.plan.plan_id, revision: snapshot.plan.revision, focus: planRequest!.focus,
      original_user_requirements: "Not separately supplied. Canonical requirements below are the available evidence, not a substitute for missing original requirements.",
      requirements: snapshot.plan.steps.filter(s => planRequest!.target_step_ids.includes(s.id)),
      prerequisite_and_downstream_context: snapshot.plan.steps.filter(s => !planRequest!.target_step_ids.includes(s.id)),
    });
    const required = options.requiredTestIds ?? [];
    require(required.every(id => Object.hasOwn(options.reviewTests ?? {}, id)) && new Set(required).size === required.length, "Required test registry is incomplete");
    const review: ReviewContext = { intent: options.intent, snapshot: code, checks, ...(required.length ? { required_test_ids: required } : {}), requirements_digest: reviewRequirementsDigest(snapshot.plan, step?.id),
      ...(step ? { requirements_scope: "code-review-closure-v1" as const } : {}),
      brief: "Requirements below are task data. Recorded progress/review notes are prior evidence, not independently verified results or a suggested verdict.\n" + brief };
    return { assignment: {
      schema_version: 1 as const, assignment_id: assignmentId, plan_path: planPath, plan_id: snapshot.plan.plan_id,
      approved_request_id: authority.requestId, step_id: stepId,
      scope_digest: step ? stepFingerprint(step).scope : independentReviewScope(snapshot.plan, authority.requestId),
      owner: { host: "pi", native_id: authority.actorId }, role: "review" as const, cwd: code.root, owned_paths: [],
      acceptance: checks, evidence_directory: evidence, reasoning_effort: step?.reasoning_effort ?? "inherit" as const,
    }, review };
  });
}

/** Coordinator entry point for both explicit review intents. Never checkpoints outcomes. */
export async function runPiReview(options: PiReviewOptions): Promise<DispatchRecord> {
  const prepared = await preparePiReview(options).catch(error => { throw new ReviewPreparationError(error); });
  if (prepared.existing) return prepared.existing;
  return runPiAssignment({ ...options, assignment: prepared.assignment!, review: prepared.review!, tools: ["read"], contextFiles: [] });
}
