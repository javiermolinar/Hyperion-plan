import { checkReady, handoverBlocker, withHandoverCheckpoints, type Plan, type Step } from "../index";

/** Selection expresses intent. Readiness is checked only at canonical execution admission. */
export function piStepBlocker(plan: Plan, step: Step, selected = false): string | undefined {
  if (step.kind && step.kind !== "implementation" && step.kind !== "review" && step.kind !== "handover") return "This step kind is not executable by the Pi current-session adapter.";
  if (step.status === "completed") return "Completed steps cannot be selected for Run.";
  return undefined;
}

export function piRunBlocker(plan: Plan, ids: string[]): string | undefined {
  const activeHandover = plan.handovers?.find(item => ["requested", "prepared", "blocked"].includes(item.state));
  if (activeHandover) return `Handover ${activeHandover.state}; inspect/resume the same destination or explicitly cancel it before selecting new work.`;
  const activeReview = plan.plan_reviews?.find(item => item.state === "requested" || item.state === "running");
  if (activeReview) return "An independent plan review is active. Wait for its findings and reconcile them before Run.";
  if (!ids.length) return "Select implementation steps with Space or click their checkboxes.";
  for (const id of ids) {
    const step = plan.steps.find(item => item.id === id);
    if (!step) return `Selected step is absent: ${id}`;
    const reason = piStepBlocker(plan, step, true);
    if (reason) return reason;
  }
  if (plan.lifecycle === "finished") return "Reopen the finished plan before execution.";
  const expanded = withHandoverCheckpoints(plan.steps, ids);
  const byId = Object.fromEntries(plan.steps.map(step => [step.id, step]));
  for (const id of expanded) {
    // Explicit Run can approve replanned scope; freshness still needs inspection.
    const readyStep = { ...byId[id], needs_replanning: false };
    try { checkReady(readyStep, byId, expanded, plan.steps); }
    catch (error) { return (error as Error).message; }
    const boundary = handoverBlocker(plan.steps, byId[id], expanded);
    if (boundary) return boundary;
  }
  return undefined;
}
