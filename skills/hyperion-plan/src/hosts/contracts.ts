import type { ChangeRequest, Plan, ReasoningEffort } from "../model";
import type { summary } from "../transitions";

/** Canonical read model. Rendering, draft state and execution authority are separate. */
export interface PlanSnapshot {
  path: string;
  plan: Plan;
  refresh_required: boolean;
  source_digest: string;
  summary: ReturnType<typeof summary>;
  export_warning?: string;
}

export interface PlanMutationResult extends PlanSnapshot {
  changed: boolean;
}

export type HostCapability =
  | { mode: "native" | "agent-mediated" }
  | { mode: "unsupported"; reason: string };

export interface HostCapabilities {
  submission: HostCapability;
  draftPersistence: HostCapability;
  sessionNavigation: HostCapability;
  workers: HostCapability;
  independentReviews: HostCapability;
  handovers: HostCapability;
  effortControl: HostCapability;
  verifiedCancellation: HostCapability;
}

/** Capability is availability, never approval. Agent-mediated still requires tool checks. */
export function requireHostCapability(capability: HostCapability): void {
  if (capability.mode === "unsupported") throw new Error(capability.reason);
}

/** Preserve native IDs verbatim: existing execution_owner values are not migrated. */
export interface HostSession {
  host: string;
  native_id: string;
}

export interface PlanSubmission {
  plan_path: string;
  skill_path: string;
  request: ChangeRequest;
  title: string;
}

/** A delivered follow-up is NOT canonical acceptance and neither means work completed. */
export type SubmissionOutcome =
  | { phase: "delivered"; request_id: string }
  | { phase: "accepted"; request_id: string; snapshot: PlanMutationResult }
  | { phase: "rejected"; request_id: string; reason: string; preserve_draft: true };

/** Draft encoding is host-owned. Existing widget/session formats need no migration. */
export interface PlanUiAdapter<Draft> {
  capabilities(): HostCapabilities;
  readDraft(): Draft | undefined;
  saveDraft(draft: Draft): Promise<void>;
  onDraft(listener: (draft: Draft | undefined) => void): () => void;
  submit(submission: PlanSubmission): Promise<SubmissionOutcome>;
  sessionLink(session: HostSession): string | undefined;
}

/** Coordinator-prepared assignment, also used by the bounded Pi runner. Data is not authority. */
export interface WorkAssignment {
  schema_version: 1;
  assignment_id: string;
  plan_path: string;
  plan_id: string;
  approved_request_id: string;
  step_id: string;
  scope_digest: string;
  owner: HostSession;
  role: "implementation" | "review";
  cwd: string;
  owned_paths: string[];
  acceptance: string[];
  evidence_directory: string;
  reasoning_effort: ReasoningEffort;
}

export interface WorkerHandle {
  assignment_id: string;
  session: HostSession;
  transcript_path: string;
}

export interface EffortEvidence {
  requested: ReasoningEffort;
  actual?: string;
  baseline?: string;
  model?: string;
  limitation?: string;
}

/** Sending abort, observing a timeout, or one rejected promise is not quiescence. */
export type Quiescence =
  | { state: "verified"; evidence: string[] }
  | { state: "unknown"; reason: string };

export interface AssignmentResult {
  assignment_id: string;
  session: HostSession;
  outcome: "succeeded" | "failed" | "cancelled" | "interrupted";
  changed_paths: string[];
  evidence: string[];
  effort: EffortEvidence;
  quiescence: Quiescence;
}

export type AssignmentState =
  | { state: "prepared" }
  | { state: "launching" }
  | { state: "running"; handle: WorkerHandle }
  | { state: "settled"; handle: WorkerHandle; result: AssignmentResult }
  | { state: "uncertain"; reason: string; handle?: WorkerHandle };

export interface AssignmentRecord {
  assignment: WorkAssignment;
  attempt_id: string;
  lifecycle: AssignmentState;
}

/** Future backend seam, not a scheduler or a declaration that a host implements it. */
export interface HostExecutionAdapter {
  capabilities(): HostCapabilities;
  launch(assignment: WorkAssignment): Promise<WorkerHandle>;
  inspect(handle: WorkerHandle): Promise<AssignmentState>;
  cancel(handle: WorkerHandle): Promise<Quiescence>;
}
