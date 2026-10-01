import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { checkReady, requireValue as require } from "../model";
import { applyRequest, digestText } from "../transitions";
import { handoverBrief, handoverDigest, updateHandover } from "../handovers";
import { loadPlanSnapshot, mutatePlan } from "../service";
import { canonicalPath, atomicText, markdownStatePath, notesPath } from "../storage";
import { dispatchDirectory } from "./dispatch-ledger";
import { PiHandoverJournal, type PiHandoverJournalOptions } from "./handover-journal";
import { PiHandoverReadinessRunner } from "./handover-readiness";
import { navigatePiHandover } from "./handover-navigation";
import { handoverCodeDigest } from "./handover-code";
import { childModelProxy } from "./model-proxy";
import { PROGRESS_TYPE } from "./progress";

const COMMAND = "hyperion-handover-dispatch";
/** Model tools schedule, but never replace sessions. One session-bound command
 * waits for source settlement, owns readiness, then navigates through fresh APIs.
 * The nonce/authority is in memory only: reload never resumes saved work. */
export function registerPiHandoverTool(pi: ExtensionAPI): void {
  let stopped = false, unknown = false;
  let pending: { nonce: string; actor: string; abort: AbortController; navigating: boolean; detach: () => void;
    execute: (ctx: ExtensionCommandContext) => Promise<void> } | undefined;
  const runner = new PiHandoverReadinessRunner();
  const stop = async () => {
    if (pending?.navigating) return; // Readiness is already joined; this is our replacement.
    stopped = true; pending?.abort.abort(new Error("Source session stopped or switched"));
    const q = await runner.stop(); if (q.state !== "verified") unknown = true;
    return unknown ? { cancel: true } : undefined;
  };
  pi.on("session_before_switch", stop);
  pi.on("session_shutdown", async () => { await stop(); });
  pi.on("session_start", async () => { if (!pending && !unknown) stopped = false; });
  pi.on("before_agent_start", async () => { if (pending && !pending.navigating) pending.abort.abort(new Error("New source model turn revoked pending handover")); });
  pi.on("user_bash", async () => { require(!pending || pending.navigating, "Handover is settling; do not start source shell work"); });
  pi.on("input", async (event, ctx) => {
    if (pending && !pending.navigating && event.source !== "extension") {
      pending.abort.abort(new Error("New source input cancelled pending handover"));
      ctx.ui.notify("Handover cancelled by new input; retry your input after it settles.", "warning");
      return { action: "handled" };
    }
  });
  pi.registerCommand(COMMAND, { description: "Internal current-request handover dispatch; saved state alone cannot invoke it", handler: async (nonce, ctx) => {
    const job = pending;
    require(job && nonce === job.nonce && ctx.sessionManager.getSessionId() === job.actor, "No matching current handover dispatch; use hyperion_handover with current authority");
    try { await ctx.waitForIdle(); job.abort.signal.throwIfAborted(); await job.execute(ctx); }
    catch (error) {
      // Do not invoke a stale source API after replacement. Durable journal/runtime
      // evidence and canonical owner remain authoritative even if UI delivery fails.
      if (!job.navigating && !stopped) pi.sendMessage({ customType: PROGRESS_TYPE, content: `Handover incomplete: ${String(error)}. Inspect the existing destination; do not allocate another.`, display: true, details: {} }, { triggerTurn: false });
      throw error;
    } finally { job.detach(); if (pending === job) pending = undefined; }
  } });
  pi.registerCommand("hyperion-handover-open", { description: "Open the recorded destination without resending a lost continuation or resuming work; optional canonical plan path", handler: async (args, ctx) => {
    require(!pending && !unknown, "Wait for handover settlement before navigation");
    await ctx.waitForIdle();
    const paths = [...new Set(ctx.sessionManager.getEntries().filter(e => e.type === "custom" && ["hyperion.handover", "hyperion.handover-source"].includes(e.customType)).map(e => (e as { data: any }).data?.plan_path).filter(p => typeof p === "string"))];
    const explicit = args.trim() ? (args.trim().startsWith('"') ? JSON.parse(args.trim()) : args.trim()) : undefined;
    require(explicit || paths.length === 1, "Supply the canonical handover plan path");
    const planPath = canonicalPath(path.resolve(ctx.cwd, explicit ?? paths[0]));
    const snapshot = await loadPlanSnapshot(planPath, { followRedirects: false }), actor = ctx.sessionManager.getSessionId();
    const h = [...(snapshot.plan.handovers ?? [])].reverse().find(h => h.state === "transferred" && h.destination_task_id === snapshot.plan.execution_owner && [h.source_task_id, h.destination_task_id].includes(actor));
    require(h, "No transferred destination for this session");
    const journalFor = (fresh: ExtensionContext) => new PiHandoverJournal({ planPath, planId: snapshot.plan.plan_id, requestId: h.request_id, cwd: canonicalPath(fresh.cwd),
      authority: () => ({ actorId: fresh.sessionManager.getSessionId(), requestId: "navigation-only", currentRunAuthorized: false, implementationAllowed: false }),
      observe: () => ({ code_digest: "", source_quiescence: { state: "unknown", reason: "Navigation is not execution" } }) });
    const destination = await journalFor(ctx).navigationTarget();
    let checked = false;
    const result = await ctx.switchSession(destination.transcript_path, { withSession: async fresh => {
      require(fresh.sessionManager.getSessionId() === destination.native_id, "Wrong replacement identity");
      await journalFor(fresh).navigationTarget(); checked = true;
    } });
    require(!result.cancelled && checked, "Navigation cancelled; destination preserved");
  } });
  pi.registerTool({
    name: "hyperion_handover", label: "Hyperion coordinator handover", executionMode: "sequential",
    description: "Transfer at a selected ready handover checkpoint, or continue an explicitly requested existing handover. Requires CURRENT handover/session permission and verified source-writer evidence. Declare all relevant Git source files, including dirty/untracked/deleted files. The source turn stops; a command waits for idle, checks read-only readiness, transfers ownership and navigates to the same persistent destination. Inspect never executes; retries never create another destination. Not worker delegation, history forking, a live-plan test, or automatic resume from saved approval.",
    parameters: Type.Object({ operation: Type.Union([Type.Literal("run"), Type.Literal("resume"), Type.Literal("inspect")]), plan_path: Type.String(),
      request_id: Type.Optional(Type.String()), step_id: Type.Optional(Type.String()), handover_id: Type.Optional(Type.String()),
      current_request_authorized: Type.Optional(Type.Boolean()), handover_sessions_authorized: Type.Optional(Type.Boolean()),
      files: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 2000 })),
      source_writers_drained: Type.Optional(Type.Boolean()), source_quiescence_evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 30 })),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })), next_action: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    }),
    async execute(_id, args, signal, _update, toolCtx) {
      const p = structuredClone(args), planPath = canonicalPath(path.resolve(toolCtx.cwd, p.plan_path));
      const snapshot = await loadPlanSnapshot(planPath, { followRedirects: false });
      const requestId = p.request_id ?? snapshot.plan.execution?.request_id;
      const handoverId = p.handover_id ?? (requestId && p.step_id ? `handover-${digestText(requestId + "\0" + p.step_id)}` : undefined);
      require(handoverId, "Supply handover_id or request_id and step_id");
      const directory = path.join(dispatchDirectory(planPath), "handovers", digestText(handoverId));
      if (p.operation === "inspect") {
        const file = path.join(directory, "state.json");
        require(file === canonicalPath(file), "Aliased handover evidence path");
        const value = { handover: snapshot.plan.handovers?.find(h => h.request_id === handoverId), journal: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
      }
      require(p.current_request_authorized && p.handover_sessions_authorized && requestId, "Explicit current handover and session authority required");
      require(p.source_writers_drained && p.source_quiescence_evidence?.length, "Verify all source-owned writers first; idle alone does not prove process settlement");
      require(!pending && !stopped && !unknown, "Handover host busy/stopped or settlement unknown; inspect existing evidence");
      require(p.files?.length, "Declare all relevant source files");
      const cwd = canonicalPath(toolCtx.cwd), actor = toolCtx.sessionManager.getSessionId();
      const files = p.files.map(f => { const resolved = path.resolve(cwd, f); require(!path.isAbsolute(f) && resolved === canonicalPath(resolved), "Use repository-relative source paths without aliases"); return resolved; });
      const abort = new AbortController(), parentSignals = [signal, toolCtx.signal].filter((s): s is AbortSignal => Boolean(s));
      const cancel = () => abort.abort(new Error("Source turn cancelled"));
      parentSignals.forEach(s => { s.addEventListener("abort", cancel, { once: true }); if (s.aborted) cancel(); });
      const detach = () => parentSignals.forEach(s => s.removeEventListener("abort", cancel));
      const nonce = randomUUID(), thinking = toolCtx.thinkingLevel ?? pi.getThinkingLevel();
      const briefPath = path.join(directory, "brief.md");
      const excludes = [planPath, markdownStatePath(planPath), notesPath(planPath), path.join(path.dirname(planPath), ".plan-history"), path.join(path.dirname(planPath), ".hyperion-dispatch"), planPath + ".lockdir"];
      const guard = () => { abort.signal.throwIfAborted(); require(!stopped && !unknown, "Handover host stopped"); };
      const job = { nonce, actor, abort, navigating: false, detach, execute: async (ctx: ExtensionCommandContext) => {
        guard(); require(ctx.sessionManager.getSessionId() === actor && ctx.isIdle(), "Source identity/idle boundary changed");
        const digest = () => handoverCodeDigest(cwd, files, excludes);
        digest(); // Reject unsafe checkout/claims before canonical preparation or allocation.
        const current = await loadPlanSnapshot(planPath, { followRedirects: false });
        require(current.plan.plan_id === snapshot.plan.plan_id && !current.refresh_required && current.plan.execution?.request_id === requestId && current.plan.execution.state === "approved", "Current scope changed");
        const existing = current.plan.handovers?.find(h => h.request_id === handoverId);
        if (!existing) {
          require(p.operation === "run" && p.step_id && p.summary && p.next_action, "New handover needs a selected checkpoint, summary and next action");
          await mutatePlan(planPath, actor, plan => {
            const step = plan.steps.find(s => s.id === p.step_id);
            require(step?.kind === "handover" && plan.execution?.state === "approved" && plan.execution.selected_step_ids.includes(step.id) && plan.execution.request_id === requestId, "Only a selected handover checkpoint may create an event");
            checkReady(step, Object.fromEntries(plan.steps.map(s => [s.id, s])), [], plan.steps);
            return applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision, request_id: handoverId, intent: "handover", operations: [], target_step_ids: [step.id], handover_reason: step.description || step.title });
          }, { beforeWrite: () => { guard(); require(digestText(fs.readFileSync(planPath, "utf8")) === current.source_digest, "Canonical plan changed before handover request"); } });
        }
        const prepared = await loadPlanSnapshot(planPath, { followRedirects: false });
        const h = prepared.plan.handovers!.find(h => h.request_id === handoverId)!;
        if (h.state === "requested") {
          require(p.summary && p.next_action, "Preparation requires an explicit concise brief");
          const saved = await mutatePlan(planPath, actor, plan => updateHandover(plan, plan.revision, { request_id: handoverId, state: "prepared", brief_path: briefPath,
            summary: p.summary!, next_action: p.next_action!, code_state: `Scoped code observation ${digest()}; files: ${JSON.stringify(files)}` }, actor), { beforeWrite: () => { guard(); require(digestText(fs.readFileSync(planPath, "utf8")) === prepared.source_digest, "Canonical plan changed before preparation"); } });
          atomicText(briefPath, handoverBrief(saved.plan, handoverId));
        }
        const contextFor = (fresh: ExtensionContext): PiHandoverJournalOptions => ({ planPath, planId: snapshot.plan.plan_id, requestId: handoverId, cwd,
          authority: () => ({ actorId: fresh.sessionManager.getSessionId(), requestId, currentRunAuthorized: !abort.signal.aborted && !stopped, implementationAllowed: true }),
          observe: () => ({ code_digest: digest(), source_quiescence: fresh.isIdle() ? { state: "verified", evidence: ["Public command context is idle; journal separately checks dispatch/wave holds.", ...p.source_quiescence_evidence!.map(e => `Coordinator-verified external writers: ${e}`)] } : { state: "unknown", reason: "Coordinator still active" } }) });
        const journal = new PiHandoverJournal(contextFor(ctx));
        let record = journal.inspect();
        if (p.operation === "resume" && record?.phase === "transfer-intent" && h.state === "prepared") record = await journal.reconcileUncommittedTransfer();
        if (p.operation === "resume" && record && ["identified", "ready"].includes(record.phase)) {
          const stable = record.plan_digest === handoverDigest((await loadPlanSnapshot(planPath, { followRedirects: false })).plan) && record.code_digest === digest() && record.brief_digest === digestText(fs.readFileSync(record.brief_path, "utf8"));
          if (!(stable && (record.phase === "ready" || record.retry_claimed === false))) {
            require((await runner.stop()).state === "verified", "Unknown readiness writers; do not retry");
            const runtimePath = path.join(directory, "runtime.json");
            require(runtimePath === canonicalPath(runtimePath) && fs.statSync(runtimePath).size <= 16 * 1024 * 1024, "Invalid runtime evidence path");
            const prior = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
            require(["ready", "failed"].includes(prior.phase) && prior.quiescence?.state === "verified" && (prior.identity ?? prior.destination)?.native_id === record.destination?.native_id, "Settled same-destination runtime evidence required; unknown writers hold recovery");
            record = await journal.reprepare({ attempt: prior.attempt ?? 1, transcript_digest: prior.transcript_digest, quiescence: prior.quiescence });
          }
        }
        if (!record || (p.operation === "resume" && record.phase === "identified" && record.retry_claimed === false)) {
          const { model, runtime } = await childModelProxy(ctx, planPath); guard();
          await runner.run({ context: contextFor(ctx), sessionsAuthorized: () => !abort.signal.aborted && !stopped, modelRuntime: runtime, model, thinkingLevel: thinking, readPaths: files.filter(f => fs.existsSync(f)), signal: abort.signal, resume: Boolean(record) });
        }
        guard();
        pi.appendEntry("hyperion.handover-source", { plan_path: planPath, plan_id: snapshot.plan.plan_id });
        pi.sendMessage({ customType: PROGRESS_TYPE, content: "Readiness settled. Transferring the canonical owner and navigating to the recorded destination.", display: true, details: { path: planPath, handover_id: handoverId } }, { triggerTurn: false });
        await navigatePiHandover({ ...ctx, switchSession: async (file, options) => {
          guard(); require((await runner.stop()).state === "verified", "Readiness settlement unknown");
          job.navigating = true; detach(); // Expected source disposal must not revoke the destination's correlated continuation.
          return ctx.switchSession(file, options);
        } }, fresh => new PiHandoverJournal(contextFor(fresh)));
      } };
      pending = job;
      try { guard(); pi.sendUserMessage(`/${COMMAND} ${nonce}`, { expandPromptTemplates: true, deliverAs: "followUp" }); }
      catch (error) { pending = undefined; detach(); throw error; }
      return { content: [{ type: "text", text: `Handover ${handoverId} queued for the command-side idle boundary. Stop this source turn; do not execute further work. Queuing is not transfer completion.` }], details: { handover_id: handoverId, queued: true }, terminate: true };
    },
  });
}
