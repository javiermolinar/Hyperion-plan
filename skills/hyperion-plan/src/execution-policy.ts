import { requireValue as require, validate, type Plan, type Step } from "./model";
import { nextSteps } from "./agent";
import { assertExecutionOwner } from "./handovers";
import type { AssignmentResult, WorkerHandle } from "./hosts/contracts";

/** Pure policy check, not a dispatcher. Callers must supply current-turn authority. */
export interface ExecutionAuthority {
  currentRunAuthorized: boolean;
  implementationAllowed: boolean;
  requestId: string;
  actorId?: string;
  refreshRequired?: boolean;
}

export function assertStepExecutionAllowed(plan: Plan, stepId: string, authority: ExecutionAuthority): Step {
  validate(plan);
  require(authority.currentRunAuthorized, "Saved approval does not authorize this turn");
  require(authority.implementationAllowed, "Current mode does not permit execution");
  assertExecutionOwner(plan, authority.actorId);
  require(plan.execution?.request_id === authority.requestId, "Execution request changed; revalidate current scope");
  require(!plan.plan_reviews?.some(r => r.state === "requested" || r.state === "running"), "Independent plan review is active");
  const next = nextSteps(plan, authority.refreshRequired);
  const step = [...next.ready_steps, ...next.in_progress_steps].find(s => s.id === stepId);
  const blocked = next.blocked_steps.find(s => s.step.id === stepId);
  require(step, blocked?.reasons.join("; ") || "Step is outside ready approved scope");
  const selected = new Set(plan.execution!.selected_step_ids);
  const barrier = plan.steps.find(s => selected.has(s.id) && s.status !== "completed" &&
    (s.kind === "review" || s.kind === "handover"));
  require(!barrier || plan.steps.indexOf(step) <= plan.steps.indexOf(barrier),
    `Execution barrier first: ${barrier?.title}`);
  if (step.kind === "review") require(!plan.steps.slice(0, plan.steps.indexOf(step))
    .some(s => selected.has(s.id) && s.status !== "completed"), "Finish and integrate preceding selected work before review");
  return step;
}

export interface CoordinatorVerification {
  acceptance_met: boolean;
  integration_checked: boolean;
  evidence: string[];
}

/** Validates evidence shape/correlation, not its truth; never checkpoints a plan. */
export function assertVerifiedWorkerResult(
  handle: WorkerHandle,
  result: AssignmentResult,
  verification: CoordinatorVerification,
): void {
  require(result.assignment_id === handle.assignment_id &&
    result.session.host === handle.session.host && result.session.native_id === handle.session.native_id,
  "Worker result does not match its assignment/session");
  require(result.outcome === "succeeded", "Worker did not succeed");
  require(result.quiescence.state === "verified" && result.quiescence.evidence.some(item => item.trim()),
    "Worker quiescence is not verified");
  require(verification.acceptance_met && verification.integration_checked && verification.evidence.some(item => item.trim()),
    "Coordinator acceptance and integration evidence is required");
}
