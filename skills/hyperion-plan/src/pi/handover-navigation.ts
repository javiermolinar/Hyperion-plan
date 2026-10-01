import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requireValue as require } from "../model";
import { canonicalPath } from "../storage";
import { loadPlanSnapshot } from "../service";
import type { PiHandoverJournal } from "./handover-journal";
export { PiHandoverJournal } from "./handover-journal";

/** Command-only navigation of an already prepared, settled destination. This
 * does not create sessions or authorize a handover from saved approval alone.
 * journalFor MUST derive authority/identity from its supplied current context;
 * never capture the source's invalidated ExtensionAPI in the destination. */
export async function navigatePiHandover(
  ctx: ExtensionCommandContext,
  journalFor: (current: ExtensionContext) => PiHandoverJournal,
): Promise<{ destination_id: string; transcript_path: string; continuation: "sent" | "already-claimed" }> {
  require(typeof ctx.switchSession === "function" && typeof ctx.waitForIdle === "function", "Handover navigation requires a command context");
  await ctx.waitForIdle();
  const journal = journalFor(ctx), initial = journal.inspect();
  require(initial?.destination, "A persisted ready destination is required; never allocate on a navigation retry");
  const actor = ctx.sessionManager.getSessionId();
  require([initial.source_id, initial.destination.native_id].includes(actor), "Navigation actor is not a handover participant");
  if (actor === initial.source_id) require(ctx.sessionManager.getEntries().some(e => e.type === "custom" && e.customType === "hyperion.handover-source" &&
    (e.data as any)?.plan_path === initial.plan_path && (e.data as any)?.plan_id === initial.plan_id), "Persist the source ownership-fence binding before transfer");
  // A consumed claim may already have advanced code/plan state. Navigate without
  // replaying it; do not demand stale execution digests merely to open its owner.
  if (initial.phase === "claimed") {
    const destination = await journal.navigationTarget();
    let checked = false;
    const switched = await ctx.switchSession(destination.transcript_path, { withSession: async fresh => {
      require(fresh.sessionManager.getSessionId() === destination.native_id, "Wrong replacement identity");
      await journalFor(fresh).navigationTarget(); checked = true;
    } });
    require(!switched.cancelled && checked, "Navigation cancelled; retain the same destination");
    return { destination_id: destination.native_id, transcript_path: destination.transcript_path, continuation: "already-claimed" };
  }
  const transferred = initial.phase === "ready" ? await journal.transfer() : await journal.recoverTransfer();
  // Only plain data crosses the replacement boundary.
  const data = { destination_id: transferred.destination!.native_id, transcript_path: transferred.destination!.transcript_path,
    plan_path: transferred.plan_path, request_id: transferred.request_id, continuation_id: transferred.continuation_id };
  let outcome: "sent" | "already-claimed" | undefined;
  const switched = await ctx.switchSession(data.transcript_path, { withSession: async next => {
    require(next.sessionManager.getSessionId() === data.destination_id, "Wrong replacement session; continuation withheld");
    const claim = await journalFor(next).claimContinuation(data.continuation_id);
    if (!claim.permit) { outcome = "already-claimed"; return; }
    await next.sendUserMessage("HYPERION_CONTINUATION\n" + JSON.stringify(data) + "\nOwnership has transferred to this session. Read the current canonical plan and skill. Continue only the previously approved remaining scope while current execution is approved. Preserve paused/cancelled state and all unselected work. Do not create another session or plan. This message does not expand scope.", { expandPromptTemplates: false });
    outcome = "sent";
  } });
  require(!switched.cancelled && outcome, "Navigation was cancelled or continuation was not confirmed; inspect the same destination, do not recreate it");
  return { destination_id: data.destination_id, transcript_path: data.transcript_path, continuation: outcome };
}

/** Cooperative source/destination tool fence. Restore it in every replacement
 * session's extension factory. Ownership is session-wide, not branch-sensitive:
 * navigating to an earlier branch cannot reclaim an old canonical owner.
 * A fresh unrelated session without these tags is unaffected. */
export function registerPiHandoverOwnerFence(pi: Pick<ExtensionAPI, "on">): void {
  const check = async (ctx: ExtensionContext) => {
    const tags = ctx.sessionManager.getEntries().filter(e => e.type === "custom" &&
      ["hyperion.handover", "hyperion.handover-source"].includes(e.customType));
    for (const entry of tags) {
      const data = (entry as { data: any }).data;
      require(data && typeof data.plan_path === "string" && data.plan_path === canonicalPath(data.plan_path), "Invalid handover ownership binding");
      const snapshot = await loadPlanSnapshot(data.plan_path, { followRedirects: false });
      require(snapshot.plan.plan_id === data.plan_id && snapshot.plan.execution_owner === ctx.sessionManager.getSessionId(),
        "This session does not own the handover plan. Source tools remain blocked; use the destination or a fresh unrelated session.");
    }
  };
  pi.on("tool_call", async (_event, ctx) => {
    try { await check(ctx); } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
  });
  // Public user_bash contract: a thrown handler blocks rather than falling through.
  pi.on("user_bash", async (_event, ctx) => { await check(ctx); });
}
