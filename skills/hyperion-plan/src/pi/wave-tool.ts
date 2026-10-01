import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requireValue as require } from "../model";
import { canonicalPath } from "../storage";
import { loadPlanSnapshot } from "../service";
import { stepFingerprint } from "../transitions";
import { assignmentDirectory, readDispatchLedger, verifyDispatch, type WaveRecord } from "./dispatch-ledger";
import { runPiWave, reconcilePiWave } from "./wave-runtime";
import { childModelProxy } from "./model-proxy";
import { PROGRESS_TYPE } from "./progress";

export function registerPiWaveTool(pi: ExtensionAPI): void {
  let stopped = false, unknown = false;
  let active: { abort: AbortController; done: Promise<WaveRecord> } | undefined;
  const stop = async () => {
    stopped = true;
    const running = active;
    running?.abort.abort();
    if (running) await Promise.allSettled([running.done]);
    return unknown ? { cancel: true } : undefined;
  };
  pi.on("session_shutdown", async () => { await stop(); });
  pi.on("session_before_switch", stop);
  pi.on("session_start", async () => { if (!active && !unknown) stopped = false; });
  pi.registerTool({
    name: "hyperion_wave", label: "Hyperion bounded implementation wave", executionMode: "sequential",
    description: "Run at most two explicitly selected pending implementation steps with exact file/read/resource claims. Requires CURRENT user permission for worker sessions, not saved approval. This coordinator tool saves each start before SDK launch; do not pre-checkpoint delegated steps. Never runs reviews/handovers or unselected work. Inspect is read-only and never resumes; verify/reconcile require actual coordinator evidence, and completion remains a separate canonical checkpoint. No arbitrary shell, automatic fixes, refill or retry.",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("run"), Type.Literal("inspect"), Type.Literal("verify"), Type.Literal("reconcile")]),
      plan_path: Type.String(), request_id: Type.Optional(Type.String()), wave_id: Type.String(),
      current_request_authorized: Type.Optional(Type.Boolean()), worker_sessions_authorized: Type.Optional(Type.Boolean()),
      assignments: Type.Optional(Type.Array(Type.Object({ step_id: Type.String(), owned_paths: Type.Array(Type.String()), read_paths: Type.Array(Type.String()),
        resources: Type.Array(Type.String()), independence_evidence: Type.Array(Type.String()) }), { minItems: 1, maxItems: 100 })),
      assignment_id: Type.Optional(Type.String()), evidence: Type.Optional(Type.Array(Type.String())),
      acceptance_met: Type.Optional(Type.Boolean()), integration_checked: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const planPath = canonicalPath(path.resolve(ctx.cwd, params.plan_path));
      const answer = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
      if (params.operation === "inspect") return answer(readDispatchLedger(planPath));
      require(params.current_request_authorized && params.request_id, "Explicit current coordinator authority required");
      const actor = ctx.sessionManager.getSessionId();
      const authority = () => ({ currentRunAuthorized: Boolean(params.current_request_authorized) && !signal?.aborted && !ctx.signal?.aborted && !stopped,
        implementationAllowed: true, actorId: ctx.sessionManager.getSessionId() === actor ? actor : undefined, requestId: params.request_id! });
      signal?.throwIfAborted(); ctx.signal?.throwIfAborted();
      if (params.operation === "verify") {
        require(params.assignment_id, "Assignment identity required");
        const record = readDispatchLedger(planPath).records.find(r => r.assignment.assignment_id === params.assignment_id);
        require(record?.wave_id === params.wave_id, "Assignment does not belong to this wave");
        return answer(await verifyDispatch(planPath, params.assignment_id, authority, { acceptance_met: params.acceptance_met === true, integration_checked: params.integration_checked === true, evidence: params.evidence ?? [] }));
      }
      if (params.operation === "reconcile") return answer(await reconcilePiWave(planPath, params.wave_id, authority, params.evidence ?? []));
      require(params.worker_sessions_authorized, "This invocation needs explicit current permission for worker sessions");
      require(!stopped && !unknown && !active, "Wave host stopped, busy or has unknown writers; inspect existing evidence");
      require(params.assignments?.length, "Explicit assignments required");
      const snapshot = await loadPlanSnapshot(planPath, { followRedirects: false });
      const cwd = canonicalPath(ctx.cwd);
      const resolve = (file: string) => { const p = canonicalPath(path.resolve(cwd, file)); require(p.startsWith(cwd + path.sep), "Claims must be files within the current workspace"); return p; };
      const candidates = params.assignments.map(input => {
        const step = snapshot.plan.steps.find(s => s.id === input.step_id); require(step, "Unknown step");
        const id = `wave:${params.wave_id}:${step.id}`;
        return { assignment: { schema_version: 1 as const, assignment_id: id, plan_path: planPath, plan_id: snapshot.plan.plan_id,
          approved_request_id: params.request_id!, step_id: step.id, scope_digest: stepFingerprint(step).scope, owner: { host: "pi", native_id: actor },
          role: "implementation" as const, cwd, owned_paths: input.owned_paths.map(resolve), acceptance: [step.done_when || step.description || step.title],
          evidence_directory: assignmentDirectory(planPath, id), reasoning_effort: step.reasoning_effort ?? "inherit" as const },
          attempt_id: randomUUID(), read_paths: input.read_paths.map(resolve), resources: input.resources, independence_evidence: input.independence_evidence };
      });
      const { model, runtime } = await childModelProxy(ctx, planPath);
      require(!stopped && !unknown && !active, "Wave host changed while preparing the model");
      const abort = new AbortController();
      const combined = AbortSignal.any([abort.signal, ...[signal, ctx.signal].filter((s): s is AbortSignal => Boolean(s))]);
      const done = runPiWave({ waveId: params.wave_id, candidates, authority, model, modelRuntime: runtime, thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(), signal: combined,
        onProgress: content => pi.sendMessage({ customType: PROGRESS_TYPE, display: true, content, details: { path: planPath, wave_id: params.wave_id } }, { triggerTurn: false }) });
      active = { abort, done };
      try {
        const record = await done;
        if (!record.closed || record.outcome?.quiescence.state !== "verified") unknown = true;
        return answer({ ...record, warning: "Worker evidence is not completion. Inspect/integrate, verify each result, checkpoint each outcome, then reconcile this wave before further dispatch." });
      } catch (error) { unknown = true; throw error; }
      finally { active = undefined; }
    },
  });
}
