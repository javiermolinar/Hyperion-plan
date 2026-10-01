import * as fs from "node:fs";
import { requireValue as require, type Plan } from "../model";
import { assertVerifiedWorkerResult, type CoordinatorVerification } from "../execution-policy";
import { stepFingerprint } from "../transitions";
import type { DispatchRecord } from "./dispatch-ledger";
import { independentReviewScope, reviewContextRequirementsDigest, validateReviewReport } from "./review-contract";
import { assertReviewSnapshotCurrent } from "./review-snapshot";
import { assertControlledTestArtifacts } from "./review-tests";

/** Shared, read-only evidence check for verification AND canonical completion.
 * No SDK imports, authority grants or writes. Recheck artifacts at each boundary;
 * a saved verification flag is not permission to accept later drift. */
export function assertReviewEvidence(plan: Plan, record: DispatchRecord, verification: CoordinatorVerification): void {
  const a = record.assignment, review = record.review;
  require(review && a.role === "review" && a.plan_id === plan.plan_id, "Review assignment identity changed");
  const step = plan.steps.find(s => s.id === a.step_id);
  if (review.intent === "code-review") require(step?.kind === "review" && JSON.stringify(step.checks) === JSON.stringify(review.checks) &&
    (step.reasoning_effort ?? "inherit") === a.reasoning_effort, "Review checks/effort changed");
  require(a.scope_digest === (review.intent === "code-review" && step ? stepFingerprint(step).scope : independentReviewScope(plan, a.approved_request_id)), "Review scope changed");
  require(review.requirements_digest === reviewContextRequirementsDigest(plan, review, a.step_id), "Review requirements changed");
  require(record.review_report, "Review report missing");
  validateReviewReport(record.review_report, review);
  // Plan-review verification confirms performed review work, not approval of
  // the proposed plan. Its findings may be reconciled (including needs_input).
  // Code-review acceptance still rejects blocking findings; both intents need
  // actual coverage and every required test's evidence.
  require(!record.review_report.checks.some(c => c.status === "not-verified" || (review.intent === "code-review" && c.blocking)),
    "Required review checks or blocking findings remain unresolved");
  require((review.required_test_ids ?? []).every(id => Object.hasOwn(record.controlled_tests ?? {}, id) && record.controlled_tests![id].status === "passed"), "Required native review suites were not run successfully");
  require(!Object.values(record.controlled_tests ?? {}).some(test => test.status !== "passed"), "Controlled review tests remain unresolved");
  Object.values(record.controlled_tests ?? {}).forEach(assertControlledTestArtifacts);
  assertReviewSnapshotCurrent(review.snapshot);
  require(record.phase === "settled" && record.handle && record.result, "Review assignment has not settled successfully");
  require(record.handle.assignment_id === a.assignment_id, "Review handle assignment changed");
  assertVerifiedWorkerResult(record.handle, record.result, verification);
  require(fs.existsSync(record.handle.transcript_path) && fs.existsSync(record.result_path) && fs.existsSync(record.events_path), "Review evidence is missing");
  const saved = JSON.parse(fs.readFileSync(record.result_path, "utf8"));
  assertVerifiedWorkerResult(record.handle, saved, verification);
  require(saved.acceptance_verified === false && JSON.stringify(saved.review_report) === JSON.stringify(record.review_report) &&
    JSON.stringify(saved.controlled_tests) === JSON.stringify(record.controlled_tests), "Review report artifact drifted");
  const entries = fs.readFileSync(record.handle.transcript_path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const tag = entries.find(e => e.type === "custom" && e.customType === "hyperion.assignment")?.data;
  require(entries[0]?.type === "session" && entries[0]?.id === record.handle.session.native_id &&
    tag?.assignment_id === a.assignment_id && tag.attempt_id === record.attempt_id && tag.plan_id === a.plan_id &&
    tag.request_id === a.approved_request_id && tag.step_id === a.step_id && tag.scope_digest === a.scope_digest &&
    tag.owner?.native_id === a.owner.native_id && tag.snapshot_digest === review.snapshot.digest && tag.requirements_digest === review.requirements_digest,
  "Review transcript correlation changed");
  const events = fs.readFileSync(record.events_path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  require(events.at(-1)?.type === "agent_settled" && events.every(e => e.assignment_id === a.assignment_id &&
    e.attempt_id === record.attempt_id && e.session?.host === record.handle!.session.host && e.session?.native_id === record.handle!.session.native_id),
  "Review settlement event correlation changed");
}
