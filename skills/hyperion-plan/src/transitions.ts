import { createHash, randomUUID } from "node:crypto";
import {
  Plan,
  PlanReview,
  Step,
  ChangeRequest,
  Status,
  ExecutionState,
  Lifecycle,
  clone,
  record,
  string,
  identifier,
  validate,
  requireValue as require,
  canonicalJSON,
  equal,
  preserveHistory,
  validateStepOrder,
  applyOperations,
  invalidateDependents,
  checkReady,
  withHandoverCheckpoints,
  EXECUTION_STATES,
  STATUSES,
} from "./model";
export const digestText = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function requireActive(plan: Plan): void {
  require(plan.lifecycle !== "finished", "Reopen this finished plan before changing or running work");
}
export function setLifecycle(plan: Plan, revision: number, state: Lifecycle): [Plan, boolean] {
  validate(plan);
  require(plan.revision === revision, `Stale plan: current revision ${plan.revision}`);
  require(["active", "finished"].includes(state), "Invalid plan lifecycle");
  const result = clone(plan);
  if ((plan.lifecycle ?? "active") === state) return [result, false];
  result.lifecycle = state;
  delete result.execution;
  result.revision++;
  return [validate(result), true];
}
export function stepFingerprint(step: Step): { status: Status; scope: string } {
  const normalized = { description: "", done_when: "", comments: [], ...step };
  const scope = Object.fromEntries(
    Object.entries(normalized).filter(
      ([k]) =>
        ![
          "status",
          "completion_source",
          "progress_note",
          "blocked_by",
          "review_state",
          "review_note",
          "milestone",
          "handover_after",
          "reasoning_effort",
          "parallel_group",
        ].includes(k),
    ),
  );
  return { status: step.status, scope: digestText(canonicalJSON(scope)) };
}
export function initialize(data: unknown): Plan {
  require(record(data) &&
    Array.isArray(data.steps), "Expected title and steps");
  const plan: Plan = {
    schema_version: 1,
    plan_id: randomUUID(),
    revision: 1,
    title: data.title as string,
    steps: clone(data.steps),
    applied_requests: {},
  };
  if (data.preamble) plan.preamble = data.preamble as string;
  for (const step of plan.steps) {
    require(record(step), "Invalid step");
    if (!Object.hasOwn(step, "id")) step.id = randomUUID();
    if (!("description" in step)) step.description = "";
    if (!("done_when" in step)) step.done_when = "";
    if (!Object.hasOwn(step, "status")) step.status = "pending";
    if (!("comments" in step)) step.comments = [];
    if (step.status === "completed" && !("completion_source" in step))
      step.completion_source = "agent";
  }
  return validate(plan);
}
export function applyRequest(plan: Plan, value: unknown): [Plan, boolean] {
  validate(plan);
  require(record(value), "Invalid change request");
  const request = value as unknown as ChangeRequest;
  require(request.plan_id ===
    plan.plan_id, "This request belongs to another plan");
  const rid = identifier(request.request_id),
    digest = digestText(canonicalJSON(request)),
    receipt =
      plan.applied_requests && Object.hasOwn(plan.applied_requests, rid)
        ? plan.applied_requests[rid]
        : undefined;
  if (receipt) {
    require(receipt === digest, "Request ID was reused with different changes");
    return [clone(plan), false];
  }
  require(Number.isSafeInteger(request.base_revision) &&
    request.base_revision ===
      plan.revision, `Stale plan: request revision ${request.base_revision}, current revision ${plan.revision}`);
  const operations = request.operations,
    intent = request.intent === undefined ? "edit" : request.intent;
  require(["ask", "edit", "implement", "review", "decompose", "replan", "finish", "reopen", "handover"].includes(
    intent,
  ), "Invalid request intent");
  require(Array.isArray(operations) &&
    operations.length <= 100, "Expected at most 100 operations");
  require(request.execution_mode === undefined ||
    (intent === "implement" && ["auto", "sequential", "parallel"].includes(request.execution_mode)),
    "Execution mode is only valid on an implementation request and must be auto, sequential, or parallel");
  require(request.review_mode === undefined || (intent === "review" && ["refresh", "independent"].includes(request.review_mode)), "Invalid review mode");
  require(request.review_focus === undefined || (intent === "review" && request.review_mode === "independent" && typeof request.review_focus === "string" && request.review_focus.length <= 2000), "Invalid review focus");
  require(request.handover_reason === undefined || (intent === "handover" && typeof request.handover_reason === "string" && request.handover_reason.trim().length > 0 && request.handover_reason.length <= 2000), "Invalid handover reason");
  require(request.question === undefined || (intent === "ask" && typeof request.question === "string" && request.question.trim().length > 0 && request.question.length <= 1000), "Invalid step question");
  const independent = intent === "review" && request.review_mode === "independent";
  const selected =
      request.selected_step_ids === undefined ? [] : request.selected_step_ids,
    targets =
      request.target_step_ids === undefined ? [] : request.target_step_ids;
  require(Array.isArray(selected), "Invalid implementation selection");
  require(Array.isArray(targets), "Invalid planning targets");
  if (intent !== "finish" && intent !== "reopen") requireActive(plan);
  if (intent === "finish" || intent === "reopen") {
    require(!selected.length && !targets.length, "A lifecycle request cannot select or authorize work");
    if (intent === "reopen") require(!operations.length, "Reopen the plan before submitting edits");
    if (plan.lifecycle === "finished") require(!operations.length, "Reopen this finished plan before changing work");
  } else if (intent === "ask") {
    require(!operations.length && !selected.length && targets.length === 1 && typeof request.question === "string" && !!request.question.trim(), "Ask requires one step and a question, without edits or implementation selection");
    identifier(targets[0]);
    require(plan.steps.some(s => s.id === targets[0]), "Question target is absent");
  } else if (intent === "handover") {
    require(!selected.length && targets.length <= 1, "A handover cannot authorize work and may locate at most one step");
    targets.forEach(identifier);
    require(!plan.handovers?.some(h => ["requested", "prepared", "blocked"].includes(h.state)), "A handover is already active");
  } else if (["review", "decompose", "replan"].includes(intent)) {
    require(!selected.length, "A planning request cannot authorize implementation");
    require(targets.length > 0 &&
      targets.length <= 30, "Choose steps to review or decompose");
    targets.forEach(identifier);
    require(new Set(targets).size ===
      targets.length, "Duplicate planning target");
  } else if (intent === "edit") {
    require(operations.length, "Expected 1–100 operations");
    require(!selected.length, "An edit request cannot authorize implementation");
  } else {
    require(selected.length > 0 &&
      selected.length <= 30, "Select at least one step to implement");
    selected.forEach(identifier);
    require(new Set(selected).size ===
      selected.length, "Duplicate selected step");
  }
  if (!["ask", "review", "decompose", "replan", "handover"].includes(intent))
    require(!targets.length, "Unexpected planning targets");
  const result = applyOperations(plan, operations),
    available = Object.fromEntries(result.steps.map((s) => [s.id, s]));
  // Compare final notes so cancelled draft edits preserve authority. An explicit
  // implementation selection below may authorize the updated scope again.
  for (const previous of plan.steps) {
    const step = Object.hasOwn(available, previous.id)
      ? available[previous.id]
      : undefined;
    if (!step || equal(previous.comments ?? [], step.comments ?? [])) continue;
    if (result.execution)
      result.execution.selected_step_ids =
        result.execution.selected_step_ids.filter((id) => id !== step.id);
    invalidateDependents(
      result,
      [step.id],
      "A prerequisite's notes changed. Review this step against the updated requirements.",
    );
  }
  if (intent === "finish" || intent === "reopen") {
    result.lifecycle = intent === "finish" ? "finished" : "active";
    // Reopening never resurrects the earlier implementation selection.
    if (intent === "finish" || plan.lifecycle === "finished") delete result.execution;
  } else if (intent === "handover") {
    const step = targets.length && Object.hasOwn(available, targets[0]) ? available[targets[0]] : undefined;
    if (step?.kind === "handover") {
      require(step.status === "pending", "Handover checkpoint already started or completed");
      checkReady(step, available, [], result.steps);
      step.status = "in_progress";
    } else require(!targets.length || (!!step && step.status !== "pending"), "Locate a handover during active work or after a completed step");
    result.handovers = [...(result.handovers ?? []), {
      request_id: rid, revision: result.revision + 1, created_at: new Date().toISOString(), state: "requested",
      position: step ? step.status === "in_progress" ? "during" : "after" : "between",
      ...(step ? { step_id: step.id, step_title: step.title } : {}),
      reason: request.handover_reason ?? "Continue in fresh context",
    }];
  } else if (intent === "implement") {
    require(!plan.handovers?.some(h => ["requested", "prepared", "blocked"].includes(h.state)), "Finish or cancel the active handover before implementing");
    const executionSelection = withHandoverCheckpoints(result.steps, selected);
    for (const sid of executionSelection) {
      require(Object.hasOwn(
        available,
        sid,
      ), `Selected step is absent or removed: ${sid}`);
      require(available[sid].status !==
        "completed", `Selected step is already completed: ${sid}`);
      checkReady(available[sid], available, executionSelection, result.steps);
    }
    result.execution = {
      request_id: rid,
      state: "approved",
      selected_step_ids: clone(executionSelection),
      ...(request.execution_mode !== undefined ? { execution_mode: request.execution_mode } : {}),
    };
  } else if (independent) {
    require(!result.plan_reviews?.some(r => r.state === "requested" || r.state === "running"), "An independent plan review is already active");
    for (const sid of targets) require(Object.hasOwn(available, sid), `Planning target is absent: ${sid}`);
    result.plan_reviews = [...(result.plan_reviews ?? []), {
      request_id: rid, revision: result.revision + 1, target_step_ids: clone(targets),
      focus: request.review_focus ?? "", state: "requested", findings: [],
    }];
  } else if (intent === "replan") {
    for (const sid of targets)
      require(Object.hasOwn(
        available,
        sid,
      ), `Planning target is absent: ${sid}`);
    invalidateDependents(
      result,
      targets,
      "Replan this dependency before removing the referenced step. Preserve the step until resolved.",
    );
  } else if (intent === "review" || intent === "decompose") {
    for (const sid of targets) {
      require(Object.hasOwn(available, sid) &&
        available[sid].status !==
          "completed", `Planning target is absent or complete: ${sid}`);
      available[sid].review_state = "needs_review";
      available[sid].review_note =
        intent === "decompose"
          ? "Break this step into smaller steps before further implementation."
          : "Review requested against the current code.";
    }
    invalidateDependents(
      result,
      targets,
      "A prerequisite is being reviewed or decomposed.",
    );
  }
  // A question receipt changes no visible plan state. Keep the card usable
  // after a pure answer; actual follow-up edits advance the revision normally.
  if (intent !== "ask") result.revision++;
  result.applied_requests = {
    ...(result.applied_requests ?? {}),
    [rid]: digest,
  };
  return [validate(result), true];
}
export function revise(plan: Plan, replacement: Plan, revision: number): Plan {
  validate(plan);
  requireActive(plan);
  require((replacement.lifecycle ?? "active") === (plan.lifecycle ?? "active"), "Use finish or reopen to change plan lifecycle");
  require(plan.revision ===
    revision, `Stale plan: current revision ${plan.revision}`);
  require(replacement.plan_id ===
    plan.plan_id, "Cannot replace a different plan");
  const result = clone(replacement),
    oldSteps = Object.fromEntries(plan.steps.map((s) => [s.id, s]));
  preserveHistory(oldSteps, result.steps);
  result.revision = revision + 1;
  result.applied_requests = clone(plan.applied_requests ?? {});
  if (plan.plan_reviews) result.plan_reviews = clone(plan.plan_reviews);
  if (plan.handovers) result.handovers = clone(plan.handovers); else delete result.handovers;
  if (plan.execution_owner) result.execution_owner = plan.execution_owner; else delete result.execution_owner;
  delete result.execution;
  if (plan.execution != null) {
    result.execution = clone(plan.execution);
    const remaining = new Set(
      result.steps
        .filter(
          (s) =>
            Object.hasOwn(oldSteps, s.id) &&
            stepFingerprint(s).scope === stepFingerprint(oldSteps[s.id]).scope,
        )
        .map((s) => s.id),
    );
    result.execution.selected_step_ids =
      plan.execution.selected_step_ids.filter((id) => remaining.has(id));
  }
  const changed = new Set<string>();
  for (const step of result.steps) {
    const old = Object.hasOwn(oldSteps, step.id)
      ? oldSteps[step.id]
      : undefined;
    if (!old) continue;
    if (old.kind === "handover") {
      require(step.kind === "handover", "Preserve handover checkpoint type");
      require(step.status === old.status, "Handover checkpoints complete only when ownership transfers");
    }
    if (old.kind === "review" && old.status !== "pending")
      for (const field of ["kind", "depends_on", "checks", "run_after"] as const)
        require(
          equal(old[field] ?? null, step[field] ?? null),
          "Preserve the scope and timing of active or completed reviews",
        );
    if (old.review_state === "needs_review" && step.status !== "completed") {
      step.review_state = old.review_state;
      step.review_note = old.review_note;
    }
    if (!equal(stepFingerprint(old), stepFingerprint(step))) {
      changed.add(step.id);
      if (step.status !== "completed") {
        step.review_state = "needs_review";
        step.review_note =
          "This step changed. Review its scope and prerequisites.";
      }
    }
  }
  invalidateDependents(
    result,
    changed,
    "A prerequisite changed. Review this step against the updated plan and code.",
  );
  validate(result);
  validateStepOrder(result.steps);
  return result;
}
export function checkpoint(
  plan: Plan,
  revision: number,
  stepId?: string | null,
  status?: Status | null,
  note?: string | null,
  blockedBy?: string | null,
  executionState?: ExecutionState | null,
): [Plan, boolean] {
  validate(plan);
  requireActive(plan);
  require(plan.revision ===
    revision, `Stale plan: current revision ${plan.revision}`);
  require(!plan.handovers?.some(h => ["requested", "prepared", "blocked"].includes(h.state)) || (!stepId && executionState !== "approved"), "Finish or cancel the active handover before checkpointing work");
  require(stepId != null ||
    executionState != null, "Checkpoint needs a step or execution state");
  require(stepId != null ||
    [status, note, blockedBy].every(
      (v) => v == null,
    ), "Step updates need --step-id");
  const result = clone(plan),
    execution = result.execution;
  require(execution, "No recorded implementation scope; apply an explicit implementation request first");
  if (executionState != null) {
    require(EXECUTION_STATES.includes(
      executionState,
    ), "Invalid execution state");
    execution.state = executionState;
  }
  if (stepId != null) {
    require(execution.selected_step_ids.includes(
      identifier(stepId),
    ), "Step is outside the recorded implementation scope");
    const step = result.steps.find((s) => s.id === stepId)!;
    require(step.kind !== "handover", "Use the handover lifecycle for checkpoints");
    if (blockedBy === "" || status === "completed") delete step.blocked_by;
    if (status != null) {
      require(STATUSES.includes(status), "Invalid checkpoint status");
      if (status === "in_progress")
        require(execution.state ===
          "approved", "Cannot start work while implementation is paused or cancelled");
      if (status === "in_progress" || status === "completed")
        checkReady(
          step,
          Object.fromEntries(result.steps.map((s) => [s.id, s])),
          [], result.steps,
        );
      if (status === "completed") {
        string(note, "completion evidence", 2000);
        delete step.blocked_by;
      }
      step.status = status;
      step.completion_source = status === "completed" ? "agent" : null;
    }
    if (note != null)
      step.progress_note = string(note, "progress note", 2000, true);
    if (blockedBy != null)
      step.blocked_by = string(blockedBy, "blocker", 2000, true);
    if (
      status != null &&
      status !== plan.steps.find((s) => s.id === stepId)!.status &&
      status !== "in_progress"
    )
      invalidateDependents(
        result,
        [stepId],
        `Prerequisite updated: ${step.title}. Check assumptions before continuing.`,
      );
  }
  validate(result);
  if (equal(result, plan)) return [result, false];
  result.revision++;
  return [result, true];
}
export function reviewStep(
  plan: Plan,
  revision: number,
  stepId: string,
  state: "current" | "needs_review",
  note: string,
): [Plan, boolean] {
  validate(plan);
  requireActive(plan);
  require(plan.revision ===
    revision, `Stale plan: current revision ${plan.revision}`);
  require(["current", "needs_review"].includes(state), "Invalid review state");
  const result = clone(plan),
    step = result.steps.find((s) => s.id === stepId);
  require(step, "Unknown step to review");
  require(step.status !==
    "completed", "Review unfinished steps; preserve completed history");
  step.review_state = state;
  step.review_note = string(note, "review evidence or reason", 2000);
  if (state === "needs_review")
    invalidateDependents(
      result,
      [stepId],
      `Prerequisite needs review: ${step.title}.`,
    );
  if (equal(result, plan)) return [result, false];
  result.revision++;
  return [validate(result), true];
}
export function summary(plan: Plan) {
  validate(plan);
  const e = plan.execution ? clone(plan.execution) : null,
    steps = Object.fromEntries(plan.steps.map((s) => [s.id, s]));
  const remaining =
    e?.selected_step_ids.filter((sid) => steps[sid].status !== "completed") ??
    [];
  const execution = e
    ? {
        ...e,
        remaining_step_ids: remaining,
        blocked_step_ids: remaining.filter((sid) => steps[sid].blocked_by),
        needs_review_step_ids: remaining.filter(
          (sid) => steps[sid].review_state === "needs_review",
        ),
      }
    : null;
  const fields = [
    "id",
    "title",
    "short_title",
    "milestone",
    "handover_after",
    "kind",
    "checks",
    "run_after",
    "status",
    "completion_source",
    "progress_note",
    "blocked_by",
    "depends_on",
    "reasoning_effort",
    "parallel_group",
    "complexity",
    "complexity_reason",
    "size",
    "estimated_files",
    "estimate_note",
    "scope_warning",
    "review_state",
    "review_note",
  ];
  return {
    plan_id: plan.plan_id,
    revision: plan.revision,
    title: plan.title,
    lifecycle: plan.lifecycle ?? "active",
    render_policy: plan.lifecycle === "finished" ? "on_request" : "on_change",
    execution,
    ...(plan.plan_reviews ? { plan_reviews: clone(plan.plan_reviews) } : {}),
    ...(plan.handovers ? { handovers: clone(plan.handovers) } : {}),
    ...(plan.execution_owner ? { execution_owner: plan.execution_owner } : {}),
    steps: plan.steps.map((step) =>
      Object.fromEntries(
        fields.filter((k) => k in step).map((k) => [k, step[k]]),
      ),
    ),
  };
}

/** Record reviewer progress without granting implementation authority. */
export function updatePlanReview(plan: Plan, revision: number, value: unknown): [Plan, boolean] {
  validate(plan);
  requireActive(plan);
  require(plan.revision === revision, `Stale plan: current revision ${plan.revision}`);
  require(record(value), "Invalid plan review update");
  require(Object.keys(value).every(k => ["request_id", "state", "task_id", "report_path", "note", "findings"].includes(k)), "Unexpected plan review field");
  const result = clone(plan);
  const review = result.plan_reviews?.find(r => r.request_id === value.request_id);
  require(review, "Unknown plan review request");
  require(value.state !== "requested", "Cannot restart a review request");
  require(review.state !== "completed" || value.state === undefined || value.state === "completed", "Cannot restart a completed review");
  require(!review.task_id || value.task_id === undefined || value.task_id === review.task_id, "Preserve the original reviewer task");
  Object.assign(review, value as Partial<PlanReview>);
  if (equal(plan, result)) return [result, false];
  result.revision++;
  return [validate(result), true];
}
