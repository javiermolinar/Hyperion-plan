import { JsonNumber, floatJSON, parseJSON } from "./json";
/** Shared wire model. Unknown metadata is retained for Markdown compatibility. */
export type Status = "pending" | "in_progress" | "completed";
export type ExecutionState = "approved" | "paused" | "cancelled";
export type ExecutionMode = "auto" | "sequential" | "parallel";
export type Lifecycle = "active" | "finished";
export type Intent = "ask" | "edit" | "implement" | "review" | "decompose" | "replan" | "finish" | "reopen" | "handover";
export interface Note {
  id: string;
  text: string;
  state: "pending" | "acknowledged";
  response?: string;
  [key: string]: unknown;
}
export const REASONING_EFFORTS = ["inherit", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export interface Step {
  id: string;
  title: string;
  status: Status;
  description?: string;
  done_when?: string;
  comments?: Note[];
  short_title?: string;
  milestone?: string;
  handover_after?: string;
  kind?: "implementation" | "review" | "handover";
  checks?: string[];
  depends_on?: string[];
  run_after?: string;
  completion_source?: "user" | "agent" | null;
  progress_note?: string;
  blocked_by?: string;
  size?: "S" | "M" | "L" | "XL" | "unknown";
  complexity?: "low" | "moderate" | "high" | "unknown";
  complexity_reason?: string;
  reasoning_effort?: ReasoningEffort;
  parallel_group?: number;
  estimated_files?: number | null;
  estimate_note?: string;
  scope_warning?: string;
  review_state?: "current" | "needs_review";
  review_note?: string;
  needs_replanning?: boolean;
  [key: string]: unknown;
}
export interface Execution {
  request_id: string;
  state: ExecutionState;
  selected_step_ids: string[];
  execution_mode?: ExecutionMode;
}
export interface PlanReview {
  request_id: string;
  revision: number;
  target_step_ids: string[];
  focus: string;
  state: "requested" | "running" | "completed" | "blocked";
  task_id?: string;
  report_path?: string;
  note?: string;
  findings: { step_ids: string[]; text: string; resolution: "applied" | "not_adopted" | "needs_input"; reason: string }[];
}
export interface Handover {
  request_id: string;
  revision: number;
  created_at: string;
  state: "requested" | "prepared" | "transferred" | "blocked" | "cancelled";
  position: "during" | "after" | "between";
  step_id?: string;
  step_title?: string;
  reason: string;
  source_task_id?: string;
  destination_task_id?: string;
  brief_path?: string;
  summary?: string;
  next_action?: string;
  code_state?: string;
  context_digest?: string;
  note?: string;
  transferred_at?: string;
}
export interface Plan {
  schema_version: 1;
  plan_id: string;
  revision: number;
  title: string;
  steps: Step[];
  preamble?: string;
  applied_requests?: Record<string, string>;
  execution?: Execution;
  lifecycle?: Lifecycle;
  plan_reviews?: PlanReview[];
  handovers?: Handover[];
  execution_owner?: string;
  [key: string]: unknown;
}
export type Operation =
  | {
      type: "add_step";
      step_id: string;
      title: string;
      description?: string;
      done_when?: string;
      kind?: Step["kind"];
      milestone?: string;
      reasoning_effort?: ReasoningEffort;
      depends_on?: string[];
      checks?: string[];
      run_after?: string;
      after_step_id?: string;
    }
  | { type: "set_reasoning_effort"; step_id: string; reasoning_effort: ReasoningEffort }
  | { type: "set_handover_point"; step_id: string; reason: string }
  | { type: "remove_step"; step_id: string }
  | { type: "reorder_steps"; step_ids: string[] }
  | { type: "move_review"; step_id: string; after_step_id: string }
  | {
      type: "update_review";
      step_id: string;
      depends_on: string[];
      checks: string[];
    }
  | { type: "set_status"; step_id: string; status: "pending" | "completed" }
  | { type: "add_comment"; step_id: string; comment_id: string; text: string }
  | { type: "remove_comment"; step_id: string; comment_id: string };
export interface ChangeRequest {
  plan_id: string;
  request_id: string;
  base_revision: number;
  intent?: Intent;
  operations: Operation[];
  selected_step_ids?: string[];
  selection_snapshot?: Step[];
  execution_mode?: ExecutionMode;
  target_step_ids?: string[];
  review_mode?: "refresh" | "independent";
  review_focus?: string;
  handover_reason?: string;
  question?: string;
}
export interface CardConfig {
  plan: Plan;
  plan_path: string;
  source_name: string;
  skill_path: string;
  preview: boolean;
}
export const STATUSES = ["pending", "in_progress", "completed"] as const;
export const EXECUTION_STATES = ["approved", "paused", "cancelled"] as const;
export function requireValue(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function string(
  value: unknown,
  name: string,
  limit: number,
  empty = false,
): string {
  requireValue(
    typeof value === "string" && [...value].length <= limit,
    `Invalid ${name}`,
  );
  requireValue(empty || !!value.trim(), `Empty ${name}`);
  return value;
}
export function identifier(value: unknown): string {
  requireValue(
    typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value),
    "Invalid ID",
  );
  return value;
}
export function prerequisites(step: Step): string[] {
  return [
    ...new Set([
      ...(step.depends_on || []),
      ...(step.run_after ? [step.run_after] : []),
    ]),
  ];
}
function defaultValue<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}
export function clone<T>(value: T): T {
  return parseJSON(JSON.stringify(value)) as T;
}
/** Python json.dumps(sort_keys=True) wire encoding, retained for stored receipts/fingerprints. */
export function canonicalJSON(value: unknown): string {
  if (value instanceof JsonNumber) return value.token;
  if (value === null) return "null";
  if (typeof value === "string")
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    );
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Non-finite numeric metadata is unsupported");
    if (Number.isInteger(value)) {
      requireValue(
        Number.isSafeInteger(value),
        "Unsafe numeric metadata must be read from lossless JSON",
      );
      return String(value);
    }
    return floatJSON(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJSON).join(", ") + "]";
  requireValue(record(value), "Expected JSON data");
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => canonicalJSON(k) + ": " + canonicalJSON(value[k]))
      .join(", ") +
    "}"
  );
}
export function equal(a: unknown, b: unknown): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}
export function validate(value: unknown): Plan {
  requireValue(
    record(value) && value.schema_version === 1,
    "Unsupported plan schema",
  );
  const plan = value as unknown as Plan;
  identifier(plan.plan_id);
  requireValue(
    Number.isSafeInteger(plan.revision) && plan.revision >= 1,
    "Invalid revision",
  );
  string(plan.title, "plan title", 200);
  requireValue(plan.lifecycle === undefined || ["active", "finished"].includes(plan.lifecycle), "Invalid plan lifecycle");
  if (plan.execution_owner !== undefined) identifier(plan.execution_owner);
  if (plan.handovers !== undefined) {
    requireValue(Array.isArray(plan.handovers), "Invalid handover history");
    requireValue(plan.handovers.filter(h => record(h) && ["requested", "prepared", "blocked"].includes(h.state)).length <= 1, "A handover is already active");
    const ids = new Set<string>();
    for (const h of plan.handovers) {
      requireValue(record(h), "Invalid handover event");
      identifier(h.request_id);
      requireValue(!ids.has(h.request_id), "Duplicate handover request"); ids.add(h.request_id);
      requireValue(Number.isSafeInteger(h.revision) && h.revision > 0 && h.revision <= plan.revision, "Invalid handover revision");
      requireValue(typeof h.created_at === "string" && Number.isFinite(Date.parse(h.created_at)), "Invalid handover timestamp");
      requireValue(["requested", "prepared", "transferred", "blocked", "cancelled"].includes(h.state), "Invalid handover state");
      requireValue(["during", "after", "between"].includes(h.position), "Invalid handover position");
      if (h.position === "between") requireValue(h.step_id === undefined && h.step_title === undefined, "Between-step handover cannot name a step");
      else { identifier(h.step_id); string(h.step_title, "handover step title", 200); }
      string(h.reason, "handover reason", 2000);
      for (const field of ["source_task_id", "destination_task_id"] as const) if (h[field] !== undefined) identifier(h[field]);
      requireValue(!h.destination_task_id || (!!h.source_task_id && h.destination_task_id !== h.source_task_id), "Handover needs distinct source and destination tasks");
      for (const field of ["brief_path", "summary", "next_action", "code_state", "note", "context_digest"] as const)
        if (h[field] !== undefined) string(h[field], field, 4000);
      if (["prepared", "transferred"].includes(h.state)) {
        identifier(h.source_task_id);
        for (const field of ["brief_path", "summary", "next_action", "code_state", "context_digest"] as const) string(h[field], field, 4000);
      }
      if (h.state === "transferred") {
        identifier(h.destination_task_id);
        requireValue(typeof h.transferred_at === "string" && Number.isFinite(Date.parse(h.transferred_at)), "Invalid transfer timestamp");
      }
      if (["blocked", "cancelled"].includes(h.state)) string(h.note, "handover outcome", 4000);
    }
  }
  if (plan.plan_reviews !== undefined) {
    requireValue(Array.isArray(plan.plan_reviews), "Invalid plan reviews");
    requireValue(plan.plan_reviews.filter(r => record(r) && ["requested", "running"].includes(r.state)).length <= 1, "An independent plan review is already active");
    const reviewIds = new Set<string>();
    for (const review of plan.plan_reviews) {
      requireValue(record(review), "Invalid plan review");
      identifier(review.request_id);
      requireValue(!reviewIds.has(review.request_id), "Duplicate plan review");
      reviewIds.add(review.request_id);
      requireValue(Number.isSafeInteger(review.revision) && review.revision > 0 && review.revision <= plan.revision, "Invalid reviewed revision");
      requireValue(Array.isArray(review.target_step_ids) && review.target_step_ids.length > 0 && review.target_step_ids.length <= 30, "Invalid review targets");
      review.target_step_ids.forEach(identifier);
      requireValue(new Set(review.target_step_ids).size === review.target_step_ids.length, "Duplicate review target");
      requireValue(typeof review.focus === "string" && review.focus.length <= 2000, "Invalid review focus");
      requireValue(["requested", "running", "completed", "blocked"].includes(review.state), "Invalid plan review state");
      if (review.task_id !== undefined) identifier(review.task_id);
      for (const key of ["report_path", "note"] as const)
        if (review[key] !== undefined) string(review[key], key, 4000);
      requireValue(Array.isArray(review.findings) && review.findings.length <= 100, "Invalid review findings");
      for (const finding of review.findings) {
        requireValue(record(finding), "Invalid review finding");
        string(finding.text, "finding", 4000);
        string(finding.reason, "resolution reason", 4000);
        requireValue(["applied", "not_adopted", "needs_input"].includes(finding.resolution), "Invalid finding resolution");
        requireValue(Array.isArray(finding.step_ids) && finding.step_ids.every(id => review.target_step_ids.includes(id)), "Finding outside review scope");
      }
      if (review.state === "running" || review.state === "completed") requireValue(!!review.task_id, "Review needs a task ID");
      if (review.state === "completed") requireValue(!!review.report_path, "Completed review needs a report");
      if (review.state === "blocked") requireValue(!!review.note, "Blocked review needs a reason");
    }
  }
  const steps = plan.steps;
  requireValue(
    Array.isArray(steps) && steps.length <= 30,
    "A plan supports up to 30 steps",
  );
  const ids = new Set<string>(),
    commentIds = new Set<string>();
  for (const step of steps) {
    requireValue(record(step), "Invalid step");
    const sid = identifier(step.id);
    requireValue(!ids.has(sid), "Duplicate step ID");
    ids.add(sid);
    string(step.title, "step title", 200);
    string(defaultValue(step.short_title, ""), "short title", 80, true);
    if (step.handover_after !== undefined) string(step.handover_after, "handover point reason", 2000, true);
    if (step.milestone !== undefined) string(step.milestone, "milestone", 100, true);
    string(defaultValue(step.description, ""), "description", 4000, true);
    string(defaultValue(step.done_when, ""), "done_when", 2000, true);
    requireValue(
      ["implementation", "review", "handover"].includes(
        defaultValue(step.kind, "implementation"),
      ),
      "Invalid step kind",
    );
    const checks = defaultValue(step.checks, []);
    requireValue(
      Array.isArray(checks) && checks.length <= 12,
      "Invalid review checks",
    );
    for (const check of checks) string(check, "review check", 500);
    if (step.kind === "review") {
      requireValue(checks.length, "A review needs at least one check");
      requireValue(step.depends_on?.length, "A review needs work to review");
      if ("run_after" in step) identifier(step.run_after);
    } else {
      requireValue(!checks.length, "Only review steps have review checks");
      requireValue(
        !("run_after" in step),
        "Only reviews have a run-after constraint",
      );
    }
    requireValue(STATUSES.includes(step.status), "Invalid step status");
    if (step.kind === "handover" && step.status !== "pending")
      requireValue(plan.handovers?.some(h => h.step_id === step.id &&
        (step.status === "completed" ? h.state === "transferred" : ["requested", "prepared", "blocked"].includes(h.state))),
        "Handover checkpoint status must match its transfer event");
    requireValue(
      step.completion_source == null ||
        ["user", "agent"].includes(step.completion_source),
      "Invalid completion source",
    );
    string(defaultValue(step.progress_note, ""), "progress note", 2000, true);
    string(defaultValue(step.blocked_by, ""), "blocker", 2000, true);
    requireValue(
      !(step.status === "completed" && step.blocked_by),
      "Completed step cannot remain blocked",
    );
    requireValue(
      ["S", "M", "L", "XL", "unknown"].includes(
        defaultValue(step.size, "unknown"),
      ),
      "Invalid effort size",
    );
    requireValue(
      ["low", "moderate", "high", "unknown"].includes(
        defaultValue(step.complexity, "unknown"),
      ),
      "Invalid complexity",
    );
    requireValue(
      step.reasoning_effort === undefined || REASONING_EFFORTS.includes(step.reasoning_effort),
      "Invalid reasoning effort",
    );
    requireValue(step.parallel_group === undefined || (Number.isSafeInteger(step.parallel_group) && step.parallel_group! > 0 && step.parallel_group! <= 30 && !["review", "handover"].includes(step.kind ?? "implementation")), "Invalid parallel group");
    string(
      defaultValue(step.complexity_reason, ""),
      "complexity rationale",
      2000,
      true,
    );
    if (defaultValue(step.complexity, "unknown") !== "unknown")
      string(step.complexity_reason, "complexity rationale", 2000);
    requireValue(
      step.estimated_files == null ||
        (Number.isSafeInteger(step.estimated_files) &&
          step.estimated_files >= 0 &&
          step.estimated_files <= 10000),
      "Invalid file estimate",
    );
    for (const field of [
      "estimate_note",
      "scope_warning",
      "review_note",
    ] as const)
      string(defaultValue(step[field], ""), field, 2000, true);
    requireValue(
      ["current", "needs_review"].includes(
        defaultValue(step.review_state, "current"),
      ),
      "Invalid review state",
    );
    requireValue(step.needs_replanning === undefined || typeof step.needs_replanning === "boolean", "Invalid replanning state");
    if (step.review_state === "needs_review") {
      string(step.review_note, "reason for review", 2000);
      requireValue(
        step.status !== "completed",
        "Reopen a completed step before marking it stale",
      );
    }
    const deps = defaultValue(step.depends_on, []);
    requireValue(
      Array.isArray(deps) && deps.length <= 30,
      "Invalid prerequisites",
    );
    for (const dep of deps) identifier(dep);
    requireValue(
      new Set(deps).size === deps.length && !deps.includes(sid),
      "Duplicate or self prerequisite",
    );
    const comments = defaultValue(step.comments, []);
    requireValue(
      Array.isArray(comments) && comments.length <= 20,
      "Too many comments",
    );
    for (const comment of comments) {
      requireValue(record(comment), "Invalid comment");
      const cid = identifier(comment.id);
      requireValue(!commentIds.has(cid), "Duplicate comment ID");
      commentIds.add(cid);
      string(comment.text, "comment", 1000);
      requireValue(
        ["pending", "acknowledged"].includes(comment.state),
        "Invalid comment state",
      );
      string(
        defaultValue(comment.response, ""),
        "comment response",
        2000,
        true,
      );
    }
  }
  const graph = new Map(steps.map((s) => [s.id, prerequisites(s)])),
    visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(sid: string) {
    requireValue(graph.has(sid), `Unknown prerequisite: ${sid}`);
    requireValue(!visiting.has(sid), "Dependency cycle in plan");
    if (visited.has(sid)) return;
    visiting.add(sid);
    for (const dep of graph.get(sid)!) visit(dep);
    visiting.delete(sid);
    visited.add(sid);
  }
  for (const sid of graph.keys()) visit(sid);
  const positions = new Map(steps.map((s, i) => [s.id, i])),
    byId = new Map(steps.map((s) => [s.id, s]));
  for (const step of steps)
    if (step.kind === "review") {
      if (step.run_after)
        requireValue(
          positions.get(step.run_after)! < positions.get(step.id)!,
          "Run-after step must precede the review",
        );
      for (const target of step.depends_on!) {
        requireValue(
          !["review", "handover"].includes(byId.get(target)!.kind ?? "implementation"),
          "Review scope must name implementation steps",
        );
        requireValue(
          positions.get(target)! < positions.get(step.id)!,
          "Place a review after all work it covers",
        );
      }
    }
  // Group membership is a planning decision, but cannot contradict ordering.
  for (const step of steps) {
    if (!step.parallel_group) continue;
    const ancestors = new Set<string>();
    const collect = (id: string) => { for (const dep of graph.get(id)!) if (!ancestors.has(dep)) { ancestors.add(dep); collect(dep); } };
    collect(step.id);
    requireValue(![...ancestors].some(id => byId.get(id)!.parallel_group === step.parallel_group), "Parallel group contains dependent steps");
    const members = steps.filter(s => s.parallel_group === step.parallel_group);
    const first = Math.min(...members.map(s => positions.get(s.id)!));
    const last = Math.max(...members.map(s => positions.get(s.id)!));
    requireValue(!steps.slice(first, last + 1).some(s => s.kind === "review" || s.kind === "handover"), "Parallel group crosses a review or handover");
  }
  const receipts = defaultValue(plan.applied_requests, {});
  requireValue(record(receipts), "Invalid request receipts");
  for (const [key, v] of Object.entries(receipts)) {
    identifier(key);
    requireValue(
      typeof v === "string" && /^[0-9a-f]{64}$/.test(v),
      "Invalid receipt",
    );
  }
  if (plan.execution != null) {
    const execution = plan.execution;
    requireValue(record(execution), "Invalid execution scope");
    requireValue(
      Object.hasOwn(receipts, identifier(execution.request_id)),
      "Execution scope needs a recorded request",
    );
    requireValue(
      EXECUTION_STATES.includes(execution.state),
      "Invalid execution state",
    );
    requireValue(
      execution.execution_mode === undefined || ["auto", "sequential", "parallel"].includes(execution.execution_mode),
      "Invalid execution mode",
    );
    const selected = execution.selected_step_ids;
    requireValue(
      Array.isArray(selected) && selected.length <= 30,
      "Invalid execution selection",
    );
    for (const sid of selected)
      requireValue(
        ids.has(identifier(sid)),
        "Execution refers to an absent step",
      );
    requireValue(
      new Set(selected).size === selected.length,
      "Duplicate execution step",
    );
  }
  requireValue(
    new TextEncoder().encode(canonicalJSON(plan)).length < 250000,
    "Plan is too large",
  );
  return plan;
}
export function preserveHistory(
  previous: Record<string, { status: Status }>,
  steps: Step[],
): void {
  const remaining = new Set(steps.map((s) => s.id)),
    missing = Object.entries(previous)
      .filter(
        ([id, s]) =>
          ["completed", "in_progress"].includes(s.status) && !remaining.has(id),
      )
      .map(([id]) => id);
  requireValue(
    !missing.length,
    "Keep completed or active steps in plan history: " + missing.join(", "),
  );
}
export function invalidateDependents(
  plan: Plan,
  changedIds: Iterable<string>,
  reason: string,
): void {
  const changed = new Set(changedIds),
    affected = new Set(changed);
  for (let pass = 0; pass < plan.steps.length; pass++)
    for (const s of plan.steps)
      if (prerequisites(s).some((id) => affected.has(id))) affected.add(s.id);
  for (const s of plan.steps)
    if (affected.has(s.id) && !changed.has(s.id) && s.status !== "completed") {
      s.review_state = "needs_review";
      s.review_note = reason;
    }
}
/** Include phase boundaries crossed by a run and the boundary immediately following it. */
export function withHandoverCheckpoints(steps: Step[], selected: string[]): string[] {
  if (!selected.length) return [];
  if (!steps.some(s => s.kind === "handover")) return [...selected];
  const ids = new Set(selected);
  const last = steps.reduce((index, step, i) => ids.has(step.id) ? i : index, -1);
  for (const step of steps.slice(0, last + 1))
    if (step.kind === "handover" && step.status !== "completed") ids.add(step.id);
  const next = steps.slice(last + 1).find(s => s.status !== "completed");
  if (next?.kind === "handover" && next.status === "pending") {
    // A trailing boundary is optional: partial runs must remain executable.
    try {
      checkReady(next, Object.fromEntries(steps.map(s => [s.id, s])), [...ids], steps);
      ids.add(next.id);
    } catch {
      // Leave an unreachable, blocked, or stale checkpoint for a later run.
    }
  }
  // Retain unknown IDs so normal selection validation rejects them.
  return [...steps.filter(s => ids.has(s.id)).map(s => s.id), ...selected.filter(id => !steps.some(s => s.id === id))];
}
/** Selection can span an authorized boundary; execution must wait for actual transfer. */
export function handoverBlocker(steps: Step[], step: Step, selected: string[] = []): string {
  const before = steps.slice(0, steps.findIndex(s => s.id === step.id));
  for (const boundary of before.filter(s => s.kind === "handover" && s.status !== "completed")) {
    if (!selected.includes(boundary.id)) return `Automatic handover first: ${boundary.title}`;
    if (boundary.blocked_by) return `Resolve handover checkpoint: ${boundary.title}`;
    if (steps.slice(0, steps.indexOf(boundary)).some(s => s.status !== "completed" && !selected.includes(s.id)))
      return "Select preceding work to reach the automatic handover";
  }
  if (step.kind === "handover" && before.some(s => s.status !== "completed" && !selected.includes(s.id)))
    return "Complete or select the preceding steps before handing over";
  return "";
}
export function checkReady(
  step: Step,
  available: Record<string, Step>,
  selected: string[] = [],
  orderedSteps?: Step[],
): void {
  if (orderedSteps) requireValue(!handoverBlocker(orderedSteps, step, selected), handoverBlocker(orderedSteps, step, selected));
  requireValue(!step.needs_replanning, `Needs replanning: ${step.id}. Resume with updated scope.`);
  requireValue(!step.blocked_by, `Step is blocked: ${step.id}`);
  for (const dep of prerequisites(step))
    requireValue(
      available[dep].status === "completed" || selected.includes(dep),
      `Missing prerequisite for ${step.id}: ${dep}`,
    );
}
export function preserveProtectedOrder(original: Step[], steps: Step[]): void {
  const fixed = original.filter((s) => s.status !== "pending").map((s) => s.id);
  const ids = new Set(fixed);
  requireValue(
    equal(
      fixed,
      steps.filter((s) => ids.has(s.id)).map((s) => s.id),
    ),
    "Only pending tasks can be reordered; preserve original protected history",
  );
}
export function validateStepOrder(steps: Step[]): void {
  const positions = new Map(steps.map((s, index) => [s.id, index]));
  const titles = new Map(steps.map((s) => [s.id, s.title]));
  for (const step of steps)
    for (const dep of prerequisites(step))
      requireValue(
        positions.has(dep) && positions.get(dep)! < positions.get(step.id)!,
        `Keep “${step.title}” after “${titles.get(dep) || dep}”`,
      );
}
/** Reorder pending work while preserving protected history's relative order. */
export function reorderPendingSteps<T extends Step>(
  steps: T[],
  ids: unknown,
  original: Step[] = steps,
): T[] {
  requireValue(
    Array.isArray(ids) && ids.length === steps.length,
    "Order must include every task exactly once",
  );
  ids.forEach(identifier);
  const byId = new Map(steps.map((step) => [step.id, step]));
  requireValue(
    new Set(ids).size === steps.length && ids.every((id) => byId.has(id)),
    "Order must include every task exactly once",
  );
  const protectedIds = new Set(
    steps.filter((step) => step.status !== "pending").map((step) => step.id),
  );
  const fixed = steps
    .filter((step) => protectedIds.has(step.id))
    .map((step) => step.id);
  requireValue(
    ids
      .filter((id) => protectedIds.has(id))
      .every((id, index) => fixed[index] === id),
    "Only pending tasks can be reordered",
  );
  const reordered = ids.map((id) => byId.get(id)!);
  preserveProtectedOrder(original, reordered);
  validateStepOrder(reordered);
  return reordered;
}

/** Shared by the CLI and restored browser drafts. Does not grant execution authority. */
export function applyOperations(plan: Plan, operations: unknown): Plan {
  requireValue(
    Array.isArray(operations) && operations.length <= 100,
    "Expected at most 100 operations",
  );
  const result = clone(plan),
    original = Object.fromEntries(plan.steps.map((s) => [s.id, s])),
    changedStatuses = new Set<string>();
  const revoke = (sid: string) => {
    if (result.execution)
      result.execution.selected_step_ids =
        result.execution.selected_step_ids.filter((id) => id !== sid);
  };
  for (const raw of operations) {
    requireValue(record(raw), "Invalid operation");
    const kind = raw.type,
      op = raw as unknown as Operation;
    if (op.type === "reorder_steps") {
      result.steps = reorderPendingSteps(result.steps, op.step_ids, plan.steps);
      continue;
    }
    const sid = identifier(raw.step_id);
    const step = result.steps.find((s) => s.id === sid);
    if (op.type === "add_step") {
      requireValue(!step, "Step ID already exists");
      const added: Step = {
        id: sid,
        title: string(op.title, "step title", 200),
        description: string(
          defaultValue(op.description, ""),
          "description",
          4000,
          true,
        ),
        done_when: string(
          defaultValue(op.done_when, ""),
          "done_when",
          2000,
          true,
        ),
        status: "pending",
        comments: [],
      };
      for (const field of [
        "kind",
        "milestone",
        "reasoning_effort",
        "depends_on",
        "checks",
        "run_after",
      ] as const)
        if (field in op) Object.assign(added, { [field]: clone(op[field]) });
      let index = result.steps.length;
      if ("after_step_id" in op) {
        const after = identifier(op.after_step_id);
        requireValue(
          result.steps.some((s) => s.id === after),
          "Unknown placement target",
        );
        index = result.steps.findIndex((s) => s.id === after) + 1;
        if (added.kind === "review" && !("run_after" in added))
          added.run_after = after;
      }
      result.steps.splice(index, 0, added);
      continue;
    }
    requireValue(step, `Unknown step: ${sid}`);
    if (op.type === "move_review" || op.type === "update_review") {
      requireValue(step.kind === "review", "Expected a review step");
      requireValue(
        step.status === "pending" &&
          (!Object.hasOwn(original, sid) || original[sid].status === "pending"),
        "Only pending reviews can be edited or moved",
      );
      if (op.type === "move_review") {
        const after = identifier(op.after_step_id);
        requireValue(
          after !== sid && result.steps.some((s) => s.id === after),
          "Unknown placement target",
        );
        result.steps.splice(result.steps.indexOf(step), 1);
        result.steps.splice(
          result.steps.findIndex((s) => s.id === after) + 1,
          0,
          step,
        );
        step.run_after = after;
        revoke(sid);
      } else {
        requireValue(Array.isArray(op.depends_on), "Invalid review scope");
        for (const target of op.depends_on) identifier(target);
        step.depends_on = clone(op.depends_on);
        step.checks = clone(op.checks);
        revoke(sid);
        invalidateDependents(
          result,
          [sid],
          "Review scope changed. Check this step against the updated plan.",
        );
      }
    } else if (op.type === "remove_step") {
      requireValue(
        step.status === "pending" &&
          (Object.hasOwn(original, sid) ? original[sid] : step).status ===
            "pending",
        "Keep completed or active steps in plan history",
      );
      result.steps.splice(result.steps.indexOf(step), 1);
      revoke(sid);
    } else if (op.type === "set_reasoning_effort") {
      requireValue(REASONING_EFFORTS.includes(op.reasoning_effort), "Invalid reasoning effort");
      step.reasoning_effort = op.reasoning_effort;
    } else if (op.type === "set_handover_point") {
      const reason = string(op.reason, "handover point reason", 2000, true);
      if (reason.trim()) step.handover_after = reason;
      else delete step.handover_after;
    } else if (op.type === "set_status") {
      requireValue(step.kind !== "handover", "Handover checkpoints complete only when ownership transfers");
      requireValue(
        ["pending", "completed"].includes(op.status),
        "Invalid user completion status",
      );
      if (step.status !== op.status) changedStatuses.add(sid);
      step.status = op.status;
      step.completion_source = op.status === "completed" ? "user" : null;
      delete step.blocked_by;
      delete step.progress_note;
      if (step.status === "completed") {
        step.review_state = "current";
        delete step.review_note;
      }
    } else if (op.type === "add_comment") {
      (step.comments ??= []).push({
        id: identifier(op.comment_id),
        text: string(op.text, "comment", 1000),
        state: "pending",
      });
    } else if (op.type === "remove_comment") {
      const cid = identifier(op.comment_id);
      requireValue(
        step.comments?.some((c) => c.id === cid),
        "Unknown comment",
      );
      step.comments = step.comments!.filter((c) => c.id !== cid);
    } else throw new Error(`Unknown operation: ${String(kind)}`);
  }
  validate(result);
  preserveProtectedOrder(plan.steps, result.steps);
  if (
    operations.some((op) =>
      [
        "reorder_steps",
        "move_review",
        "update_review",
        "add_step",
        "remove_step",
      ].includes(op.type),
    )
  )
    validateStepOrder(result.steps);
  if (changedStatuses.size)
    invalidateDependents(
      result,
      changedStatuses,
      "A prerequisite's progress changed. Check this step against the current code.",
    );
  return result;
}
