import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { prerequisites, type Plan } from "../model";
import type { PlanSnapshot } from "../service";

export const FOOTER_KEY = "hyperion-plan";
export interface AgentCounts { active: number; unknown: number }
type ThemeLike = { fg(role: "accent" | "text" | "muted" | "dim" | "success" | "warning" | "error" | "border", text: string): string };
// Plan strings are untrusted terminal content, including OSC links and C1 controls.
const clean = (text: string) => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
/** Display state only. No execution inference, scheduling, or canonical writes. */
export class PlanFooter {
  plan?: Plan;
  agents: AgentCounts = { active: 0, unknown: 0 };
  error?: string;
  render(width: number, theme: ThemeLike): string[] {
    if (width < 1) return [];
    const fit = (text: string) => truncateToWidth(text, width);
    const muted = (text: string) => theme.fg("muted", text);
    const separator = theme.fg("dim", " › ");
    if (this.error) return [fit(theme.fg("warning", ` ▣ Plan unavailable: ${clean(this.error)}`)),
      fit(muted(` ${this.agents.active} agents${this.agents.unknown ? ` › ${this.agents.unknown} unknown` : ""}`))];
    const plan = this.plan;
    if (!plan || plan.lifecycle === "finished") return this.agents.active || this.agents.unknown
      ? [fit(theme.fg("accent", " ▣ Hyperion") + separator + muted(`${this.agents.active} agents`) +
        (this.agents.unknown ? separator + theme.fg("warning", `${this.agents.unknown} unknown`) : ""))] : [];
    const incomplete = plan.steps.filter(step => step.status !== "completed");
    const completed = plan.steps.length - incomplete.length;
    const active = incomplete.filter(step => step.status === "in_progress");
    const selected = new Set(plan.execution?.selected_step_ids ?? []);
    const scope = incomplete.filter(step => selected.has(step.id));
    const byId = new Map(plan.steps.map(step => [step.id, step]));
    const ready = (step: Plan["steps"][number]) => !step.blocked_by && prerequisites(step).every(id => byId.get(id)?.status === "completed");
    const next = (scope.length ? scope : incomplete).find(ready);
    const current = active[0];
    const blockers = incomplete.filter(step => step.blocked_by).map(step => `${clean(step.id)}: ${clean(step.blocked_by!)}`);
    if (!active.length && scope.length && !scope.some(ready) && !blockers.length) {
      const waiting = scope[0];
      blockers.push(`${clean(waiting.id)}: waiting for ${prerequisites(waiting).filter(id => byId.get(id)?.status !== "completed").map(clean).join(", ")}`);
    }
    for (const review of plan.plan_reviews ?? []) if (review.state === "blocked") blockers.push(clean(review.note ?? "Independent plan review blocked"));
    for (const handover of plan.handovers ?? []) if (handover.state === "blocked") blockers.push(clean(handover.note ?? "Handover blocked"));
    if (this.agents.unknown) blockers.push(`${this.agents.unknown} assignment${this.agents.unknown === 1 ? " has" : "s have"} unknown settlement; inspect Agents`);
    // Equal-weight completed steps, not an estimate of time or effort remaining.
    const cells = width >= 80 ? 10 : width >= 48 ? 6 : 4;
    const filled = plan.steps.length ? Math.floor(completed / plan.steps.length * cells) : 0;
    const progressColor = completed === plan.steps.length && completed > 0 ? "success" : "accent";
    const progress = muted("[") + theme.fg(progressColor, "█".repeat(filled)) + theme.fg("dim", "░".repeat(cells - filled)) +
      muted("] ") + theme.fg(progressColor, `${completed}/${plan.steps.length}`);
    const title = theme.fg("accent", `▣ ${clean(plan.title)}`);
    const executionState = plan.execution?.state;
    const label = executionState === "paused" ? "Paused" : executionState === "cancelled" ? "Cancelled"
      : current ? "Current" : !incomplete.length && plan.steps.length ? "Complete" : next ? "Next" : "Waiting";
    const step = current ?? next;
    const stepText = `${label}${step ? ` ${clean(step.id)} ${clean(step.short_title ?? step.title)}` : plan.steps.length ? "" : " · No steps yet"}${active.length > 1 ? ` (+${active.length - 1})` : ""}`;
    const currentText = theme.fg(executionState === "paused" || executionState === "cancelled" ? "warning" : current ? "text" : "muted", stepText);
    const metrics = [theme.fg(this.agents.active ? "accent" : "muted", `${this.agents.active} agents`),
      ...(this.agents.unknown ? [theme.fg("warning", `${this.agents.unknown} unknown`)] : []),
      theme.fg(blockers.length ? "warning" : "success", blockers.length ? `! ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}` : "✓ No blockers")];
    const join = (parts: string[]) => " " + parts.join(separator);
    // Short fields keep their full width. Only the plan and step titles flex.
    const names = (budget: number): string[] => {
      const titleWidth = visibleWidth(title), stepWidth = visibleWidth(currentText);
      const titleBudget = Math.min(titleWidth, Math.max(Math.min(16, titleWidth), Math.floor(budget * .35)), budget - Math.min(24, stepWidth));
      const stepBudget = Math.min(stepWidth, budget - titleBudget);
      return [truncateToWidth(title, Math.max(1, budget - stepBudget)), truncateToWidth(currentText, Math.max(1, stepBudget))];
    };
    const shortFields = [progress, ...metrics];
    const budget = width - 1 - shortFields.reduce((total, field) => total + visibleWidth(field), 0) - (shortFields.length + 1) * 3;
    const minimumNames = Math.min(16, visibleWidth(title)) + Math.min(24, visibleWidth(currentText));
    const rows: string[] = [];
    if (budget >= minimumNames) rows.push(fit(join([...names(budget), ...shortFields])));
    else {
      const headerBudget = width - 1 - visibleWidth(progress) - 6;
      if (headerBudget >= minimumNames) rows.push(fit(join([...names(headerBudget), progress])));
      else {
        rows.push(fit(join([truncateToWidth(title, Math.max(1, width - 4 - visibleWidth(progress))), progress])));
        rows.push(fit(" " + currentText));
      }
      // Narrow terminals wrap at field boundaries; agents and blockers remain visible.
      const metricRows: string[] = [];
      for (const metric of metrics) {
        const last = metricRows.length - 1;
        if (last >= 0 && visibleWidth(metricRows[last]) + 3 + visibleWidth(metric) <= width) metricRows[last] += separator + metric;
        else metricRows.push(fit(" " + metric));
      }
      rows.push(...metricRows);
    }
    if (blockers.length) rows.push(fit(theme.fg("warning", ` ! ${blockers[0]}${blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ""}`)));
    return rows;
  }
}

/** An above-editor status strip composes with Pi and powerline-footer. */
export function registerPlanFooter(pi: ExtensionAPI) {
  let state = new PlanFooter(), ctx: ExtensionContext | undefined, actor: string | undefined;
  let render: (() => void) | undefined;
  const refresh = () => render?.();
  const attach = (context: ExtensionContext) => {
    if (ctx?.mode === context.mode && actor === context.sessionManager.getSessionId()) { ctx = context; return; }
    const changed = actor !== context.sessionManager.getSessionId();
    ctx = context; actor = context.sessionManager.getSessionId();
    if (changed) state = new PlanFooter();
    if (context.mode !== "tui") return;
    context.ui.setWidget?.(FOOTER_KEY, (tui, theme) => {
      render = () => tui.requestRender();
      return { render: width => state.render(width, theme), invalidate() {}, dispose() { render = undefined; } };
    }, { placement: "aboveEditor" });
  };
  const reset = (_event: unknown, context: ExtensionContext) => {
    render = undefined; ctx = undefined; actor = undefined; state = new PlanFooter();
    attach(context);
  };
  pi.on("session_start", reset); pi.on("session_tree", reset);
  pi.on("session_shutdown", (_event, context) => {
    render = undefined; ctx = undefined; actor = undefined;
    if (context.mode === "tui") context.ui.setWidget?.(FOOTER_KEY, undefined);
  });
  return {
    update(context: ExtensionContext, snapshot?: PlanSnapshot, error?: string) {
      attach(context);
      state.plan = snapshot?.plan; state.error = error;
      refresh();
    },
    agents(context: ExtensionContext, counts: AgentCounts) { attach(context); state.agents = counts; refresh(); },
  };
}
