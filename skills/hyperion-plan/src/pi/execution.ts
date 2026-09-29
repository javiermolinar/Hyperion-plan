import { checkReady, handoverBlocker, withHandoverCheckpoints, type Plan, type Step } from "../index";

/** Pi v1 capabilities, shared by the screen preview and the locked Run validation. */
export function piStepBlocker(plan: Plan, step: Step, selected = false): string | undefined {
  if (step.kind === "review") return "This independent review needs a fresh reviewer; the Pi adapter cannot simulate it. Use a supported host such as Codex.";
  if (step.kind === "handover") return "This handover checkpoint needs ownership transfer; the Pi adapter cannot simulate it. Continue in a host with handover support.";
  if (step.kind && step.kind !== "implementation") return "This step kind is not executable by the Pi current-session adapter.";
  if (step.status === "completed") return "Completed steps cannot be selected for Run.";
  if (step.blocked_by) return `Step ${step.id} is blocked: ${step.blocked_by}`;
  const position = plan.steps.indexOf(step);
  const priorBoundary = plan.steps.slice(0, position).find(item => item.kind === "handover" && item.status !== "completed");
  if (priorBoundary) return `Handover checkpoint first: ${priorBoundary.title}. Pi v1 cannot transfer ownership.`;
  if (!selected) {
    const priorReview = plan.steps.slice(0, position).find(item => item.kind === "review" && item.status !== "completed");
    if (priorReview) return `Review barrier first: ${priorReview.title}.`;
  }
  if (plan.lifecycle === "finished") return "Reopen the finished plan before selecting work.";
  return undefined;
}

export function piRunBlocker(plan: Plan, ids: string[]): string | undefined {
  const activeHandover = plan.handovers?.find(item => ["requested", "prepared", "blocked"].includes(item.state));
  if (activeHandover) return `Handover ${activeHandover.state}; resolve it in a host with ownership-transfer support before running work.`;
  const activeReview = plan.plan_reviews?.find(item => item.state === "requested" || item.state === "running");
  if (activeReview) return "An independent plan review is active. Wait for its findings and reconcile them before Run.";
  if (!ids.length) return "Select implementation steps with Space or click their checkboxes.";
  for (const id of ids) {
    const step = plan.steps.find(item => item.id === id);
    if (!step) return `Selected step is absent: ${id}`;
    const reason = piStepBlocker(plan, step, true);
    if (reason) return reason;
  }
  const firstOpenReview = plan.steps.find(step => step.kind === "review" && step.status !== "completed");
  if (firstOpenReview) {
    const barrierIndex = plan.steps.indexOf(firstOpenReview);
    if (ids.some(id => plan.steps.findIndex(step => step.id === id) > barrierIndex))
      return `Review barrier first: ${firstOpenReview.title}. Pi v1 does not run independent review steps in the current context.`;
  }
  const expanded = withHandoverCheckpoints(plan.steps, ids);
  const implicitBoundary = expanded.find(id => !ids.includes(id) && plan.steps.find(step => step.id === id)?.kind === "handover");
  if (implicitBoundary) {
    const boundary = plan.steps.find(step => step.id === implicitBoundary)!;
    return `Run would cross handover checkpoint “${boundary.title}”. Pi v1 cannot transfer ownership; choose an earlier partial batch or use Codex.`;
  }
  const byId = Object.fromEntries(plan.steps.map(step => [step.id, step]));
  for (const id of ids) {
    // Explicit Run can approve replanned scope; freshness still needs inspection.
    const readyStep = { ...byId[id], needs_replanning: false };
    try { checkReady(readyStep, byId, ids, plan.steps); }
    catch (error) { return (error as Error).message; }
    const boundary = handoverBlocker(plan.steps, byId[id], ids);
    if (boundary) return boundary;
  }
  return undefined;
}
