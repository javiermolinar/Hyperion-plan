import { requireValue as require, type Plan } from "../model";
import { readDispatchLedger } from "./dispatch-ledger";
import { assertReviewAllowed } from "./review-contract";
import { assertReviewEvidence } from "./review-evidence";

/** Storage-boundary enforcement for managed code and independent plan reviews.
 * Legacy/external reviews without a Pi assignment retain the shared-core contract.
 * A failed latest attempt cannot be hidden by changing request IDs or selecting
 * an older clean report. No SDK, dispatch, or verification writes occur here. */
export function assertPiReviewCompletions(planPath: string, previous: Plan, next: Plan, actorId?: string): void {
  const completing = next.steps.filter(s => s.status === "completed" && previous.steps.find(p => p.id === s.id)?.status !== "completed");
  const planReviews = (next.plan_reviews ?? []).filter(r => r.state === "completed" &&
    previous.plan_reviews?.find(p => p.request_id === r.request_id)?.state !== "completed");
  if (!completing.length && !planReviews.length) return;
  const ledger = readDispatchLedger(planPath);
  for (const step of completing) {
    const records = ledger.records.filter(r => r.assignment.plan_id === previous.plan_id && r.assignment.step_id === step.id && r.assignment.role === "review");
    if (!records.length) continue;
    const record = records.at(-1)!, a = record.assignment;
    require(step.kind === "review" && record.review?.intent === "code-review", "Managed review identity changed");
    require(actorId === a.owner.native_id, "Only the assigning coordinator may complete a managed review");
    require(next.execution?.request_id === a.approved_request_id && next.execution.state === "approved" && next.execution.selected_step_ids.includes(step.id), "Managed review execution request changed");
    // The storage caller owns current user authority. Here validate saved scope,
    // prerequisites and ownership against the actual pre-completion state.
    assertReviewAllowed(previous, step.id, { currentRunAuthorized: true, implementationAllowed: true,
      actorId, requestId: a.approved_request_id }, "code-review");
    require(record.verification, "Coordinator verification is required before managed review completion");
    assertReviewEvidence(next, record, record.verification);
  }
  for (const outcome of planReviews) {
    const stepId = `plan-review:${outcome.request_id}`;
    // A new request cannot relabel a known managed reviewer/report as external.
    // Also select the latest request attempt even if the outcome names an older
    // settled native identity. Genuine unmanaged records remain compatible.
    const records = ledger.records.filter(r => r.assignment.plan_id === previous.plan_id && r.assignment.role === "review" &&
      (r.assignment.step_id === stepId || r.handle?.session.native_id === outcome.task_id || r.result_path === outcome.report_path));
    if (!records.length) continue;
    const record = records.at(-1)!, a = record.assignment;
    require(record.review?.intent === "plan-review" && a.step_id === stepId && a.approved_request_id === outcome.request_id &&
      outcome.revision === previous.plan_reviews?.find(r => r.request_id === outcome.request_id)?.revision,
    "Managed independent review identity/request changed");
    require(actorId === a.owner.native_id, "Only the assigning coordinator may complete a managed plan review");
    require(outcome.task_id === record.handle?.session.native_id && outcome.report_path === record.result_path,
      "Managed independent review native identity/report path changed");
    // Independent review has its own explicit request; it must NOT inherit or
    // require an implementation selection, nor resume a paused execution.
    assertReviewAllowed(previous, a.step_id, { currentRunAuthorized: true, implementationAllowed: true,
      actorId, requestId: a.approved_request_id }, "plan-review");
    require(record.verification, "Coordinator verification is required before managed plan-review completion");
    assertReviewEvidence(next, record, record.verification);
    require(!record.review_report!.checks.some(c => c.status === "finding") || outcome.findings.length > 0,
      "Reconcile managed plan-review findings before completion; delivery is not plan approval");
  }
}
