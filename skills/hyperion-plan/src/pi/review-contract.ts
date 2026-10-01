import type { Plan, Step } from "../model";
import { prerequisites, requireValue as require } from "../model";
import { assertStepExecutionAllowed, type ExecutionAuthority } from "../execution-policy";
import { assertExecutionOwner } from "../handovers";
import { digestText, stepFingerprint } from "../transitions";
import type { ReviewSnapshot } from "./review-snapshot";

export interface ReviewContext {
  intent: "code-review" | "plan-review";
  snapshot: ReviewSnapshot;
  brief: string;
  requirements_digest: string;
  /** Absent on legacy captures, which retain whole-plan validation. */
  requirements_scope?: "code-review-closure-v1";
  checks: string[];
  required_test_ids?: string[];
}
export interface ReviewReport {
  snapshot_digest: string;
  checks: { id: number; status: "passed" | "finding" | "not-verified"; evidence: string; blocking: boolean }[];
}
export function reviewRequirementsDigest(plan: Plan, reviewStepId?: string): string {
  if (reviewStepId === undefined)
    return digestText(JSON.stringify({ title: plan.title, steps: plan.steps.map(s => ({ id: s.id, scope: stepFingerprint(s).scope })) }));
  const byId = new Map(plan.steps.map(s => [s.id, s]));
  require(byId.get(reviewStepId)?.kind === "review", "Review requirements need a code-review step");
  const relevant = new Set<string>();
  const visit = (id: string) => {
    if (relevant.has(id)) return;
    const step = byId.get(id); require(step, "Review requirement prerequisite disappeared");
    relevant.add(id);
    prerequisites(step!).forEach(visit);
  };
  visit(reviewStepId);
  return digestText(JSON.stringify({ scope: "code-review-closure-v1", title: plan.title,
    steps: plan.steps.filter(s => relevant.has(s.id)).map(s => ({ id: s.id, scope: stepFingerprint(s).scope })) }));
}
export function reviewContextRequirementsDigest(plan: Plan, review: ReviewContext, stepId: string): string {
  require(review.requirements_scope === undefined || (review.requirements_scope === "code-review-closure-v1" && review.intent === "code-review"),
    "Unsupported review requirements scope");
  return reviewRequirementsDigest(plan, review.requirements_scope ? stepId : undefined);
}
export function independentReviewScope(plan: Plan, requestId: string): string {
  const review = plan.plan_reviews?.find(r => r.request_id === requestId);
  require(review, "Independent plan review request missing");
  return digestText(JSON.stringify({ request_id: requestId, focus: review.focus,
    targets: review.target_step_ids.map(id => ({ id, scope: stepFingerprint(plan.steps.find(s => s.id === id)!).scope })) }));
}
export function assertReviewAllowed(plan: Plan, stepId: string, authority: ExecutionAuthority, intent: ReviewContext["intent"]): Step | undefined {
  require(authority.currentRunAuthorized && authority.implementationAllowed, "Explicit current review authority required");
  assertExecutionOwner(plan, authority.actorId);
  require(!authority.refreshRequired && (plan.lifecycle ?? "active") === "active", "Review requires an active current canonical plan");
  require(!plan.handovers?.some(h => ["requested", "prepared", "blocked"].includes(h.state)), "Unresolved handover blocks review");
  if (intent === "code-review") {
    const step = assertStepExecutionAllowed(plan, stepId, authority);
    require(step.kind === "review" && step.status === "in_progress", "Selected code review must be checkpointed in_progress");
    return step;
  }
  const review = plan.plan_reviews?.find(r => r.request_id === authority.requestId);
  require(review && ["requested", "running"].includes(review.state), "No active explicitly requested independent plan review");
  require(stepId === `plan-review:${authority.requestId}`, "Independent review identity mismatch");
  require(!plan.steps.some(s => s.status === "in_progress" && plan.execution?.selected_step_ids.includes(s.id)), "Drain/checkpoint selected work before independent plan review");
}
export function validateReviewReport(report: ReviewReport, context: ReviewContext): void {
  require(report && report.snapshot_digest === context.snapshot.digest && Array.isArray(report.checks) && report.checks.length === context.checks.length, "Report must identify the snapshot and cover every required check");
  require(new Set(report.checks.map(c => c.id)).size === context.checks.length && report.checks.every(c =>
    Number.isInteger(c.id) && c.id >= 1 && c.id <= context.checks.length && ["passed", "finding", "not-verified"].includes(c.status) &&
    typeof c.evidence === "string" && c.evidence.trim() && typeof c.blocking === "boolean" && (c.status !== "passed" || !c.blocking)),
  "Invalid per-check review evidence");
}
