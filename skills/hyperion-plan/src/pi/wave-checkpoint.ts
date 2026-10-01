import * as fs from "node:fs";
import { requireValue as require, type Plan } from "../model";
import { digestText, stepFingerprint } from "../transitions";
import { assertStepExecutionAllowed } from "../execution-policy";
import { readDispatchLedger } from "./dispatch-ledger";

/** Storage-boundary guard for Pi wave completions, shared by native mutations
 * and the CLI. Pure model transitions remain host-neutral. No SDK is loaded.
 * Manual file edits are not a supported way to reconcile dispatch records. */
export function assertPiWaveCompletions(planPath: string, previous: Plan, next: Plan, actorId?: string): void {
  const completing = next.steps.filter(s => s.status === "completed" && previous.steps.find(p => p.id === s.id)?.status !== "completed");
  if (!completing.length) return;
  const ledger = readDispatchLedger(planPath);
  for (const wave of ledger.waves ?? []) {
    if (wave.plan_id !== previous.plan_id || wave.reconciliation) continue;
    for (const step of completing) {
      const candidate = wave.selection.selected.find(c => c.assignment.step_id === step.id);
      if (!candidate) continue;
      const record = ledger.records.find(r => r.wave_id === wave.id && r.assignment.assignment_id === candidate.assignment.assignment_id);
      require(actorId === wave.owner && actorId === candidate.assignment.owner.native_id,
        "Only the assigning coordinator may complete a wave assignment");
      require(next.plan_id === wave.plan_id && previous.execution?.request_id === wave.request_id &&
        next.execution?.request_id === wave.request_id && next.execution.state === "approved" && next.execution.selected_step_ids.includes(step.id),
      "Wave completion request is not the current approved selection");
      // Saved verification cannot authorize another actor/request or a resumed,
      // changed or no-longer-ready step. Admission is checked against the actual
      // pre-completion state; the resulting write must retain that authority.
      const current = assertStepExecutionAllowed(previous, step.id, { currentRunAuthorized: true, implementationAllowed: true,
        actorId, requestId: wave.request_id });
      require(current.status === "in_progress" && stepFingerprint(current).scope === candidate.assignment.scope_digest,
        "Wave completion scope/start changed");
      require(!record || (record.attempt_id === candidate.attempt_id && JSON.stringify(record.assignment) === JSON.stringify(candidate.assignment)),
        "Wave completion assignment changed");
      require(wave.closed && ledger.records.filter(r => r.wave_id === wave.id).every(r => ["settled", "failed"].includes(r.phase) && r.result?.quiescence.state === "verified"), "Drain all wave writers before canonical completion");
      require(record?.phase === "settled" && record.verification?.acceptance_met && record.verification.integration_checked &&
        record.assignment.scope_digest === stepFingerprint(step).scope && candidate.assignment.owned_paths.every(file =>
          Object.hasOwn(record.integration_files ?? {}, file) && record.integration_files![file] === (fs.existsSync(file) ? digestText(fs.readFileSync(file).toString("base64")) : null)),
      "Coordinator integration verification is required before wave completion; reconcile failed work as incomplete first");
    }
  }
}
