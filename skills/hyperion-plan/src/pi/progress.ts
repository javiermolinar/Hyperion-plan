import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { digestText, prerequisites, record, type Plan } from "../index";
import { loadPlanSnapshot } from "../service";

export interface PlanBinding { path: string; plan_id: string }
export const PROGRESS_TYPE = "hyperion-plan.progress";
const clean = (text: string, limit = 120) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit);

export function progressView(plan: Plan): { fingerprint: string; lines: string[] } {
  const completed = plan.steps.filter(step => step.status === "completed");
  const active = plan.steps.filter(step => step.status === "in_progress");
  const blocked = plan.steps.filter(step => step.blocked_by);
  const byId = new Map(plan.steps.map(step => [step.id, step]));
  const next = plan.steps.find(step => step.status === "pending" && !step.blocked_by &&
    prerequisites(step).every(id => byId.get(id)?.status === "completed"));
  const scope = plan.execution;
  const lines = [
    `${clean(plan.title)} · ${completed.length}/${plan.steps.length} complete`,
    ...active.slice(0, 2).map(step => `In progress: ${clean(step.title)}${step.progress_note ? ` — ${clean(step.progress_note, 160)}` : ""}`),
    ...blocked.slice(0, 2).map(step => `Blocked: ${clean(step.title)} — ${clean(step.blocked_by!, 160)}`),
    ...(next ? [`Next candidate: ${clean(next.title)} (not started)`] : []),
    scope ? `Execution: ${scope.state} · ${scope.selected_step_ids.length} selected` : "No implementation approved",
  ];
  // Include scope and recorded progress, not receipts or revision-only bookkeeping.
  const fingerprint = digestText(JSON.stringify({ lifecycle: plan.lifecycle ?? "active", title: plan.title,
    steps: plan.steps.map(step => [step.id, step.title, step.status, step.progress_note, step.blocked_by, step.depends_on, step.run_after]),
    execution: scope ? [scope.state, scope.selected_step_ids] : null }));
  return { fingerprint, lines };
}

/** Observe canonical saves; never select work, continue a turn, or focus an overlay. */
export function registerProgress(pi: ExtensionAPI, binding: (ctx: ExtensionContext) => PlanBinding | undefined): void {
  let lastKey: string | undefined;
  let epoch = 0;
  let queue = Promise.resolve();
  pi.registerMessageRenderer(PROGRESS_TYPE, (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Text(`${theme.fg("accent", "HYPERION · PROGRESS")}\n${content}`, 1, 1);
  });
  const restore = (ctx: ExtensionContext) => {
    epoch++;
    lastKey = undefined;
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom_message" || entry.customType !== PROGRESS_TYPE || !record(entry.details)) continue;
      if (typeof entry.details.key === "string") lastKey = entry.details.key;
      break;
    }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => { epoch++; lastKey = undefined; });
  const observe = (ctx: ExtensionContext): Promise<void> => {
    const generation = epoch;
    queue = queue.catch(() => {}).then(async () => {
      const selected = binding(ctx);
      if (!selected || generation !== epoch) return;
      try {
        const snapshot = await loadPlanSnapshot(selected.path, { cwd: ctx.cwd });
        if (generation !== epoch || snapshot.plan.plan_id !== selected.plan_id) return;
        const current = binding(ctx);
        if (current?.path !== selected.path || current.plan_id !== selected.plan_id) return;
        const { fingerprint, lines } = progressView(snapshot.plan);
        const key = `${snapshot.path}\0${selected.plan_id}\0${fingerprint}`;
        if (snapshot.plan.lifecycle === "finished") { lastKey = key; return; }
        if (lastKey === key) return;
        lastKey = key;
        pi.sendMessage({ customType: PROGRESS_TYPE, display: true,
          content: [`${lines[0]} · r${snapshot.plan.revision}`, ...lines.slice(1)].join("\n"),
          details: { key, path: snapshot.path, plan_id: selected.plan_id, revision: snapshot.plan.revision } },
        { triggerTurn: false });
      } catch {
        // Missing/invalid/replaced files belong in explicit inspection diagnostics, not repeated progress noise.
      }
    });
    return queue;
  };
  pi.on("tool_result", (_event, ctx) => observe(ctx));
  pi.on("turn_end", (_event, ctx) => observe(ctx));
  // Progress messages are display history, not instructions or repeated model context.
  pi.on("context", event => ({ messages: event.messages.filter(message =>
    !(message.role === "custom" && message.customType === PROGRESS_TYPE)) }));
}
