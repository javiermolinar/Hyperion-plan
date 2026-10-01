import * as fs from "node:fs";
import * as path from "node:path";
import { piWaveConflict, type PiWaveSelection, type PiWaveOutcome } from "./wave";
import { assertReviewAllowed, independentReviewScope, type ReviewContext, type ReviewReport } from "./review-contract";
import { assertReviewEvidence } from "./review-evidence";
import type { ControlledTestEvidence } from "./review-tests";
import { atomicWrite, canonicalPath, withLock } from "../storage";
import { digestText, stepFingerprint } from "../transitions";
import { loadPlanSnapshot } from "../service";
import { requireValue as require } from "../model";
import type { WorkAssignment, WorkerHandle, AssignmentResult, EffortEvidence } from "../hosts/contracts";
import { assertStepExecutionAllowed, assertVerifiedWorkerResult, type CoordinatorVerification, type ExecutionAuthority } from "../execution-policy";

export type DispatchPhase = "accepted" | "launching" | "started" | "settled" | "failed" | "uncertain";
export interface DispatchRecord {
  schema_version: 1;
  assignment: WorkAssignment;
  attempt_id: string;
  phase: DispatchPhase;
  history: { phase: DispatchPhase; at: string }[];
  handle?: WorkerHandle;
  result?: AssignmentResult;
  error?: string;
  model: { provider: string; id: string; thinking_level: string };
  tools: string[];
  effort?: EffortEvidence;
  wave_id?: string;
  read_paths?: string[];
  review?: ReviewContext;
  review_report?: ReviewReport;
  controlled_tests?: Record<string, ControlledTestEvidence>;
  resources_digest: string;
  events_path: string;
  result_path: string;
  /** Coordinator evidence is separate from both SDK settlement and worker prose. */
  verification?: CoordinatorVerification;
  integration_files?: Record<string, string | null>;
}
export interface WaveRecord {
  id: string;
  plan_id: string;
  request_id: string;
  owner: string;
  selection: PiWaveSelection;
  closed: boolean;
  outcome?: PiWaveOutcome;
  reconciliation?: { evidence: string[]; revision: number; workspace_files: Record<string, string | null> };
}
interface Ledger { schema_version: 1; plan_path: string; records: DispatchRecord[]; waves?: WaveRecord[] }
export function dispatchDirectory(planPath: string): string {
  return path.join(path.dirname(canonicalPath(planPath)), ".hyperion-dispatch", path.basename(planPath));
}
export function assignmentDirectory(planPath: string, assignmentId: string): string {
  // IDs are opaque, never path segments supplied by a worker.
  return path.join(dispatchDirectory(planPath), digestText(assignmentId));
}
export function readDispatchLedger(planPath: string): Ledger {
  const canonical = canonicalPath(planPath), file = path.join(dispatchDirectory(canonical), "ledger.json");
  if (!fs.existsSync(file)) return { schema_version: 1, plan_path: canonical, records: [] };
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as Ledger;
  require(data.schema_version === 1 && data.plan_path === canonical && Array.isArray(data.records), "Invalid dispatch ledger; reconcile manually");
  for (const r of data.records) {
    require(r.schema_version === 1 && typeof r.assignment?.assignment_id === "string" &&
      r.assignment.plan_path === canonical && typeof r.attempt_id === "string" &&
      ["accepted", "launching", "started", "settled", "failed", "uncertain"].includes(r.phase) && Array.isArray(r.history),
    "Invalid dispatch record; reconcile manually");
    if (r.phase === "settled" || r.phase === "failed") require(r.result && r.handle &&
      r.result.assignment_id === r.assignment.assignment_id && r.handle.assignment_id === r.assignment.assignment_id &&
      r.result.session.native_id === r.handle.session.native_id && r.result.session.host === r.handle.session.host &&
      (r.phase === "settled" ? r.result.outcome === "succeeded" : ["failed", "cancelled", "interrupted"].includes(r.result.outcome)) &&
      r.result.quiescence?.state === "verified" && r.result.quiescence.evidence?.some(e => typeof e === "string" && e.trim()),
    "Invalid terminal dispatch correlation; reconcile manually");
  }
  require(data.waves === undefined || Array.isArray(data.waves), "Invalid wave ledger");
  for (const w of data.waves ?? []) require(typeof w.id === "string" && typeof w.closed === "boolean" &&
    Array.isArray(w.selection?.selected) && w.selection.selected.length >= 1 && w.selection.selected.length <= 2 &&
    w.selection.selected.every(c => c.assignment.plan_id === w.plan_id && c.assignment.plan_path === canonical && c.assignment.approved_request_id === w.request_id && c.assignment.owner.native_id === w.owner), "Invalid wave reservation; reconcile manually");
  return data;
}
export async function changeLedger<T>(planPath: string, change: (ledger: Ledger) => T): Promise<T> {
  const file = path.join(dispatchDirectory(planPath), "ledger.json");
  return withLock(file, () => {
    const ledger = readDispatchLedger(planPath);
    const result = change(ledger);
    atomicWrite(file, ledger);
    // atomicWrite fsyncs the file before rename. Persist directory entries too,
    // including newly created ledger parents, before launching model work.
    for (const dir of [path.dirname(file), path.dirname(path.dirname(file)), path.dirname(canonicalPath(planPath))]) {
      const fd = fs.openSync(dir, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return result;
  });
}
export async function reserveDispatch(record: DispatchRecord): Promise<void> {
  await changeLedger(record.assignment.plan_path, ledger => {
    require(ledger.records.every(r => r.assignment.plan_id === record.assignment.plan_id), "Plan identity differs from dispatch history; reconcile manually");
    require(!ledger.records.some(r => r.assignment.assignment_id === record.assignment.assignment_id || r.attempt_id === record.attempt_id ||
      (r.assignment.plan_id === record.assignment.plan_id && r.assignment.approved_request_id === record.assignment.approved_request_id && r.assignment.step_id === record.assignment.step_id)),
    "Duplicate dispatch: inspect the existing assignment, do not relaunch");
    const holds = (ledger.waves ?? []).filter(w => !w.reconciliation);
    if (record.wave_id) {
      const wave = holds.find(w => w.id === record.wave_id);
      require(wave && !wave.closed && holds.length === 1, "Wave missing, closed or held by another reservation");
      const candidate = wave.selection.selected.find(c => c.assignment.assignment_id === record.assignment.assignment_id);
      require(candidate && JSON.stringify(candidate.assignment) === JSON.stringify(record.assignment) && candidate.attempt_id === record.attempt_id &&
        JSON.stringify(candidate.read_paths) === JSON.stringify(record.read_paths), "Dispatch differs from its durable wave claim");
      require(!wave.selection.selected.some(c => c !== candidate && piWaveConflict(c, candidate)), "Wave claims now conflict");
      require(ledger.records.every(r => {
        if (r.phase === "uncertain") return false;
        if (r.wave_id === wave.id) return r.phase !== "failed";
        return (r.phase === "settled" || r.phase === "failed") && r.result?.quiescence.state === "verified";
      }), "Existing dispatch is failed, active or uncertain; reconcile before dispatch");
      require(ledger.records.filter(r => r.wave_id === wave.id).length < wave.selection.selected.length, "Wave capacity exhausted");
    } else {
      require(holds.length === 0, "Unreconciled wave holds dispatch");
      require(ledger.records.every(r => (r.phase === "settled" || r.phase === "failed") && r.result?.quiescence.state === "verified"),
        "Existing dispatch is active or uncertain; reconcile before dispatch");
    }
    ledger.records.push(record);
  });
}
export async function updateDispatch(planPath: string, assignmentId: string, change: (record: DispatchRecord) => void): Promise<DispatchRecord> {
  return changeLedger(planPath, ledger => {
    const record = ledger.records.find(r => r.assignment.assignment_id === assignmentId);
    require(record, "Dispatch record missing; do not relaunch");
    change(record);
    return record;
  });
}
export function setDispatchPhase(record: DispatchRecord, phase: DispatchPhase): void {
  record.phase = phase;
  record.history.push({ phase, at: new Date().toISOString() });
}
/** Evidence recording only. Caller verifies reality; this cannot checkpoint a plan. */
export async function verifyDispatch(planPath: string, assignmentId: string, authority: () => ExecutionAuthority, verification: CoordinatorVerification): Promise<DispatchRecord> {
  return withLock(planPath, async () => {
    const snapshot = await loadPlanSnapshot(planPath, { followRedirects: false });
    return updateDispatch(planPath, assignmentId, record => {
      const current = authority(), a = record.assignment;
      require(a.owner.native_id === current.actorId, "Only the assigning coordinator may verify this record");
      require(snapshot.plan.plan_id === a.plan_id && current.requestId === a.approved_request_id, "Assignment plan/request changed");
      const gate = { ...current, refreshRequired: snapshot.refresh_required };
      const step = record.review ? assertReviewAllowed(snapshot.plan, a.step_id, gate, record.review.intent) : assertStepExecutionAllowed(snapshot.plan, a.step_id, gate);
      require((step ? stepFingerprint(step).scope : independentReviewScope(snapshot.plan, a.approved_request_id)) === a.scope_digest, "Assignment scope changed");
      if (record.review) assertReviewEvidence(snapshot.plan, record, verification);
      if (record.wave_id) {
        const ledger = readDispatchLedger(planPath), wave = ledger.waves?.find(w => w.id === record.wave_id);
        require(wave?.closed && ledger.records.filter(r => r.wave_id === wave.id).every(r => ["settled", "failed"].includes(r.phase) && r.result?.quiescence.state === "verified"), "Drain all wave writers before integration/verification");
      }
      require(record.phase === "settled" && record.handle && record.result, "Assignment has not settled successfully");
      assertVerifiedWorkerResult(record.handle, record.result, verification);
      require(fs.existsSync(record.handle.transcript_path) && fs.existsSync(record.result_path), "Assignment evidence is missing");
      record.verification = structuredClone(verification);
      if (record.wave_id) record.integration_files = Object.fromEntries(a.owned_paths.map(file => [file, fs.existsSync(file) ? digestText(fs.readFileSync(file).toString("base64")) : null]));
    });
  });
}
