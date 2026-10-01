import * as fs from "node:fs";
import { clone, requireValue as require } from "../model";
import { assertStepExecutionAllowed, type ExecutionAuthority } from "../execution-policy";
import { assertExecutionOwner } from "../handovers";
import { checkpoint, digestText, stepFingerprint } from "../transitions";
import { withLock } from "../storage";
import { loadPlanSnapshot, mutatePlan } from "../service";
import { changeLedger, readDispatchLedger, type WaveRecord } from "./dispatch-ledger";
import { PiWaveCoordinator, selectPiWave, type PiWaveCandidate } from "./wave";
import { runPiAssignment, validateAssignment, type PiAssignmentOptions } from "./runner";

export interface PiWaveOptions {
  waveId: string;
  candidates: PiWaveCandidate[];
  capacity?: 1 | 2;
  authority: () => ExecutionAuthority;
  modelRuntime: PiAssignmentOptions["modelRuntime"];
  model: PiAssignmentOptions["model"];
  thinkingLevel: PiAssignmentOptions["thinkingLevel"];
  signal?: AbortSignal;
  timeoutMs?: number;
  quiescenceTimeoutMs?: number;
  /** Display only; observer failure must not change execution or acceptance. */
  onProgress?: (message: string) => void;
}

/** One explicitly supplied wave. The coordinator adapter alone checkpoints starts;
 * SDK assignments retain no canonical mutation tool. Results never complete steps. */
export async function runPiWave(options: PiWaveOptions): Promise<WaveRecord> {
  const candidates = clone(options.candidates), waveId = options.waveId, model = structuredClone(options.model);
  require(typeof waveId === "string" && waveId.trim() && candidates.length > 0, "Wave identity/candidates required");
  const planPath = candidates[0].assignment.plan_path;
  const notify = (text: string) => { try { options.onProgress?.(text); } catch { /* display failure is not execution evidence */ } };
  const current = () => { options.signal?.throwIfAborted(); const a = options.authority(); require(a.currentRunAuthorized && a.implementationAllowed && a.actorId, "Explicit current wave authority required"); return a; };
  const assignmentOptions = (c: PiWaveCandidate, signal?: AbortSignal): PiAssignmentOptions => ({
    assignment: c.assignment, attemptId: c.attempt_id, waveId, readPaths: c.read_paths,
    authority: options.authority, modelRuntime: options.modelRuntime, model, thinkingLevel: options.thinkingLevel,
    tools: ["read", "write", "edit"], contextFiles: [], signal,
    timeoutMs: options.timeoutMs, quiescenceTimeoutMs: options.quiescenceTimeoutMs,
  });
  // Even invalid/deferred candidates must not hide a bad file/tool assignment.
  for (const c of candidates) validateAssignment(c.assignment, assignmentOptions(c));
  const existing = await withLock(planPath, async () => {
    const a = current(), snapshot = await loadPlanSnapshot(planPath, { followRedirects: false });
    assertExecutionOwner(snapshot.plan, a.actorId);
    const w = readDispatchLedger(planPath).waves?.find(w => w.id === waveId);
    if (w) require(w.plan_id === snapshot.plan.plan_id && w.request_id === a.requestId && w.owner === a.actorId, "Wave identity belongs to another plan/request/coordinator");
    return w;
  });
  // This is inspection, never recovery by re-execution. An unfinished reservation
  // stays held; only already durable results may be reconciled.
  if (existing) return existing;
  let reserved = false;
  const coordinator = new PiWaveCoordinator({
    snapshot: () => loadPlanSnapshot(planPath, { followRedirects: false }), authority: current,
    reserve: selection => withLock(planPath, async () => {
      const snapshot = await loadPlanSnapshot(planPath, { followRedirects: false });
      const checked = selectPiWave(snapshot.plan, candidates, { ...current(), refreshRequired: snapshot.refresh_required }, options.capacity);
      require(JSON.stringify(checked) === JSON.stringify(selection), "Wave selection changed before reservation");
      await changeLedger(planPath, ledger => {
        current();
        require(!(ledger.waves ?? []).some(w => w.id === waveId || !w.reconciliation), "Existing wave must be inspected/reconciled before reserving another");
        require(ledger.records.every(r => ["settled", "failed"].includes(r.phase) && r.result?.quiescence.state === "verified"), "Drain existing or unknown writers before a wave");
        for (const c of selection.selected) require(!ledger.records.some(r => r.assignment.assignment_id === c.assignment.assignment_id || r.attempt_id === c.attempt_id ||
          (r.assignment.approved_request_id === c.assignment.approved_request_id && r.assignment.step_id === c.assignment.step_id)), "Duplicate assignment: inspect prior dispatch");
        (ledger.waves ??= []).push({ id: waveId, plan_id: snapshot.plan.plan_id, request_id: current().requestId, owner: current().actorId!, selection, closed: false });
      });
      reserved = true;
      notify(`${selection.mode}: reserved ${selection.selected.length} assignment(s). ${selection.reason}`);
    }),
    checkpointStart: async c => {
      const result = await mutatePlan(planPath, current().actorId, plan => {
        const step = assertStepExecutionAllowed(plan, c.assignment.step_id, current());
        require(step.status === "pending" && stepFingerprint(step).scope === c.assignment.scope_digest, "Start scope changed");
        const wave = readDispatchLedger(planPath).waves?.find(w => w.id === waveId);
        require(wave && !wave.closed && !wave.reconciliation, "Wave closed before checkpoint");
        return checkpoint(plan, plan.revision, step.id, "in_progress", `Wave ${waveId}: coordinator saved start before SDK dispatch; completion awaits integration.`);
      }, { beforeWrite: () => { current(); } });
      notify(`${c.assignment.step_id}: in_progress saved at r${result.plan.revision}${result.export_warning ? `; ${result.export_warning}` : ""}`);
    },
    launch: async (c, signal) => {
      const record = await runPiAssignment(assignmentOptions(c, signal));
      notify(`${c.assignment.step_id}: SDK ${record.phase}; acceptance not verified`);
      return record;
    },
  });
  const outcome = await coordinator.run(candidates, options.capacity, options.signal);
  // Only a reservation made by this invocation is closed. Duplicate reservation
  // rejection must never close another controller's live wave.
  require(reserved, "Wave reservation failed; inspect any existing wave, never relaunch");
  return withLock(planPath, () => changeLedger(planPath, ledger => {
    const wave = ledger.waves?.find(w => w.id === waveId);
    require(wave, "Wave was not reserved; no work launched");
    require(!wave.closed, "Wave already closed; inspect its result");
    wave.closed = true; wave.outcome = outcome;
    return wave;
  }));
}

/** Coordinator acknowledgment after inspecting/integrating each result. Never
 * completes a step, clears a blocker, resumes a worker or erases a failure. */
export async function reconcilePiWave(planPath: string, waveId: string, authority: () => ExecutionAuthority, evidence: string[]): Promise<WaveRecord> {
  require(evidence.some(e => typeof e === "string" && e.trim()), "Coordinator reconciliation evidence required");
  return withLock(planPath, async () => {
    const snapshot = await loadPlanSnapshot(planPath, { followRedirects: false }), a = authority();
    require(a.currentRunAuthorized && a.implementationAllowed && !snapshot.refresh_required, "Current reconciliation authority required");
    assertExecutionOwner(snapshot.plan, a.actorId);
    return changeLedger(planPath, ledger => {
      const wave = ledger.waves?.find(w => w.id === waveId);
      require(wave && wave.closed && wave.plan_id === snapshot.plan.plan_id && wave.owner === a.actorId && wave.request_id === a.requestId, "Wave is not closed for this coordinator/request");
      if (wave.reconciliation) return wave;
      const workspace: Record<string, string | null> = Object.create(null);
      for (const c of wave.selection.selected) {
        for (const file of c.assignment.owned_paths) workspace[file] = fs.existsSync(file) ? digestText(fs.readFileSync(file).toString("base64")) : null;
        const step = snapshot.plan.steps.find(s => s.id === c.assignment.step_id);
        require(step && stepFingerprint(step).scope === c.assignment.scope_digest, "Reconcile changed wave scope manually");
        const record = ledger.records.find(r => r.wave_id === waveId && r.assignment.assignment_id === c.assignment.assignment_id);
        if (record) {
          require(["settled", "failed"].includes(record.phase) && record.result?.quiescence.state === "verified", "Unknown/active writers prevent reconciliation");
          const saved = JSON.parse(fs.readFileSync(record.result_path, "utf8"));
          require(saved.assignment_id === c.assignment.assignment_id && saved.session?.native_id === record.handle?.session.native_id, "Wave result correlation changed");
          if (record.phase === "settled") require(record.verification?.acceptance_met && record.verification.integration_checked && step.status === "completed" &&
            c.assignment.owned_paths.every(file => Object.hasOwn(record.integration_files ?? {}, file) && record.integration_files![file] === workspace[file]), "Verify and checkpoint every successful assignment before releasing the wave; integrated files must still match");
          else require(Boolean(step.blocked_by) || step.status === "completed", "Record the incomplete outcome/blocker before releasing failed work");
        } else require(Boolean(step.blocked_by) || step.status === "pending", "Record the checkpointed but unlaunched outcome before release");
      }
      wave.reconciliation = { evidence: [...evidence], revision: snapshot.plan.revision, workspace_files: workspace };
      return wave;
    });
  });
}
