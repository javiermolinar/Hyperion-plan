import {
  Plan,
  Step,
  clone,
  equal,
  identifier,
  record,
  string,
  validate,
  applyOperations,
  prerequisites,
  reorderPendingSteps,
  requireValue as require,
} from "./model";
import { revise, requireActive } from "./transitions";

export interface Placement {
  before?: string;
  after?: string;
}
export type StepEdit =
  | {
      action: "add" | "update";
      stepId: string;
      fields: unknown;
      placement?: Placement;
    }
  | { action: "move"; stepId: string; placement: Placement }
  | { action: "remove"; stepId: string };
export interface NoteEdit {
  action: "add" | "reply";
  stepId: string;
  noteId: string;
  text: string;
}
const editableFields = new Set([
  "title",
  "short_title",
  "description",
  "done_when",
  "depends_on",
  "checks",
  "run_after",
  "complexity",
  "complexity_reason",
  "estimated_files",
  "estimate_note",
  "scope_warning",
]);
function fields(value: unknown, adding: boolean): Record<string, unknown> {
  require(record(value), "Expected a JSON object of step fields");
  for (const key of Object.keys(value))
    require(editableFields.has(key) ||
      (adding && key === "kind"), `Unsupported step field: ${key}`);
  require(Object.keys(value).length > 0, "Supply at least one step field");
  return clone(value);
}
function place(
  plan: Plan,
  id: string,
  placement: Placement,
  required: boolean,
) {
  const { before, after } = placement;
  require(!(before && after), "Choose either --before or --after");
  const target = before ?? after;
  require(!required || target != null, "Move needs --before or --after");
  if (target == null) return;
  identifier(target);
  require(target !== id, "Cannot place a step relative to itself");
  require(plan.steps.some(
    (s) => s.id === target,
  ), `Unknown placement target: ${target}`);
  const order = plan.steps.filter((s) => s.id !== id).map((s) => s.id);
  order.splice(order.indexOf(target) + (after != null ? 1 : 0), 0, id);
  plan.steps = reorderPendingSteps(plan.steps, order);
}
function finish(
  plan: Plan,
  replacement: Plan,
  revision: number,
): [Plan, boolean] {
  if (equal(plan, replacement)) return [clone(plan), false];
  return [revise(plan, replacement, revision), true];
}
function current(plan: Plan, revision: number) {
  validate(plan);
  requireActive(plan);
  require(revision ===
    plan.revision, `Stale plan: current revision ${plan.revision}`);
}
/** Focused agent edits use the same scope invalidation as whole-plan revision. */
export function editStep(
  plan: Plan,
  revision: number,
  edit: StepEdit,
): [Plan, boolean] {
  require(["add", "update", "move", "remove"].includes(
    edit.action,
  ), "Unknown step action");
  current(plan, revision);
  identifier(edit.stepId);
  let replacement = clone(plan);
  const step = replacement.steps.find((s) => s.id === edit.stepId);
  if (edit.action === "add") {
    require(!step, "Step ID already exists");
    const patch = fields(edit.fields, true);
    replacement.steps.push({
      ...patch,
      id: edit.stepId,
      title: string(patch.title, "step title", 200),
      status: "pending",
      comments: [],
    });
    place(replacement, edit.stepId, edit.placement ?? {}, false);
  } else {
    require(step, `Unknown step: ${edit.stepId}`);
    if (edit.action === "update") {
      const patch = fields(edit.fields, false);
      Object.assign(step, patch);
    } else if (edit.action === "move") {
      require(step.status === "pending", "Only pending tasks can be reordered");
      place(replacement, edit.stepId, edit.placement, true);
    } else {
      replacement = applyOperations(plan, [
        { type: "remove_step", step_id: edit.stepId },
      ]);
    }
  }
  return finish(plan, replacement, revision);
}
export function editNote(
  plan: Plan,
  revision: number,
  edit: NoteEdit,
): [Plan, boolean] {
  require(["add", "reply"].includes(edit.action), "Unknown note action");
  current(plan, revision);
  identifier(edit.stepId);
  identifier(edit.noteId);
  let replacement = clone(plan);
  if (edit.action === "add") {
    replacement = applyOperations(plan, [
      {
        type: "add_comment",
        step_id: edit.stepId,
        comment_id: edit.noteId,
        text: string(edit.text, "comment", 1000),
      },
    ]);
  } else {
    const step = replacement.steps.find((s) => s.id === edit.stepId);
    require(step, `Unknown step: ${edit.stepId}`);
    const note = step.comments?.find((n) => n.id === edit.noteId);
    require(note, `Unknown note: ${edit.noteId}`);
    note.response = string(edit.text, "comment response", 2000);
    note.state = "acknowledged";
  }
  return finish(plan, replacement, revision);
}
/** No execution is started; only already-approved, immediately ready work is returned. */
export function nextSteps(plan: Plan, refreshRequired = false) {
  validate(plan);
  const execution = plan.execution;
  const selected = new Set(execution?.selected_step_ids ?? []);
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const ready: Step[] = [],
    inProgress: Step[] = [];
  const blocked: {
    step: Step;
    reasons: string[];
    prerequisite_ids: string[];
  }[] = [];
  for (const step of plan.steps) {
    if (!selected.has(step.id) || step.status === "completed") continue;
    const reasons: string[] = [];
    if (plan.lifecycle === "finished") reasons.push("Plan is finished; reopen it and select work before continuing");
    if (refreshRequired)
      reasons.push(
        "Refresh external Markdown changes with status before continuing",
      );
    if (execution!.state !== "approved")
      reasons.push(`Execution is ${execution!.state}`);
    if (step.review_state === "needs_review")
      reasons.push(step.review_note || "Step needs review");
    if (step.blocked_by) reasons.push(step.blocked_by);
    const missing = prerequisites(step).filter(
      (id) => byId.get(id)!.status !== "completed",
    );
    for (const id of missing)
      reasons.push(
        `Prerequisite is not complete: ${id} (${byId.get(id)!.title})`,
      );
    if (reasons.length)
      blocked.push({ step, reasons, prerequisite_ids: missing });
    else if (step.status === "in_progress") inProgress.push(step);
    else ready.push(step);
  }
  return {
    plan_id: plan.plan_id,
    revision: plan.revision,
    lifecycle: plan.lifecycle ?? "active",
    execution_state: execution?.state ?? "unapproved",
    refresh_required: refreshRequired,
    ready_steps: ready,
    in_progress_steps: inProgress,
    blocked_steps: blocked,
    unselected_step_ids: plan.steps
      .filter((s) => s.status !== "completed" && !selected.has(s.id))
      .map((s) => s.id),
  };
}
export function planChanges(before: Plan | undefined, after: Plan) {
  const planFields = Object.fromEntries(
    [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]
      .filter(
        (key) =>
          !["steps", "execution", "applied_requests", "revision"].includes(key),
      )
      .filter(
        (key) =>
          !equal(
            before?.[key as keyof Plan] ?? null,
            after[key as keyof Plan] ?? null,
          ),
      )
      .map((key) => [
        key,
        {
          before: before?.[key as keyof Plan] ?? null,
          after: after[key as keyof Plan] ?? null,
        },
      ]),
  );
  const previous = new Map(before?.steps.map((s) => [s.id, s]) ?? []);
  const current = new Map(after.steps.map((s) => [s.id, s]));
  const updated = after.steps.flatMap((step) => {
    const old = previous.get(step.id);
    if (!old) return [];
    const changed = Object.fromEntries(
      [...new Set([...Object.keys(old), ...Object.keys(step)])]
        .filter((key) => !equal(old[key] ?? null, step[key] ?? null))
        .map((key) => [
          key,
          { before: old[key] ?? null, after: step[key] ?? null },
        ]),
    );
    return Object.keys(changed).length
      ? [{ step_id: step.id, fields: changed }]
      : [];
  });
  return {
    plan_fields: planFields,
    added_steps: after.steps.filter((s) => !previous.has(s.id)),
    removed_steps: [...previous.values()].filter((s) => !current.has(s.id)),
    updated_steps: updated,
    order: {
      before: before?.steps.map((s) => s.id) ?? [],
      after: after.steps.map((s) => s.id),
    },
    execution: {
      before: before?.execution ?? null,
      after: after.execution ?? null,
    },
  };
}
