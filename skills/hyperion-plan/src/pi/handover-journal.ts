import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJSON, requireValue as require, type Plan } from "../model";
import { handoverDigest, updateHandover, handoverBrief } from "../handovers";
import { atomicWrite, atomicText, canonicalPath, withLock } from "../storage";
import { digestText } from "../transitions";
import { loadPlanSnapshot, mutatePlan, type PlanSnapshot } from "../service";
import { dispatchDirectory, readDispatchLedger } from "./dispatch-ledger";
import type { ExecutionAuthority } from "../execution-policy";
import type { Quiescence } from "../hosts/contracts";

export interface HandoverDestination { native_id: string; transcript_path: string }
export interface HandoverReadiness {
  plan_path: string;
  cwd: string;
  request_id: string;
  destination_id: string;
  plan_digest: string;
  code_digest: string;
  brief_digest: string;
  ready: boolean;
  evidence: string[];
}
export interface PiHandoverRecord {
  schema_version: 1;
  plan_path: string;
  plan_id: string;
  request_id: string;
  execution_request_id: string;
  source_id: string;
  cwd: string;
  plan_digest: string;
  code_digest: string;
  brief_path: string;
  brief_digest: string;
  phase: "reserved" | "identified" | "ready" | "transfer-intent" | "transferred" | "claimed";
  source_settlement: Quiescence;
  destination?: HandoverDestination;
  readiness?: HandoverReadiness;
  settlement?: Quiescence;
  transferred_digest?: string;
  readiness_transcript_digest?: string;
  /** Correlation/deduplication, not a substitute for current authority. */
  continuation_id: string;
  readiness_attempt?: number;
  retry_claimed?: boolean;
  retry_transcript_digest?: string;
}
export interface PiHandoverJournalOptions {
  planPath: string;
  planId: string;
  requestId: string;
  cwd: string;
  authority: () => ExecutionAuthority;
  /** Trusted host observations, never model-reported settlement. Must cover
   * the source coordinator and all its children, including prior handovers. */
  observe: () => { code_digest: string; source_quiescence: Quiescence };
}
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && Boolean(v.trim());
const evidence = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(e => text(e) && e.length <= 4000);
function settled(q: Quiescence | undefined): void {
  require(q?.state === "verified" && evidence(q.evidence), "Verified host settlement evidence required");
}
function bytes(file: string): string {
  require(file === canonicalPath(file) && fs.statSync(file).isFile() && fs.statSync(file).size <= 16 * 1024 * 1024, "Invalid or oversized handover artifact");
  return fs.readFileSync(file, "utf8");
}

/** Opt-in bookkeeping foundation, NOT a session launcher or native handover
 * adapter. The caller must supply real SDK identities/observations. No method
 * starts a model turn, creates a session, navigates, or restores approval. */
export class PiHandoverJournal {
  private readonly options: PiHandoverJournalOptions;
  constructor(options: PiHandoverJournalOptions) {
    this.options = { ...options };
    require(path.isAbsolute(options.planPath) && options.planPath === canonicalPath(options.planPath) &&
      path.isAbsolute(options.cwd) && options.cwd === canonicalPath(options.cwd) && text(options.planId) && text(options.requestId), "Canonical handover identity required");
  }
  private file(): string {
    const file = path.join(dispatchDirectory(this.options.planPath), "handovers", digestText(this.options.requestId), "state.json");
    require(file === canonicalPath(file), "Handover journal path aliases another location");
    return file;
  }
  /** Read-only even when paused, cancelled, transferred or interrupted. */
  inspect(): PiHandoverRecord | undefined {
    if (!fs.existsSync(this.file())) return undefined;
    const r = JSON.parse(bytes(this.file())) as PiHandoverRecord;
    require(r.schema_version === 1 && r.plan_path === this.options.planPath && r.plan_id === this.options.planId &&
      r.request_id === this.options.requestId && r.cwd === this.options.cwd && text(r.source_id) && text(r.execution_request_id) && text(r.continuation_id) &&
      [r.plan_digest, r.code_digest, r.brief_digest].every(hash) && path.isAbsolute(r.brief_path) &&
      ["reserved", "identified", "ready", "transfer-intent", "transferred", "claimed"].includes(r.phase), "Invalid handover journal; do not replace it");
    require(r.readiness_attempt === undefined || (Number.isInteger(r.readiness_attempt) && r.readiness_attempt > 1 && r.readiness_attempt <= 1000), "Invalid readiness attempt");
    settled(r.source_settlement);
    if (r.phase !== "reserved") require(r.destination && text(r.destination.native_id) && r.destination.native_id !== r.source_id && path.isAbsolute(r.destination.transcript_path), "Invalid destination identity");
    if (["ready", "transfer-intent", "transferred", "claimed"].includes(r.phase)) {
      require(r.readiness?.ready === true && hash(r.transferred_digest), "Missing readiness correlation");
      this.report(r, r.readiness); settled(r.settlement);
    }
    return r;
  }
  private write(r: PiHandoverRecord, snapshot: PlanSnapshot): PiHandoverRecord {
    const actor = this.authority(snapshot.plan, r.execution_request_id).actorId!;
    const transferred = ["transferred", "claimed"].includes(r.phase);
    const destination = r.destination?.native_id;
    require(transferred ? text(destination) && snapshot.plan.execution_owner === destination &&
      (r.phase === "claimed" ? actor === destination : [r.source_id, destination].includes(actor)) :
      actor === r.source_id && snapshot.plan.execution_owner === r.source_id, "Handover actor changed before write");
    require(digestText(fs.readFileSync(this.options.planPath, "utf8")) === snapshot.source_digest, "Canonical plan changed during handover bookkeeping");
    atomicWrite(this.file(), r);
    // Persist new directory entries as well as the file. A persistence failure
    // is ambiguous intent, never permission to allocate another destination.
    for (let dir = path.dirname(this.file()); ; dir = path.dirname(dir)) {
      const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (dir === path.dirname(this.options.planPath)) break;
    }
    return structuredClone(r);
  }
  private authority(plan: Plan, executionId?: string): ExecutionAuthority {
    const a = { ...this.options.authority() };
    require(a.currentRunAuthorized && a.implementationAllowed && text(a.actorId), "Current handover authority required");
    require(plan.plan_id === this.options.planId && (plan.lifecycle ?? "active") === "active" && plan.execution?.state === "approved" &&
      a.requestId === plan.execution.request_id && (!executionId || a.requestId === executionId), "Handover execution scope is paused, revoked or changed");
    require(!plan.plan_reviews?.some(r => ["requested", "running"].includes(r.state)), "Drain independent review before handover");
    return a;
  }
  private context(snapshot: Pick<PlanSnapshot, "plan" | "refresh_required">, r?: PiHandoverRecord) {
    require(!snapshot.refresh_required, "Refresh canonical plan before handover");
    const a = this.authority(snapshot.plan, r?.execution_request_id);
    const observation = this.options.observe();
    require(hash(observation.code_digest), "Observed code digest required"); settled(observation.source_quiescence);
    const ledger = readDispatchLedger(this.options.planPath);
    require(ledger.records.every(d => d.assignment.plan_id === snapshot.plan.plan_id && ["settled", "failed"].includes(d.phase) && d.result?.quiescence.state === "verified") &&
      (ledger.waves ?? []).every(w => w.reconciliation), "Drain writers and reconcile waves before handover");
    // A reload/new event cannot forget a previous read-only SDK whose settlement
    // is unknown. Ledger drainage alone covers assignments, not handover sessions.
    const parent = path.join(dispatchDirectory(this.options.planPath), "handovers");
    if (fs.existsSync(parent)) {
      require(parent === canonicalPath(parent), "Aliased handover history");
      const entries = fs.readdirSync(parent, { withFileTypes: true });
      require(entries.length <= 1000, "Inspect oversized handover history before dispatch");
      let total = 0;
      for (const entry of entries) {
        require(!entry.isSymbolicLink(), "Aliased prior handover evidence");
        if (!entry.isDirectory() || entry.name === digestText(this.options.requestId)) continue;
        require(/^[a-f0-9]{64}$/.test(entry.name), "Unrecognized prior handover directory");
        const statePath = path.join(parent, entry.name, "state.json"), runtimePath = path.join(parent, entry.name, "runtime.json");
        require(fs.existsSync(statePath), "Prior handover intent is uncertain; inspect it before dispatch");
        total += fs.statSync(statePath).size + (fs.existsSync(runtimePath) ? fs.statSync(runtimePath).size : 0);
        require(total <= 32 * 1024 * 1024, "Prior handover evidence exceeds inspection limit");
        const prior = JSON.parse(bytes(statePath));
        require(prior.schema_version === 1 && prior.plan_id === snapshot.plan.plan_id && prior.plan_path === this.options.planPath && digestText(prior.request_id) === entry.name, "Prior handover correlation mismatch");
        const runtime = fs.existsSync(runtimePath) ? JSON.parse(bytes(runtimePath)) : undefined;
        const committed = snapshot.plan.handovers?.some(h => h.request_id === prior.request_id && h.state === "transferred" && h.source_task_id === prior.source_id && h.destination_task_id === prior.destination?.native_id && h.context_digest === prior.transferred_digest);
        const knownSettled = ["ready", "transferred", "claimed"].includes(prior.phase) || (prior.phase === "transfer-intent" && committed);
        require(!runtime || !["uncertain", "started", "identified"].includes(runtime.phase) || (knownSettled && runtime.phase !== "uncertain"), "Prior handover writers are active or unknown");
        if (knownSettled) settled(prior.settlement);
        else require(runtime?.phase === "failed" && runtime.quiescence?.state === "verified" && (runtime.attempt ?? 1) === (prior.readiness_attempt ?? 1) && runtime.destination?.native_id === prior.destination?.native_id, "Prior handover writers are active or unknown");
      }
    }
    const h = snapshot.plan.handovers?.find(h => h.request_id === this.options.requestId);
    require(h && !["cancelled", "blocked", "requested"].includes(h.state), "Prepared canonical handover required");
    if (r) require(r.code_digest === observation.code_digest && r.brief_path === h.brief_path && digestText(bytes(r.brief_path)) === r.brief_digest, "Handover code or brief changed; reconcile same destination");
    return { a, h, observation };
  }
  private source(snapshot: Pick<PlanSnapshot, "plan" | "refresh_required">, r?: PiHandoverRecord) {
    const c = this.context(snapshot, r);
    require(c.h.state === "prepared" && snapshot.plan.execution_owner === c.a.actorId && c.h.source_task_id === c.a.actorId &&
      (!r || r.source_id === c.a.actorId), "Only the prepared source coordinator may act");
    require(c.h.context_digest === handoverDigest(snapshot.plan) && (!r || r.plan_digest === c.h.context_digest), "Handover plan context changed; reconcile same destination");
    return c;
  }
  private report(r: PiHandoverRecord, report: HandoverReadiness): void {
    require(report.ready === true && report.plan_path === r.plan_path && report.cwd === r.cwd && report.request_id === r.request_id && report.destination_id === r.destination?.native_id &&
      report.plan_digest === r.plan_digest && report.code_digest === r.code_digest && report.brief_digest === r.brief_digest &&
      evidence(report.evidence), "Readiness is missing, blocked or mismatched");
  }
  private transcript(r: PiHandoverRecord, stableReadiness = false): void {
    require(r.destination, "Destination identity missing");
    const content = bytes(r.destination.transcript_path);
    if (stableReadiness) require(hash(r.readiness_transcript_digest) && digestText(content) === r.readiness_transcript_digest, "Readiness transcript changed or was not captured; inspect the same destination");
    const entries = content.trim().split("\n").map(line => JSON.parse(line));
    const header = entries[0], tags = entries.filter(e => e.type === "custom" && e.customType === "hyperion.handover");
    const revision = entries.filter(e => e.type === "custom" && e.customType === "hyperion.handover-context").at(-1);
    const current = revision?.data ?? tags[0]?.data;
    require((r.readiness_attempt ?? 1) === 1 ? !revision : revision?.data?.readiness_attempt === r.readiness_attempt, "Readiness context attempt mismatch");
    require(header?.type === "session" && header.id === r.destination.native_id && header.cwd === r.cwd && header.parentSession === undefined && tags.length === 1 &&
      tags[0].data?.plan_path === r.plan_path && tags[0].data.plan_id === r.plan_id && tags[0].data.request_id === r.request_id && tags[0].data.source_id === r.source_id &&
      current?.plan_path === r.plan_path && current.plan_id === r.plan_id && current.request_id === r.request_id && current.source_id === r.source_id &&
      current.plan_digest === r.plan_digest && current.code_digest === r.code_digest && current.brief_digest === r.brief_digest,
    "Destination transcript identity/context mismatch");
  }
  async reserve(): Promise<{ created: boolean; record: PiHandoverRecord }> {
    return withLock(this.options.planPath, async () => {
      const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false });
      const old = this.inspect(), { a, h, observation } = this.source(snapshot, old);
      if (old) return { created: false, record: old }; // Never another launch permit.
      require(!h.destination_task_id, "Canonical destination already exists; recover its identity instead of allocating another");
      require(h.brief_path, "Prepared brief required");
      return { created: true, record: this.write({ schema_version: 1, plan_path: this.options.planPath, plan_id: this.options.planId, request_id: h.request_id,
        execution_request_id: a.requestId, source_id: a.actorId!, cwd: this.options.cwd, plan_digest: h.context_digest!, code_digest: observation.code_digest,
        brief_path: h.brief_path, brief_digest: digestText(bytes(h.brief_path)), phase: "reserved", source_settlement: structuredClone(observation.source_quiescence), continuation_id: randomUUID() }, snapshot) };
    });
  }
  async identify(destination: HandoverDestination): Promise<PiHandoverRecord> {
    const identity = structuredClone(destination);
    return withLock(this.options.planPath, async () => {
      const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false }), r = this.inspect();
      require(r, "Reserve before allocating a destination"); const { h } = this.source(snapshot, r);
      require(text(identity.native_id) && identity.native_id !== r.source_id && path.isAbsolute(identity.transcript_path) &&
        identity.transcript_path === canonicalPath(identity.transcript_path) && identity.transcript_path.endsWith(".jsonl") &&
        (!h.destination_task_id || h.destination_task_id === identity.native_id), "Invalid destination identity");
      if (r.destination) { require(canonicalJSON(r.destination) === canonicalJSON(identity), "Reuse the recorded destination"); return r; }
      require(r.phase === "reserved", "Unexpected handover phase"); r.destination = identity; r.phase = "identified";
      return this.write(r, snapshot); // Path can still be reserved, not yet flushed by Pi.
    });
  }
  async ready(report: HandoverReadiness, settlement: Quiescence): Promise<PiHandoverRecord> {
    const data = structuredClone(report), observed = structuredClone(settlement);
    return withLock(this.options.planPath, async () => {
      const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false }), r = this.inspect();
      require(r && ["identified", "ready"].includes(r.phase), "Record destination before readiness");
      const { h, observation } = this.source(snapshot, r);
      require(h.destination_task_id === r.destination?.native_id, "Persist destination in the canonical prepared handover first");
      this.report(r, data); settled(observed); this.transcript(r, r.phase === "ready");
      if (r.phase === "ready") { require(canonicalJSON(r.readiness) === canonicalJSON(data), "Inspect existing readiness; do not replace it"); return r; }
      r.readiness = data; r.settlement = observed; r.phase = "ready";
      r.readiness_transcript_digest = digestText(bytes(r.destination!.transcript_path));
      r.source_settlement = structuredClone(observation.source_quiescence);
      r.transferred_digest = handoverDigest(updateHandover(snapshot.plan, snapshot.plan.revision, { request_id: r.request_id, state: "transferred", destination_task_id: r.destination!.native_id }, r.source_id)[0]);
      return this.write(r, snapshot);
    });
  }
  async transfer(): Promise<PiHandoverRecord> {
    // Two atomic files, not one transaction. Persist intent first. A crash after
    // the canonical write is reconciled from that owner, never by transferring again.
    let sourceDigest = "", sourceId = "", executionId = "";
    await withLock(this.options.planPath, async () => {
      const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false }), r = this.inspect();
      sourceDigest = snapshot.source_digest;
      require(r?.phase === "ready", "Readiness required; inspect/recover existing transfer intent instead of retrying");
      const { observation } = this.source(snapshot, r); this.transcript(r, true); sourceId = r.source_id; executionId = r.execution_request_id;
      r.source_settlement = structuredClone(observation.source_quiescence);
      r.phase = "transfer-intent"; this.write(r, snapshot);
    });
    await mutatePlan(this.options.planPath, sourceId, plan => {
      const r = this.inspect(); require(r?.phase === "transfer-intent", "Transfer intent missing");
      // beforeWrite rejects changed bytes before any implicit refresh.
      this.source({ plan, refresh_required: false }, r);
      this.transcript(r, true);
      return updateHandover(plan, plan.revision, { request_id: r.request_id, state: "transferred", destination_task_id: r.destination!.native_id }, r.source_id);
    }, { beforeWrite: () => {
      const a = this.options.authority();
      require(a.currentRunAuthorized && a.implementationAllowed && a.actorId === sourceId && a.requestId === executionId, "Current handover authority required");
      require(digestText(fs.readFileSync(this.options.planPath, "utf8")) === sourceDigest, "Canonical plan changed before transfer; inspect intent");
    } });
    return this.recoverTransfer();
  }
  /** Explicitly acknowledge a transfer intent that did NOT commit. The lock and
   * phase reset also fence an older transfer callback still waiting on this lock. */
  async reconcileUncommittedTransfer(): Promise<PiHandoverRecord> {
    return withLock(this.options.planPath, async () => {
      const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false }), r = this.inspect();
      require(r?.phase === "transfer-intent", "No uncommitted transfer intent");
      this.source(snapshot, r); this.transcript(r, true); settled(r.settlement);
      r.phase = "ready"; return this.write(r, snapshot);
    });
  }
  /** A retry needs a host-observed, attempt-bound settlement and exact transcript.
   * It refreshes context, not identity; unknown or already-running attempts cannot
   * be superseded by an older failed runtime record. No SDK/session work here. */
  async reprepare(proof: { attempt: number; transcript_digest: string; quiescence: Quiescence }): Promise<PiHandoverRecord> {
    proof = structuredClone(proof);
    const before = await loadPlanSnapshot(this.options.planPath, { followRedirects: false }), old = this.inspect();
    require(old && ["identified", "ready"].includes(old.phase) && old.destination && (old.readiness_attempt ?? 1) < 1000, "Inspect/reconcile transfer intent before re-preparation");
    const validate = (plan: Plan) => {
      const current = this.inspect(); require(current && canonicalJSON(current) === canonicalJSON(old), "Readiness attempt changed");
      const c = this.context({ plan, refresh_required: false }); this.authority(plan, old.execution_request_id);
      require(c.a.actorId === old.source_id && plan.execution_owner === old.source_id && c.h.state === "prepared" && c.h.source_task_id === old.source_id && c.h.destination_task_id === old.destination!.native_id, "Re-prepare only the same source/destination");
      bytes(old.brief_path); settled(proof.quiescence); require((proof.attempt === (old.readiness_attempt ?? 1) || (old.retry_claimed === false && proof.attempt === old.readiness_attempt! - 1 && proof.transcript_digest === old.retry_transcript_digest)) && hash(proof.transcript_digest) && digestText(bytes(old.destination!.transcript_path)) === proof.transcript_digest, "Fresh settled attempt/transcript evidence required");
      const entries = bytes(old.destination!.transcript_path).trim().split("\n").map(line => JSON.parse(line));
      const tags = entries.filter(e => e.type === "custom" && e.customType === "hyperion.handover");
      require(entries[0]?.type === "session" && entries[0]?.id === old.destination!.native_id && entries[0]?.cwd === old.cwd && entries[0]?.parentSession === undefined && tags.length === 1 && tags[0].data?.plan_path === old.plan_path && tags[0].data?.plan_id === old.plan_id && tags[0].data?.request_id === old.request_id && tags[0].data?.source_id === old.source_id, "Retry identity mismatch");
      return c;
    };
    require(!before.refresh_required, "Refresh canonical input explicitly before re-preparation"); validate(before.plan);
    const saved = await mutatePlan(this.options.planPath, old.source_id, plan => {
      const { h, observation } = validate(plan);
      return updateHandover(plan, plan.revision, { request_id: old.request_id, state: "prepared", destination_task_id: old.destination!.native_id, code_state: `Re-prepared scoped code ${observation.code_digest}`, summary: h.summary!, next_action: h.next_action!, brief_path: old.brief_path }, old.source_id);
    }, { beforeWrite: () => { this.authority(before.plan, old.execution_request_id); require(digestText(fs.readFileSync(this.options.planPath, "utf8")) === before.source_digest, "Canonical input changed during re-preparation"); } });
    return withLock(this.options.planPath, async () => {
      const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false });
      require(canonicalJSON(snapshot.plan) === canonicalJSON(saved.plan), "Canonical input changed after re-preparation; inspect same identity");
      const { observation } = validate(snapshot.plan);
      atomicWrite(path.join(path.dirname(this.file()), `attempt-${old.readiness_attempt ?? 1}.json`), old);
      atomicText(old.brief_path, handoverBrief(snapshot.plan, old.request_id));
      const r = { ...old, phase: "identified" as const, readiness_attempt: (old.readiness_attempt ?? 1) + 1, retry_claimed: false, retry_transcript_digest: proof.transcript_digest,
        plan_digest: handoverDigest(snapshot.plan), code_digest: observation.code_digest, brief_digest: digestText(bytes(old.brief_path)), source_settlement: observation.source_quiescence };
      delete r.readiness; delete r.settlement; delete r.readiness_transcript_digest; delete r.transferred_digest;
      return this.write(r, snapshot);
    });
  }
  async claimReadinessRetry(attempt: number): Promise<PiHandoverRecord> {
    return withLock(this.options.planPath, async () => {
      const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false }), r = this.inspect();
      require(r?.phase === "identified" && r.retry_claimed === false && r.readiness_attempt === attempt && attempt > 1, "No unclaimed explicit same-destination retry");
      this.source(snapshot, r); require(digestText(bytes(r.destination!.transcript_path)) === r.retry_transcript_digest, "Retry transcript changed");
      r.retry_claimed = true; return this.write(r, snapshot);
    });
  }
  /** Read-only navigation after a consumed/lost continuation. Approval, code and
   * step progress may have changed; this does not grant another continuation. */
  async navigationTarget(): Promise<HandoverDestination> {
    const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false }), r = this.inspect();
    require(r && ["transfer-intent", "transferred", "claimed"].includes(r.phase), "No transferred destination");
    const h = snapshot.plan.handovers?.find(h => h.request_id === r.request_id), actor = this.options.authority().actorId;
    require(snapshot.plan.plan_id === r.plan_id && [r.source_id, r.destination!.native_id].includes(actor!) && snapshot.plan.execution_owner === r.destination!.native_id && h?.state === "transferred" && h.source_task_id === r.source_id && h.destination_task_id === r.destination!.native_id, "Canonical destination owner mismatch");
    this.transcript(r); return structuredClone(r.destination!);
  }
  async recoverTransfer(): Promise<PiHandoverRecord> {
    return withLock(this.options.planPath, async () => {
      const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false }), r = this.inspect();
      require(r && ["transfer-intent", "transferred", "claimed"].includes(r.phase), "No transfer intent to recover");
      this.transferred(snapshot, r);
      if (r.phase !== "transfer-intent") return r;
      r.phase = "transferred"; return this.write(r, snapshot);
    });
  }
  private transferred(snapshot: PlanSnapshot, r: PiHandoverRecord) {
    const c = this.context(snapshot, r);
    require([r.source_id, r.destination!.native_id].includes(c.a.actorId!) && c.h.state === "transferred" &&
      c.h.source_task_id === r.source_id && c.h.destination_task_id === r.destination!.native_id && snapshot.plan.execution_owner === r.destination!.native_id &&
      handoverDigest(snapshot.plan) === r.transferred_digest && c.h.context_digest === r.transferred_digest, "Canonical transfer identity or context mismatch");
    this.transcript(r); return c;
  }
  /** Called at an explicitly correlated destination continuation boundary.
   * A consumed claim cannot be replayed automatically after a lost response. */
  async claimContinuation(id: string): Promise<{ permit: boolean; record: PiHandoverRecord }> {
    return withLock(this.options.planPath, async () => {
      const snapshot = await loadPlanSnapshot(this.options.planPath, { followRedirects: false }), r = this.inspect();
      require(r && ["transferred", "claimed"].includes(r.phase), "Observe canonical transfer before continuation");
      const { a } = this.transferred(snapshot, r);
      require(a.actorId === r.destination!.native_id && id === r.continuation_id, "Correlated destination continuation required");
      if (r.phase === "claimed") return { permit: false, record: r };
      r.phase = "claimed"; return { permit: true, record: this.write(r, snapshot) };
    });
  }
}
