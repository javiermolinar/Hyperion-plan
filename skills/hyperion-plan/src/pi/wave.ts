import * as path from "node:path";
import { clone, requireValue as require, type Plan } from "../model";
import { canonicalPath } from "../storage";
import { stepFingerprint } from "../transitions";
import { assertStepExecutionAllowed, type ExecutionAuthority } from "../execution-policy";
import type { WorkAssignment, Quiescence } from "../hosts/contracts";
import type { DispatchRecord } from "./dispatch-ledger";

export interface PiWaveCandidate {
  assignment: WorkAssignment;
  attempt_id: string;
  /** Exact live inputs; captured context strings need no read claim. */
  read_paths: string[];
  /** Exclusive logical resources, including shared interfaces/generators. */
  resources: string[];
  /** Coordinator assessment, not a parallel_group badge or worker assertion. */
  independence_evidence: string[];
}
export interface PiWaveSelection {
  mode: "sequential" | "parallel";
  reason: string;
  selected: PiWaveCandidate[];
  deferred: { step_id: string; reason: string }[];
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
// Conservative case/Unicode folding also serializes ambiguous new-file aliases.
const fileKey = (file: string) => canonicalPath(file).normalize("NFC").toLowerCase();
const evidence = (items: string[]) => Array.isArray(items) && items.some(x => typeof x === "string" && x.trim());
export function piWaveConflict(a: PiWaveCandidate, b: PiWaveCandidate): boolean {
  const aw = a.assignment.owned_paths.map(fileKey), bw = b.assignment.owned_paths.map(fileKey);
  const ar = a.read_paths.map(fileKey), br = b.read_paths.map(fileKey);
  return aw.some(x => [...bw, ...br].some(y => overlaps(x, y))) ||
    bw.some(x => ar.some(y => overlaps(x, y))) || a.resources.some(r => b.resources.includes(r));
}
function admit(plan: Plan, candidate: PiWaveCandidate, authority: ExecutionAuthority, status: "pending" | "in_progress"): void {
  const a = candidate.assignment;
  require(a.schema_version === 1 && a.role === "implementation", "A wave cannot contain reviews or handovers");
  require(a.plan_id === plan.plan_id && a.approved_request_id === authority.requestId && a.owner.host === "pi" &&
    Boolean(authority.actorId) && a.owner.native_id === authority.actorId, "Wave plan/request/coordinator mismatch");
  const step = assertStepExecutionAllowed(plan, a.step_id, authority);
  require((step.kind ?? "implementation") === "implementation" && step.status === status,
    status === "pending" ? "Only pending ready steps may enter a new wave; inspect existing work" : "Save each start before dispatch");
  require(a.scope_digest === stepFingerprint(step).scope && a.reasoning_effort === (step.reasoning_effort ?? "inherit"), "Wave scope/effort changed");
  require([a.assignment_id, candidate.attempt_id].every(x => typeof x === "string" && x.trim()), "Wave needs assignment and attempt identities");
  require(path.isAbsolute(a.plan_path) && a.plan_path === canonicalPath(a.plan_path), "Use a canonical wave plan path");
  require([...a.owned_paths, ...candidate.read_paths].every(p => path.isAbsolute(p)), "Wave file claims must be absolute");
  require(Array.isArray(candidate.resources) && candidate.resources.every(r => typeof r === "string" && r.trim() === r && r.length > 0) &&
    new Set(candidate.resources).size === candidate.resources.length, "Use unique nonempty resource keys");
  require(Array.isArray(candidate.independence_evidence) && candidate.independence_evidence.every(x => typeof x === "string"), "Invalid independence assessment");
}

/** Read-only selection. No checkpoint, ledger mutation, session or scheduling. */
export function selectPiWave(plan: Plan, input: PiWaveCandidate[], authority: ExecutionAuthority, capacity: 1 | 2 = 2): PiWaveSelection {
  require(capacity === 1 || capacity === 2, "Pi wave capacity must be one or two");
  require(input.length > 0 && input.length <= 100, "Supply 1-100 explicitly scoped wave candidates");
  const candidates = clone(input);
  for (const candidate of candidates) admit(plan, candidate, authority, "pending");
  for (const field of ["assignment_id", "step_id"] as const) require(new Set(candidates.map(c => c.assignment[field])).size === candidates.length, "Duplicate wave candidate");
  require(new Set(candidates.map(c => c.attempt_id)).size === candidates.length, "Duplicate wave attempt");
  require(new Set(candidates.map(c => c.assignment.plan_path)).size === 1, "One canonical plan per wave");
  candidates.sort((a, b) => plan.steps.findIndex(s => s.id === a.assignment.step_id) - plan.steps.findIndex(s => s.id === b.assignment.step_id));
  const sequential = (plan.execution?.execution_mode ?? "sequential") === "sequential";
  if (sequential) {
    const first = plan.steps.find(s => plan.execution!.selected_step_ids.includes(s.id) && s.status !== "completed");
    require(first?.id === candidates[0].assignment.step_id, "Sequential execution must follow selected plan order");
  }
  const selected: PiWaveCandidate[] = [], deferred: PiWaveSelection["deferred"] = [];
  for (const candidate of candidates) {
    let reason: string | undefined;
    if (selected.length >= (sequential ? 1 : capacity)) reason = sequential ? "Explicit/legacy sequential mode" : "Wave capacity reached";
    else if (selected.length && (!evidence(candidate.independence_evidence) || selected.some(c => !evidence(c.independence_evidence)))) reason = "No concrete coordinator independence assessment";
    else if (selected.some(c => piWaveConflict(c, candidate))) reason = "Shared file, live input or exclusive resource; serialize after reconciliation";
    if (reason) deferred.push({ step_id: candidate.assignment.step_id, reason }); else selected.push(candidate);
  }
  return { mode: selected.length > 1 ? "parallel" : "sequential",
    reason: selected.length > 1 ? "At most two assessed independent assignments" : sequential ? "Explicit/legacy sequential mode" :
      deferred[0]?.reason ?? "Only one candidate; sequential execution", selected, deferred };
}

/** Required production adapter boundary; the current single-assignment SDK
 * ledger does NOT yet implement this contract. Do not substitute saved approval
 * or an in-memory reservation for durable, locked multi-worker admission. */
export interface PiWaveHost {
  snapshot(): Promise<{ plan: Plan; refresh_required: boolean }>;
  authority(): ExecutionAuthority;
  reserve(selection: PiWaveSelection): Promise<void>;
  checkpointStart(candidate: PiWaveCandidate): Promise<void>;
  /** Must revalidate under the plan lock and persist intent/identity before model work. */
  launch(candidate: PiWaveCandidate, signal: AbortSignal): Promise<DispatchRecord>;
}
export interface PiWaveOutcome {
  selection: PiWaveSelection;
  results: { step_id: string; record?: DispatchRecord; error?: string }[];
  not_started: string[];
  stop_reason?: string;
  quiescence: Quiescence;
  acceptance_verified: false;
}

/** Single-use, foreground coordination component. No automatic refill, retry,
 * integration, completion, or default SDK launcher. All promises join on failure. */
export class PiWaveCoordinator {
  private used = false;
  constructor(private readonly host: PiWaveHost) {}
  async run(candidates: PiWaveCandidate[], capacity: 1 | 2 = 2, signal?: AbortSignal): Promise<PiWaveOutcome> {
    require(!this.used, "Wave coordinator already used; inspect durable results rather than retry");
    this.used = true;
    signal?.throwIfAborted();
    const requested = clone(candidates);
    const initial = await this.host.snapshot();
    const selection = selectPiWave(initial.plan, requested, { ...this.host.authority(), refreshRequired: initial.refresh_required }, capacity);
    const stop = new AbortController(), pending: Promise<void>[] = [], started = new Set<string>();
    const results: PiWaveOutcome["results"] = [];
    let reason: string | undefined;
    const halt = (message: string) => { reason ??= message; stop.abort(new Error(message)); };
    const cancelled = () => halt("Caller cancelled wave");
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    const current = async (candidate: PiWaveCandidate, status: "pending" | "in_progress") => {
      stop.signal.throwIfAborted();
      const snapshot = await this.host.snapshot();
      admit(snapshot.plan, candidate, { ...this.host.authority(), refreshRequired: snapshot.refresh_required }, status);
      if (selection.mode === "parallel") require(["auto", "parallel"].includes(snapshot.plan.execution?.execution_mode ?? "sequential"), "Parallel preference was revoked");
      stop.signal.throwIfAborted();
    };
    try {
      stop.signal.throwIfAborted();
      // A reservation is not a launch or a canonical start checkpoint.
      await this.host.reserve(clone(selection));
      for (const candidate of selection.selected) {
        if (stop.signal.aborted) break;
        await current(candidate, "pending");
        await this.host.checkpointStart(clone(candidate));
        await current(candidate, "in_progress");
        // The adapter must close the remaining read/launch race under its lock.
        // Observe synchronous throws and every rejection without early exit.
        const task = Promise.resolve().then(() => {
          stop.signal.throwIfAborted();
          started.add(candidate.assignment.step_id);
          return this.host.launch(clone(candidate), stop.signal);
        }).then(record => {
          const a = candidate.assignment;
          const correlated = JSON.stringify(record.assignment) === JSON.stringify(a) && record.attempt_id === candidate.attempt_id &&
            record.handle?.assignment_id === a.assignment_id && record.result?.assignment_id === a.assignment_id &&
            record.result.session.host === record.handle.session.host && record.result.session.native_id === record.handle.session.native_id;
          const quiet = correlated && (record.phase === "settled" ? record.result?.outcome === "succeeded" :
            record.phase === "failed" && ["failed", "cancelled", "interrupted"].includes(record.result?.outcome ?? "")) &&
            record.result?.quiescence.state === "verified" && evidence(record.result.quiescence.evidence);
          results.push({ step_id: a.step_id, record, ...quiet ? {} : { error: "Uncorrelated or unknown writer result" } });
          if (!quiet || record.phase !== "settled" || record.result?.outcome !== "succeeded") halt(`Assignment ${a.step_id} did not settle successfully`);
        }).catch(error => {
          if (started.has(candidate.assignment.step_id)) results.push({ step_id: candidate.assignment.step_id, error: String(error) });
          halt(`Assignment ${candidate.assignment.step_id} rejected`);
        });
        pending.push(task);
      }
    } catch (error) { halt(String(error)); }
    finally {
      // A rejected launch, abort request or first result never releases peers.
      await Promise.allSettled(pending);
      signal?.removeEventListener("abort", cancelled);
    }
    const unknown = results.some(r => r.error);
    return { selection, results, not_started: selection.selected.filter(c => !started.has(c.assignment.step_id)).map(c => c.assignment.step_id),
      ...(reason ? { stop_reason: reason } : {}), acceptance_verified: false,
      quiescence: unknown ? { state: "unknown", reason: "Reconcile rejected/uncorrelated assignments before reuse or transfer" } :
        { state: "verified", evidence: ["Every launched adapter promise joined with correlated verified quiescence; no completion inferred"] } };
  }
}
