import * as path from "node:path";
import * as fs from "node:fs";
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, SelectList, ScrollView } from "@earendil-works/pi-tui";
import { AGENT_ENTRY, type AgentRecord } from "./subagents";
import { latestBinding, latestDraft, discoverPlans, bindPlan, persistDraft } from "./context";
import {
  digestText, record,
  applyOperations,
  prerequisites,
  type Operation,
  type Plan,
  type Step,
} from "../index";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { PlanSnapshot } from "../service";
import { piRunBlocker, piStepBlocker, piMutationBlocker, handleScreenAction, loadPlanSnapshot, createPlan, selectedPlanPath, type PlanScreenAction as CoreScreenAction } from "./executor";
export type PlanScreenAction = CoreScreenAction | { type: "agents" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : undefined;

type Foreground = "accent" | "border" | "muted" | "warning" | "success" | "error" | "dim" | "text";
type Background = "selectedBg";

interface ThemeLike {
  fg(color: Foreground, text: string): string;
  bg(color: Background, text: string): string;
  bold(text: string): string;
}

type Hit = { x: number; y: number; width: number; action: () => void };

export class PlanScreenState {
  snapshot: PlanSnapshot;
  readonly actorId: string;
  readOnly: boolean;
  selected = new Set<string>();
  focusedStepId?: string;
  listOffset = 0;
  detailOffset = 0;
  notice = "Selection is local until you explicitly press Run.";
  draftOperations: Operation[] = [];
  draftBasePlan?: Plan;
  draftBaseRevision?: number;
  draftBaseDigest?: string;
  draftConflict = false;

  constructor(
    snapshot: PlanSnapshot,
    actorId: string,
    readOnly: boolean,
    private readonly onDraftChange?: (state: PlanScreenState) => void,
  ) {
    this.snapshot = snapshot;
    this.actorId = actorId;
    this.readOnly = readOnly;
    this.focusedStepId = snapshot.plan.steps[0]?.id;
    if (readOnly) this.notice = "Pi is busy. Run and plan requests will be queued for the next turn.";
    else if (snapshot.refresh_required) this.notice = "Markdown changed. The agent will reconcile it when you submit a request.";
    else if (this.ownerMismatch) this.notice = `Plan is owned by ${snapshot.plan.execution_owner}; this Pi session cannot write it.`;
    else if (snapshot.plan.execution?.selected_step_ids.length)
      this.notice = "A saved selection exists, but it is not resumed. Select work and press Run explicitly.";
  }

  get plan(): Plan { return this.snapshot.plan; }
  get displayPlan(): Plan {
    if (!this.draftOperations.length) return this.plan;
    try { return applyOperations(this.draftBasePlan ?? this.plan, this.draftOperations); }
    catch { return this.draftBasePlan ?? this.plan; }
  }
  get dirty(): boolean { return this.draftOperations.length > 0; }
  get staleDraft(): boolean {
    return this.draftConflict || (this.dirty && this.draftBaseRevision !== this.plan.revision);
  }
  get ownerMismatch(): boolean {
    return !!this.plan.execution_owner && this.plan.execution_owner !== this.actorId;
  }
  get focusedStep(): Step | undefined {
    const plan = this.displayPlan;
    return plan.steps.find(step => step.id === this.focusedStepId) ?? plan.steps[0];
  }

  get selectedStepIds(): string[] {
    return this.displayPlan.steps.filter(step => this.selected.has(step.id)).map(step => step.id);
  }

  get mutationBlocker(): string | undefined {
    return piMutationBlocker(this.snapshot, this.actorId, this.readOnly, this.staleDraft);
  }

  get editBlocker(): string | undefined {
    return this.mutationBlocker ?? (this.plan.lifecycle === "finished" ? "Reopen the finished plan before editing it." : undefined);
  }

  get runBlocker(): string | undefined {
    return this.selectedStepIds.length ? undefined : "Select work with Space or click its checkbox.";
  }

  setNotice(message: string): void { this.notice = message; }

  setBusy(busy: boolean): void {
    if (this.readOnly === busy) return;
    this.readOnly = busy;
    this.notice = busy
      ? "Pi is busy. Drafts are preserved; explicit requests queue for the next turn."
      : this.staleDraft
        ? "Pi is idle. The agent will reconcile the preserved draft when submitted."
        : "Pi is idle. Editing is available; saved work has not been resumed.";
  }

  acceptSnapshot(snapshot: PlanSnapshot): void {
    if (snapshot.plan.plan_id !== this.plan.plan_id)
      throw new Error("The plan was replaced. Close this screen and select its path explicitly.");
    const previous = this.plan;
    this.snapshot = snapshot;
    if (this.dirty) {
      this.draftConflict = this.draftBaseRevision !== snapshot.plan.revision ||
        this.draftBaseDigest !== snapshot.source_digest;
      this.notice = this.draftConflict
        ? `Draft from r${this.draftBaseRevision} is preserved; the agent will reconcile it on Save or Run.`
        : snapshot.refresh_required
          ? "External Markdown will be reconciled on submission. The staged draft is preserved."
          : "Canonical snapshot refreshed; staged draft is preserved.";
    } else {
      this.reconcileSelection(previous, snapshot.plan);
      this.notice = snapshot.refresh_required
        ? "Markdown changed outside Hyperion. The agent will reconcile it on submission."
        : snapshot.export_warning ?? "Plan refreshed from the canonical file.";
    }
    this.keepFocus();
  }

  stage(operation: Operation): void {
    if (this.editBlocker) throw new Error(this.editBlocker);
    const next = [...this.draftOperations, operation];
    const base = this.draftBasePlan ?? this.plan;
    applyOperations(base, next);
    if (!this.dirty) {
      this.draftBasePlan = this.plan;
      this.draftBaseRevision = this.plan.revision;
      this.draftBaseDigest = this.snapshot.source_digest;
    }
    this.draftOperations = next;
    this.draftConflict = false;
    this.onDraftChange?.(this);
    this.notice = `Unsaved plan edit${next.length === 1 ? "" : "s"}. Save does not authorize implementation.`;
    this.keepFocus();
  }

  clearDraft(): void {
    this.draftOperations = [];
    this.draftBasePlan = undefined;
    this.draftBaseRevision = undefined;
    this.draftBaseDigest = undefined;
    this.draftConflict = false;
    this.onDraftChange?.(this);
    this.reconcileSelection(this.plan, this.plan);
    this.notice = "Draft discarded. The canonical plan and execution scope are unchanged.";
  }

  restoreDraft(basePlan: Plan, operations: Operation[], baseRevision: number, baseDigest: string): void {
    if (basePlan.plan_id !== this.plan.plan_id || basePlan.revision !== baseRevision || !operations.length) return;
    applyOperations(basePlan, operations);
    this.draftBasePlan = basePlan;
    this.draftOperations = operations;
    this.draftBaseRevision = baseRevision;
    this.draftBaseDigest = baseDigest;
    this.draftConflict = baseRevision !== this.plan.revision || baseDigest !== this.snapshot.source_digest;
    this.keepFocus();
    this.notice = this.draftConflict
      ? `Restored draft from r${baseRevision}; the agent will reconcile newer canonical content on submission.`
      : `Restored ${operations.length} unsaved plan edit(s) from this Pi session.`;
  }

  clearSelection(): void { this.selected.clear(); }

  setFocused(stepId: string): void {
    if (this.displayPlan.steps.some(step => step.id === stepId)) this.focusedStepId = stepId;
    this.detailOffset = 0;
  }

  toggleSelection(stepId: string): void {
    const step = this.displayPlan.steps.find(item => item.id === stepId);
    if (!step) return;
    const reason = this.selectBlocker(step);
    if (reason) { this.notice = reason; return; }
    if (this.selected.has(stepId)) this.selected.delete(stepId);
    else this.selected.add(stepId);
    this.notice = `${this.selected.size} local selection(s). Press Run to submit explicit authorization.`;
  }

  selectionProblem(): string | undefined {
    return piRunBlocker(this.displayPlan, this.selectedStepIds);
  }

  private selectBlocker(step: Step): string | undefined {
    return piStepBlocker(this.displayPlan, step);
  }

  private reconcileSelection(previous: Plan, next: Plan): void {
    const nextById = new Map(next.steps.map(step => [step.id, step]));
    for (const id of [...this.selected]) {
      const step = nextById.get(id);
      // Refresh is not a user deselection. Run carries displayed requirements
      // for coordinator reconciliation, including reviews and changed scopes.
      if (!step || step.status === "completed") this.selected.delete(id);
    }
  }

  private keepFocus(): void {
    const plan = this.displayPlan;
    if (!plan.steps.some(step => step.id === this.focusedStepId))
      this.focusedStepId = plan.steps[0]?.id;
  }
}

export class PlanScreen implements Component, Focusable {
  focused = true;
  private hits: Hit[] = [];
  private detailStart = Infinity;
  private detailTop = Infinity;

  constructor(
    private readonly state: PlanScreenState,
    private readonly theme: ThemeLike,
    private readonly refresh: () => void,
    private readonly height: () => number,
    private readonly done: (action: PlanScreenAction) => void,
  ) {}

  invalidate(): void {}

  private dispatch(type: "run" | "close" | "agents"): void {
    if (type === "run") {
      if (this.state.runBlocker) { this.state.setNotice(this.state.runBlocker); this.refresh(); return; }
      this.done({ type, selectedStepIds: this.state.selectedStepIds });
    } else this.done({ type });
  }

  private selectFocused(): void {
    const step = this.state.focusedStep;
    if (step) this.state.toggleSelection(step.id);
    this.refresh();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.dispatch("close"); return; }
    const index = this.state.displayPlan.steps.findIndex(step => step.id === this.state.focusedStepId);
    if (matchesKey(data, "up")) this.moveFocus(index - 1);
    else if (matchesKey(data, "down")) this.moveFocus(index + 1);
    else if (matchesKey(data, "space")) this.selectFocused();
    else if (matchesKey(data, "return")) this.dispatch("run");
    else if (matchesKey(data, "a") || matchesKey(data, "shift+a")) this.dispatch("agents");
    else if (matchesKey(data, "pageDown")) { this.state.detailOffset += 4; this.refresh(); }
    else if (matchesKey(data, "pageUp")) { this.state.detailOffset = Math.max(0, this.state.detailOffset - 4); this.refresh(); }
  }

  private moveFocus(index: number): void {
    const steps = this.state.displayPlan.steps;
    if (!steps.length) return;
    const bounded = Math.max(0, Math.min(steps.length - 1, index));
    this.state.setFocused(steps[bounded]!.id);
    this.refresh();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      if (event.x >= this.detailStart || event.y >= this.detailTop) this.state.detailOffset = Math.max(0, this.state.detailOffset + (event.wheelDelta ?? 0));
      else {
        const index = this.state.displayPlan.steps.findIndex(step => step.id === this.state.focusedStepId);
        this.moveFocus(index + Math.sign(event.wheelDelta ?? 0));
      }
      this.refresh();
      return { handled: true, render: true };
    }
    if ((event.type !== "press" && event.type !== "click") || event.button !== "left") return undefined;
    const hit = this.hits.find(item => event.y === item.y && event.x >= item.x && event.x < item.x + item.width);
    if (!hit) return undefined;
    if (event.type === "press") return { handled: true, focus: true, render: false };
    hit.action();
    // The click may synchronously finish ctx.ui.custom() and dispose this screen.
    // Focus was acquired on press; requesting it again could focus a dead overlay.
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    const theme = this.theme, state = this.state, plan = state.displayPlan;
    const w = Math.max(1, width);
    const fit = (text: string, columns: number) => {
      const clipped = truncateToWidth(text, Math.max(0, columns));
      return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
    };
    const muted = (text: string) => theme.fg("muted", text);
    const accent = (text: string) => theme.fg("accent", text);
    const rowBorder = theme.fg("border", "│ ");
    this.hits = [];
    this.detailStart = Infinity;
    this.detailTop = Infinity;
    if (w < 42 || this.height() < 20) {
      const compact = [
        accent("HYPERION / PLAN"),
        muted("Enlarge terminal to 42 columns / 20 rows."),
        muted(state.readOnly ? "View only while Pi is busy." : "Esc closes; no saved scope resumes."),
      ];
      return compact.slice(0, Math.floor(this.height() * 0.95)).map(text => fit(text, w));
    }

    const inner = w - 4, wide = w >= 100;
    const availableRows = Math.floor(this.height() * 0.95);
    const controls = this.controls();
    const controlRows: typeof controls[] = [];
    let used = 0;
    for (const control of controls) {
      const size = visibleWidth(control.label);
      if (!controlRows.length || used + 2 + size > inner) {
        controlRows.push([]);
        used = 0;
      }
      controlRows[controlRows.length - 1]!.push(control);
      used += (used ? 2 : 0) + size;
    }
    const bodyHeight = Math.min(25, availableRows - 13 - controlRows.length);
    if (bodyHeight < 1) return [accent("HYPERION / PLAN"), muted("Enlarge terminal; Esc closes.")]
      .slice(0, availableRows).map(text => fit(text, w));
    const lines: string[] = [];
    const row = (text: string) => lines.push(rowBorder + fit(text, inner) + theme.fg("border", " │"));
    const rule = () => lines.push(theme.fg("border", `├${"─".repeat(w - 2)}┤`));
    lines.push(theme.fg("border", `╭${"─".repeat(w - 2)}╮`));
    row(accent(theme.bold("HYPERION")) + muted("  /  PLAN") + "   " + theme.fg(state.plan.lifecycle === "finished" ? "warning" : "success", state.plan.lifecycle === "finished" ? "FINISHED" : "CANONICAL PLAN"));
    row(theme.bold(this.singleLine(plan.title)) + muted(`  r${state.plan.revision}${state.dirty ? ` · ${state.staleDraft ? "STALE DRAFT" : "UNSAVED EDITS"}` : ""}`));
    const completed = plan.steps.filter(step => step.status === "completed").length;
    const barWidth = Math.min(18, Math.max(0, Math.floor(inner / 5)));
    const doneBar = plan.steps.length ? Math.round(barWidth * completed / plan.steps.length) : 0;
    row(theme.fg("success", "━".repeat(doneBar)) + muted("─".repeat(barWidth - doneBar)) + `  ${completed}/${plan.steps.length} complete` + (state.plan.execution ? muted(` · saved ${state.plan.execution.state} scope ${state.plan.execution.selected_step_ids.length}`) : muted(" · no saved approval")));
    const mode = state.plan.execution ? state.plan.execution.execution_mode ?? "sequential" : "auto";
    const meta = state.readOnly ? "Pi busy · requests queue for the next turn" : wide ? `Select → Run · agent reconciles readiness · ${mode}` : "Select → Run · agent handles readiness";
    row(muted(meta));
    rule();

    const leftWidth = wide ? Math.floor((inner - 3) * 0.52) : inner;
    const rightWidth = wide ? inner - leftWidth - 3 : inner;
    this.detailStart = wide ? 2 + leftWidth + 3 : Infinity;
    row(wide
      ? fit(muted(" STEPS / SPACE TO SELECT"), leftWidth) + muted(" │ ") + fit(muted("CANONICAL DETAILS"), rightWidth)
      : muted("STEPS / SPACE TO SELECT"));
    const listRows = wide ? bodyHeight : Math.max(1, Math.floor(bodyHeight / 2));
    const detailRows = wide ? bodyHeight : Math.max(0, bodyHeight - listRows - 1);
    this.detailTop = wide ? Infinity : lines.length + listRows + 1;

    const entries: { text: string; stepId?: string; checkbox?: boolean }[] = [];
    let previousMilestone: string | undefined;
    for (const step of plan.steps) {
      if (step.milestone !== previousMilestone) {
        previousMilestone = step.milestone;
        if (step.milestone) entries.push({ text: muted(` ${this.singleLine(step.milestone).toUpperCase()}`) });
      }
      const selected = state.selected.has(step.id);
      const check = step.status === "completed" ? theme.fg("success", "[✓]") : selected ? accent("[x]") : muted(step.kind === "review" || step.kind === "handover" ? "[·]" : "[ ]");
      const kindMark = step.kind === "handover" ? "↪ " : step.kind === "review" ? "◇ " : "";
      const displayTitle = this.singleLine(step.short_title || step.title);
      const executorLabel = /^(🤖|◉)\s+/u;
      const executorIcon = executorLabel.exec(this.singleLine(step.title))?.[1] ?? executorLabel.exec(displayTitle)?.[1];
      const title = `${kindMark}${displayTitle.replace(executorLabel, "")}`;
      const focused = step.id === state.focusedStepId;
      let titleLine = `${focused ? accent("›") : " "} ${check} ${executorIcon ? `${executorIcon} ` : ""}${step.id} ${focused ? theme.bold(title) : title}`;
      titleLine = fit(titleLine, leftWidth);
      if (focused) titleLine = theme.bg("selectedBg", titleLine);
      entries.push({ text: titleLine, stepId: step.id, checkbox: true });
      const status = step.status === "completed"
        ? step.completion_source === "user" ? "done · user marked" : "done"
        : step.status === "in_progress" ? "in progress" : step.blocked_by ? "blocked" : "pending";
      const tags = [status];
      if (step.complexity) tags.push(`${step.complexity} complexity`);
      if (step.reasoning_effort) tags.push(`effort ${step.reasoning_effort}`);
      if (step.parallel_group) tags.push(`group ${step.parallel_group} · assess conflicts`);
      if (step.needs_replanning) tags.push("needs replanning");
      else if (step.review_state === "needs_review") tags.push("changed · review advisory");
      if (step.depends_on?.length) tags.push(`needs ${step.depends_on.join(",")}`);
      if (step.run_after) tags.push(`run after ${step.run_after}`);
      entries.push({ text: muted(`      ${tags.join(" · ")}`), stepId: step.id });
    }
    const focusLine = entries.findIndex(entry => entry.stepId === state.focusedStepId && entry.checkbox);
    if (focusLine < state.listOffset) state.listOffset = Math.max(0, focusLine - 1);
    if (focusLine >= state.listOffset + listRows) state.listOffset = focusLine - listRows + 1;
    state.listOffset = Math.max(0, Math.min(state.listOffset, Math.max(0, entries.length - listRows)));

    this.lastRightWidth = wide ? rightWidth : inner;
    const details = this.detailLines(plan, state.focusedStep);
    const detailMax = Math.max(0, details.length - detailRows);
    state.detailOffset = Math.max(0, Math.min(state.detailOffset, detailMax));
    for (let i = 0; i < bodyHeight; i++) {
      const entry = wide || i < listRows ? entries[state.listOffset + i] : undefined;
      const y = lines.length;
      if (entry?.stepId) {
        this.hits.push({ x: 2, y, width: leftWidth, action: () => state.setFocused(entry.stepId!) });
        if (entry.checkbox) this.hits.unshift({ x: 4, y, width: 3, action: () => { state.setFocused(entry.stepId!); state.toggleSelection(entry.stepId!); } });
      }
      const detail = details[state.detailOffset + (wide ? i : i - listRows - 1)] ?? "";
      row(wide
        ? fit(entry?.text ?? "", leftWidth) + muted(" │ ") + fit(detail, rightWidth)
        : i < listRows ? entry?.text ?? "" : i === listRows ? muted("─ DETAILS ─") : detail);
    }
    rule();
    const selectedLabel = state.selectedStepIds.length
      ? accent(`${state.selectedStepIds.length} selected`) + muted(" · local only; not approved")
      : muted("No steps selected · saved scopes never resume automatically");
    row(selectedLabel + (state.dirty ? muted(` · ${state.draftOperations.length} draft edit(s)`) : ""));

    for (const controlRow of controlRows) {
      let x = 2;
      const y = lines.length;
      const labels: string[] = [];
      for (const control of controlRow) {
        labels.push(control.enabled ? accent(control.label) : muted(control.label));
        if (control.enabled)
          this.hits.push({ x, y, width: visibleWidth(control.label), action: control.action });
        x += visibleWidth(control.label) + 2;
      }
      row(labels.join("  "));
    }
    const notice = this.displayNotice(state);
    const wrappedNotice = wrapTextWithAnsi(notice, inner);
    row(wrappedNotice[0] ?? "");
    row(wrappedNotice[1] ?? "");
    row(muted("↑↓ navigate · plan changes belong in chat"));
    lines.push(theme.fg("border", `╰${"─".repeat(w - 2)}╯`));
    return lines.map(line => fit(line, w));
  }

  private controls(): { label: string; action: () => void; enabled: boolean }[] {
    return [
      { label: "[Space] Select", action: () => this.selectFocused(), enabled: !!this.state.focusedStep && this.state.focusedStep.status !== "completed" },
      { label: "[Enter] Run", action: () => this.dispatch("run"), enabled: !this.state.runBlocker },
      { label: "[Esc] Close", action: () => this.dispatch("close"), enabled: true },
      { label: "[A] Agents", action: () => this.dispatch("agents"), enabled: true },
    ];
  }

  private singleLine(value: string): string { return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim(); }

  private displayNotice(state: PlanScreenState): string {
    return state.dirty ? `Draft preserved: ${state.notice}` : state.notice;
  }

  private detailLines(plan: Plan, step?: Step): string[] {
    const theme = this.theme;
    const wrap = (value: string) => wrapTextWithAnsi(value, Math.max(1, this.detailWidth));
    if (!step) return [theme.fg("accent", "EMPTY PLAN"), "", ...wrap("No steps yet. Ask Pi in chat to add the first step."), "", theme.fg("muted", "Creating or editing a plan never authorizes implementation.")];
    const byId = new Map(plan.steps.map(item => [item.id, item]));
    const lines: string[] = [theme.fg("accent", `STEP ${step.id} / ${(step.kind ?? "implementation").toUpperCase()}`), ...wrap(theme.bold(step.title)), ""];
    if (step.description) lines.push(theme.fg("muted", "DESCRIPTION"), ...wrap(step.description), "");
    if (step.done_when) lines.push(theme.fg("muted", "ACCEPTANCE CRITERIA"), ...wrap(step.done_when), "");
    if (step.checks?.length) {
      lines.push(theme.fg("muted", "REVIEW CHECKS"));
      for (const check of step.checks) lines.push(...wrap(`· ${check}`));
      lines.push("");
    }
    lines.push(theme.fg("muted", "EXECUTION"));
    lines.push(...wrap(`Status: ${step.status}${step.completion_source === "user" ? " (user-marked; not independently verified)" : ""}`));
    if (step.progress_note) lines.push(...wrap(`Recorded result: ${step.progress_note}`));
    if (step.blocked_by) lines.push(theme.fg("error", "Blocked by"), ...wrap(step.blocked_by));
    if (step.needs_replanning) lines.push(theme.fg("warning", "Needs replanning before resuming updated scope."));
    else if (step.review_state === "needs_review") lines.push(theme.fg("warning", `Changed since last review: ${step.review_note || "Inspect changed assumptions during Run."} This warning is advisory.`));
    if (step.scope_warning) lines.push(theme.fg("warning", "Scope warning"), ...wrap(step.scope_warning));
    const deps = prerequisites(step);
    lines.push(...wrap(`Prerequisites: ${deps.length ? deps.map(id => `${id} (${byId.get(id)?.short_title || byId.get(id)?.title || id})`).join(", ") : "none"}`));
    if (step.milestone) lines.push(...wrap(`Milestone: ${step.milestone}`));
    if (step.complexity) lines.push(...wrap(`Complexity: ${step.complexity}${step.complexity_reason ? ` — ${step.complexity_reason}` : ""}`));
    if (step.reasoning_effort) lines.push(...wrap(`Reasoning effort preference: ${step.reasoning_effort}`));
    if (step.parallel_group) lines.push(...wrap(`Planned parallel group ${step.parallel_group} is a hint, not independence evidence. Workers need exact file/read/resource claims; sequential fallback remains available.`));
    if (step.handover_after) lines.push(...wrap(`Suggested handover after this step: ${step.handover_after}`));
    if (step.kind === "handover") lines.push(theme.fg("warning", "Requires ready prerequisites, drained writers and a capable host-owned handoff. Completion follows ownership transfer only; Hyperion does not launch it."));
    if (step.comments?.length) {
      lines.push("", theme.fg("muted", "NOTES"));
      for (const note of step.comments) {
        lines.push(...wrap(`[${note.state}] ${note.text}`));
        if (note.response) lines.push(...wrap(`Response: ${note.response}`));
      }
    }
    lines.push("", ...wrap("Ask about this step in chat. A question does not authorize implementation."));
    return lines;
  }

  private get detailWidth(): number {
    // Wide-mode detail width is calculated from the current render width. The
    // narrow view still uses the full overlay width through this fallback.
    return Math.max(1, this.lastRightWidth ?? 72);
  }
  private lastRightWidth?: number;
}

interface SelectedPlanPath {
  value: string;
  source: "explicit" | "binding" | "discovery";
  planId?: string;
}

async function choosePlanPath(args: string, ctx: ExtensionContext): Promise<SelectedPlanPath | undefined> {
  const provided = args.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (provided) return { value: provided, source: "explicit" };
  const binding = latestBinding(ctx);
  if (binding) return { value: binding.path, source: "binding", planId: binding.plan_id };
  const discovery = await discoverPlans(ctx.cwd);
  if (discovery.selected) return {
    value: discovery.selected.path, source: "discovery", planId: discovery.selected.plan.plan_id,
  };
  if (discovery.diagnostics.length) {
    ctx.ui.notify(`${discovery.diagnostics.join("\n")}\nSpecify a plan path explicitly; no fallback was chosen.`, "error");
    return undefined;
  }
  if (discovery.truncated) ctx.ui.notify("Plan discovery is incomplete. Choose a plan explicitly.", "warning");
  const candidates = discovery.candidates.filter(candidate => candidate.lifecycle !== "finished");
  if (candidates.length) {
    const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const options = candidates.map((candidate, index) =>
      `${index + 1}. ${clean(path.relative(ctx.cwd, candidate.path))} — ${clean(candidate.title)}`);
    const other = "Enter another plan path…";
    const choice = await ctx.ui.select("Choose Hyperion plan", [...options, other]);
    if (choice === undefined) return undefined;
    if (choice !== other) {
      const candidate = candidates[options.indexOf(choice)];
      return candidate ? { value: candidate.path, source: "discovery", planId: candidate.plan_id } : undefined;
    }
  }
  const value = await ctx.ui.input("Open Hyperion plan — enter plan path", "Path to a plan (.md or .json)");
  if (!value?.trim()) return undefined;
  return { value: value.trim(), source: "explicit" };
}

export async function openPlan(args: string, ctx: ExtensionContext, pi: ExtensionAPI, isContextCurrent: () => boolean = () => true,
  openAgents?: (ctx: ExtensionContext) => Promise<"back" | "close">): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("The native Hyperion screen requires Pi interactive TUI. The shared Hyperion CLI remains available.", "warning");
    return;
  }
  const actorId = ctx.sessionManager.getSessionId();
  let openingCurrent = true;
  const offOpenTree = pi.on("session_tree", () => { openingCurrent = false; });
  const offOpenShutdown = pi.on("session_shutdown", () => { openingCurrent = false; });
  const assertOpening = () => {
    if (!isContextCurrent() || !openingCurrent || actorId !== ctx.sessionManager.getSessionId()) throw new Error("The screen/session changed; no plan was created or bound in another session.");
  };
  try {
  const selected = await choosePlanPath(args, ctx);
  assertOpening();
  if (!selected) return;
  let snapshot: PlanSnapshot;
  const resolved = selectedPlanPath(selected.value, ctx.cwd);
  try {
    snapshot = await loadPlanSnapshot(selected.value, { cwd: ctx.cwd });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      ctx.ui.notify(`Could not open Hyperion plan: ${errorMessage(error)}`, "error");
      return;
    }
    if (selected.source !== "explicit") {
      ctx.ui.notify(`The ${selected.source === "binding" ? "session-bound" : "discovered"} plan no longer exists: ${resolved}. Choose a plan path explicitly; Hyperion will not create a replacement automatically.`, "error");
      return;
    }
    if (path.extname(resolved).toLowerCase() !== ".md") {
      ctx.ui.notify("Only an explicitly selected .md path can create a new plan.", "error");
      return;
    }
    const confirmed = await ctx.ui.confirm(
      "Create an empty Hyperion plan?",
      `Create a new canonical Markdown plan at ${resolved}? This does not create tasks or approve implementation.`,
    );
    if (!confirmed) return;
    const title = await ctx.ui.input("Plan title", path.basename(resolved, path.extname(resolved)));
    if (!title?.trim()) return;
    try { snapshot = await createPlan(selected.value, title.trim(), { cwd: ctx.cwd, beforeWrite: assertOpening }); }
    catch (createError) { ctx.ui.notify(`Could not create Hyperion plan: ${errorMessage(createError)}`, "error"); return; }
  }
  if (selected.planId && snapshot.plan.plan_id !== selected.planId) {
    ctx.ui.notify(`The ${selected.source === "binding" ? "session-bound" : "discovered"} path now contains plan ${snapshot.plan.plan_id}, not ${selected.planId}. Specify the path explicitly to bind the replacement.`, "error");
    return;
  }
  assertOpening();
  bindPlan(pi, snapshot);
  const state = new PlanScreenState(snapshot, actorId, !ctx.isIdle(), draft => persistDraft(pi, snapshot, draft));
  const savedDraft = latestDraft(ctx, snapshot.path, snapshot.plan.plan_id);
  if (savedDraft) state.restoreDraft(savedDraft.base_plan, savedDraft.operations, savedDraft.base_revision, savedDraft.base_digest);

  let requestRender: (() => void) | undefined;
  let finishScreen: ((action: PlanScreenAction) => void) | undefined;
  let closed = false;
  let actionEpoch = 0;
  const refreshIdle = async () => {
    try {
      const latest = await loadPlanSnapshot(snapshot.path, { cwd: ctx.cwd });
      if (closed || !isContextCurrent()) return;
      if (latest.plan.plan_id !== snapshot.plan.plan_id) {
        state.setNotice("The plan was replaced. Close this screen and select its path explicitly.");
        state.readOnly = true;
      } else {
        state.acceptSnapshot(latest);
        state.setBusy(!ctx.isIdle());
      }
    } catch (error) {
      if (!closed) { state.readOnly = true; state.setNotice(errorMessage(error)); }
    }
    if (!closed) requestRender?.();
  };
  const offStart = pi.on("agent_start", () => { state.setBusy(true); requestRender?.(); });
  const offSettled = pi.on("agent_settled", () => { void refreshIdle(); });
  const closeScreen = () => { actionEpoch++; closed = true; finishScreen?.({ type: "close" }); };
  const offTree = pi.on("session_tree", closeScreen);
  const offShutdown = pi.on("session_shutdown", closeScreen);
  try { while (!closed && isContextCurrent()) {
    let action = await ctx.ui.custom<PlanScreenAction>((tui, theme, _keys, done) => {
      requestRender = () => tui.requestRender();
      finishScreen = done;
      return new PlanScreen(state, theme, requestRender, () => tui.terminal.rows, value => {
        requestRender = undefined; finishScreen = undefined; done(value);
      });
    }, { overlay: true, overlayOptions: { width: "96%", maxHeight: "95%", anchor: "center" } });
    try {
      const epoch = actionEpoch;
      const assertSession = () => {
        if (!isContextCurrent() || closed || epoch !== actionEpoch || ctx.sessionManager.getSessionId() !== actorId)
          throw new Error("The screen/session changed; no request was sent to another session.");
      };
      const assertCurrent = () => {
        assertSession();
        if (!ctx.isIdle()) throw new Error("Pi became busy; canonical admission is deferred to the queued turn.");
      };
      if (action.type === "agents") {
        assertSession();
        if (!openAgents) { state.setNotice("Agents view is unavailable in this host."); continue; }
        const navigation = await openAgents(ctx);
        assertSession();
        if (navigation === "back") { await refreshIdle(); continue; }
        action = { type: "close" };
      }
      let userText: string | undefined;
      if (action.type === "ask" || action.type === "edit" || action.type === "add" || action.type === "note") {
        const title = action.type === "add" ? "What should be added to the plan?" : action.type === "ask" ? `Ask about ${action.stepId}`
          : action.type === "edit" ? `What should change in ${action.stepId}?` : `Note for ${action.stepId}`;
        userText = (await ctx.ui.input(title, "Question or requested plan change"))?.trim();
        if (!userText) continue;
        if ([...userText].length > 1000) throw new Error("Request must be at most 1,000 characters.");
      }
      const outcome = await handleScreenAction(action, state, ctx, pi, assertCurrent, assertSession, userText);
      if (outcome === "close") {
        if (state.dirty) ctx.ui.notify("Unsaved Hyperion edits are preserved in this Pi session. Reopen the plan to inspect them before an explicit Run.", "info");
        else if (state.selected.size) ctx.ui.notify("Local selection was not saved or resumed. Press Run explicitly next time to authorize work.", "info");
        return;
      }
    } catch (error) {
      state.setNotice(errorMessage(error));
      ctx.ui.notify(errorMessage(error), "error");
    }
  } } finally {
    closed = true;
    offStart?.(); offSettled?.(); offTree?.(); offShutdown?.();
  }
  } finally { offOpenTree?.(); offOpenShutdown?.(); }
}


export const planToolPresentation: Pick<ToolDefinition<any>, "renderCall" | "renderResult"> = {
    renderCall(value, theme) {
      const args = (record(value) ? value : {}) as { action?: string; path?: string };
      const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
      return new Text(`${theme.fg("toolTitle", "Hyperion Plan")} · ${args.action ?? "…"}${args.path ? ` · ${clean(args.path)}` : ""}`, 0, 0);
    },
    renderResult(result, options, theme) {
      if (options.expanded || !record(result.details))
        return new Text(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"), 0, 0);
      const data = result.details;
      if (typeof data.revision !== "number") {
        const count = Array.isArray(data.candidates) ? data.candidates.length : 0;
        const warning = data.error || (Array.isArray(data.diagnostics) && data.diagnostics.length)
          ? " · needs attention" : data.truncated ? " · incomplete scan" : "";
        return new Text(`Discovery · ${count} candidate(s)${warning}`, 0, 0);
      }
      const title = (record(data.summary) && typeof data.summary.title === "string" ? data.summary.title : "Plan")
        .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
      const label = data.screen === "queued" ? "Overlay queued until this turn settles"
        : data.screen === "unavailable" ? "Native overlay unavailable in this mode"
        : data.action === "submit" ? "Request recorded · execution is not automatic"
        : data.action === "checkpoint" || data.action === "plan-review" ? "Coordinator outcome recorded · not machine-certified"
        : data.changed === true ? "Saved · no new implementation approval" : "Inspected";
      return new Text(`${theme.fg("muted", title)} · r${data.revision}\n${label}`, 0, 0);
    },
};

// Observational state only: no execution, cancellation, retry, or plan writes.
const LOG_LIMIT = 64 * 1024;
const logText = (text: string) => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
const messageText = (message: { content?: unknown }) => Array.isArray(message.content)
  ? message.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
export interface AgentActivity {
  record: AgentRecord;
  live: boolean;
  activity: string;
  lastEventAt?: number;
  log: string;
  streaming: string;
  clipped: boolean;
  restored: boolean;
}
export class AgentActivityState {
  readonly agents = new Map<string, AgentActivity>();
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  restore(records: AgentRecord[]): void { for (const r of records) this.record(r); }
  record(record: AgentRecord, live = false): void {
    if (!record || typeof record.id !== "string" || typeof record.transcript_path !== "string") return;
    const prior = this.agents.get(record.id);
    const active = live && !record.settled && ["launching", "running"].includes(record.state);
    this.agents.set(record.id, { record: { ...record }, live: active,
      activity: active ? record.state === "running" && prior?.record.state === "launching" ? "Waiting for response" : prior?.activity ?? record.state
        : record.state === "rejected" ? "Not launched · dispatch rejected"
        : record.settled ? record.report ? "Report available" : "Assignment settled" : "Unknown · no live observer",
      lastEventAt: record.updated_at, log: prior?.log ?? "", streaming: active ? prior?.streaming ?? "" : "",
      clipped: prior?.clipped ?? false, restored: prior?.restored ?? false });
    if (record.limitation && record.limitation !== prior?.record.limitation) this.append(record.id, `Limitation: ${record.limitation}`);
    this.notify();
  }
  private append(id: string, text: string): void {
    const a = this.agents.get(id)!;
    const next = a.log + (a.log && text ? "\n" : "") + logText(text);
    a.clipped ||= next.length > LOG_LIMIT;
    a.log = next.slice(-LOG_LIMIT);
  }
  event(id: string, event: AgentSessionEvent): void {
    const a = this.agents.get(id);
    if (!a?.live) return;
    a.lastEventAt = Date.now();
    if (event.type === "tool_execution_start") {
      a.activity = `${event.toolName}${typeof event.args?.path === "string" ? ` ${event.args.path}` : ""}`;
      this.append(id, `▶ ${a.activity}`);
    } else if (event.type === "message_update" && event.message.role === "assistant") {
      a.activity = "Generating response";
      // Display response text only, not private reasoning or provider payloads.
      const text = logText(messageText(event.message));
      a.clipped ||= text.length > LOG_LIMIT;
      a.streaming = text.slice(-LOG_LIMIT);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      a.streaming = "";
      const text = messageText(event.message);
      if (text) this.append(id, `Assistant\n${text}`);
      if (event.message.errorMessage) this.append(id, `Error: ${event.message.errorMessage}`);
    } else if (event.type === "tool_execution_end") {
      this.append(id, `${event.isError ? "✗" : "✓"} ${event.toolName}\n${messageText(event.result)}`);
      a.activity = "Waiting for response";
    } else if (event.type === "compaction_start") {
      a.activity = "Compacting context"; this.append(id, a.activity);
    } else if (event.type === "compaction_end") {
      a.activity = "Waiting for response";
      this.append(id, event.aborted ? "Compaction aborted" : event.errorMessage ?? "Compaction finished");
    } else return;
    this.notify();
  }
  restoreLog(id: string, sessionDir: string): void {
    const a = this.agents.get(id);
    if (!a || a.restored || a.live) return;
    a.restored = true;
    if (a.record.state === "rejected") return; // No native session/transcript exists for a pre-launch rejection.
    let fd: number | undefined;
    try {
      const base = fs.realpathSync(path.join(sessionDir, "hyperion-agents"));
      const file = fs.realpathSync(a.record.transcript_path);
      if (!file.startsWith(base + path.sep)) throw new Error("Transcript is outside this coordinator's agent directory");
      fd = fs.openSync(file, "r");
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("Transcript is not a regular file");
      const header = Buffer.alloc(Math.min(stat.size, 8192));
      fs.readSync(fd, header, 0, header.length, 0);
      const identity = JSON.parse(header.toString("utf8").split("\n")[0]!);
      if (identity.type !== "session" || identity.id !== a.record.native_id) throw new Error("Transcript identity does not match the assignment");
      const offset = Math.max(0, stat.size - 256 * 1024), tail = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, tail, 0, tail.length, offset);
      const lines = tail.toString("utf8").split("\n");
      if (offset) { lines.shift(); a.clipped = true; }
      a.log = "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line), m = entry.message;
        if (entry.type === "compaction") this.append(id, "Context compacted");
        if (entry.type !== "message" || !m) continue;
        if (m.role === "assistant") {
          for (const c of m.content ?? []) if (c.type === "toolCall")
            this.append(id, `▶ ${c.name}${typeof c.arguments?.path === "string" ? ` ${c.arguments.path}` : ""}`);
          const text = messageText(m); if (text) this.append(id, `Assistant\n${text}`);
        } else if (m.role === "toolResult") this.append(id, `${m.isError ? "✗" : "✓"} ${m.toolName}\n${messageText(m)}`);
      }
      // A single large JSONL message can exceed the tail window entirely.
      if (a.record.report && !a.log.endsWith(logText(a.record.report).slice(-LOG_LIMIT)))
        this.append(id, `Recorded report\n${a.record.report}`);
    } catch (error) {
      this.append(id, `Transcript unavailable: ${errorMessage(error)}`);
      if (a.record.report) this.append(id, `Recorded report\n${a.record.report}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}

export class AgentScreen implements Component {
  private selected?: string;
  private focus: "agents" | "logs" = "agents";
  private list?: SelectList;
  private listKey = "";
  private logKey = "";
  private wrapped: string[] = [];
  private detailStart = 0;
  private bodyRows = 1;
  private readonly logs: ScrollView;
  constructor(readonly state: AgentActivityState, private theme: ThemeLike, private refresh: () => void,
    private height: () => number, private done: (navigation: "back" | "close") => void, private loadLog: (id: string) => void = () => {}) {
    this.logs = new ScrollView({ render: () => this.wrapped, invalidate() {} }, { follow: "end", scrollbar: "hidden" });
  }
  invalidate(): void { this.listKey = ""; this.logKey = ""; }
  private select(id: string): void {
    if (id === this.selected) return;
    this.selected = id; this.loadLog(id); this.logs.scrollToEnd(); this.refresh();
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) { this.done("close"); return; }
    if (data === "b" || data === "B") { this.done("back"); return; }
    if (matchesKey(data, "tab")) this.focus = this.focus === "agents" ? "logs" : "agents";
    else if (matchesKey(data, "left")) this.focus = "agents";
    else if (matchesKey(data, "right") || matchesKey(data, "return")) this.focus = "logs";
    else if (matchesKey(data, "end")) { this.logs.scrollToEnd(); this.focus = "logs"; }
    else if (matchesKey(data, "home")) { this.logs.scrollToStart(); this.focus = "logs"; }
    else if (matchesKey(data, "pageUp")) this.logs.scrollBy(-this.bodyRows);
    else if (matchesKey(data, "pageDown")) this.logs.scrollBy(this.bodyRows);
    else if (this.focus === "agents") this.list?.handleInput(data);
    else if (matchesKey(data, "up")) this.logs.scrollBy(-1);
    else if (matchesKey(data, "down")) this.logs.scrollBy(1);
    this.refresh();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    event = { ...event, x: event.x - 1, y: event.y - 1 };
    if (event.y === 3 + this.bodyRows && event.x >= 0 && event.x < 8 && event.button === "left") {
      if (event.type === "click") { this.done("back"); return { handled: true, render: true }; }
      if (event.type === "press") return { handled: true, focus: true };
    }
    if (event.y < 3 || event.y >= 3 + this.bodyRows) return;
    const logs = this.detailStart === 0 ? this.focus === "logs" : event.x >= this.detailStart;
    if (logs) {
      this.focus = "logs";
      if (event.type === "wheel") this.logs.scrollBy(event.wheelDelta ?? 0);
      else if (event.type !== "press" && event.type !== "click") return;
      this.refresh(); return { handled: true, render: true, ...(event.type === "press" ? { focus: true } : {}) };
    }
    this.focus = "agents";
    const result = this.list?.handleMouse({ ...event, y: event.y - 3 });
    this.refresh(); return result;
  }
  render(width: number): string[] {
    const w = Math.max(1, width - 2), height = Math.max(1, Math.floor(this.height() * .95));
    const fit = (text: string, columns = w) => {
      const clipped = truncateToWidth(text, columns);
      return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
    };
    this.bodyRows = Math.max(1, height - 8);
    const agents = [...this.state.agents.values()].reverse();
    if (!this.selected || !this.state.agents.has(this.selected)) this.select(agents[0]?.record.id ?? "");
    const a = this.state.agents.get(this.selected ?? "");
    const status = (a: AgentActivity) => a.live ? a.record.state : a.record.settled ? a.record.state : "unknown";
    const key = JSON.stringify([agents.map(a => [a.record.id, a.record.title, status(a)]), this.bodyRows]);
    if (key !== this.listKey) {
      this.listKey = key;
      this.list = new SelectList(agents.map(a => ({ value: a.record.id,
        label: `${status(a)} · ${logText(a.record.title ?? a.record.id).replace(/\n/g, " ")}` })), this.bodyRows, {
        selectedPrefix: text => this.theme.fg("accent", text), selectedText: text => this.theme.fg("accent", text),
        description: text => this.theme.fg("muted", text), scrollInfo: text => this.theme.fg("dim", text),
        noMatch: text => this.theme.fg("muted", text),
      });
      this.list.setSelectedIndex(Math.max(0, agents.findIndex(a => a.record.id === this.selected)));
      this.list.onSelectionChange = item => this.select(item.value);
    }
    const wide = w >= 80, leftWidth = Math.min(38, Math.floor(w * .32));
    this.detailStart = wide ? leftWidth + 3 : 0;
    const rightWidth = wide ? w - this.detailStart : w;
    const text = a ? `${a.clipped ? "[Recent log only · complete transcript retained]\n" : ""}${a.log}${a.streaming ? `\nAssistant (streaming)\n${a.streaming}` : ""}`
      || "Waiting for the first activity event…" : "No Hyperion assignments in this coordinator session.";
    const logKey = `${rightWidth}\0${text}`;
    if (this.logKey !== logKey) { this.logKey = logKey; this.wrapped = text.split("\n").flatMap(line => wrapTextWithAnsi(logText(line), rightWidth)); }
    this.logs.updateLayout(this.wrapped.length, this.bodyRows, this.refresh);
    const right = this.logs.render(rightWidth).slice(this.logs.scrollTop, this.logs.scrollTop + this.bodyRows);
    const left = agents.length ? this.list!.render(wide ? leftWidth : w) : [this.theme.fg("muted", "No assignments")];
    const rows = Array.from({ length: this.bodyRows }, (_, i) => wide
      ? fit(left[i] ?? "", leftWidth) + this.theme.fg("border", " │ ") + fit(right[i] ?? "", rightWidth)
      : fit((this.focus === "agents" ? left : right)[i] ?? ""));
    const elapsed = a?.record.started_at ? `${Math.max(0, Math.floor(((a.live ? Date.now() : a.record.updated_at ?? Date.now()) - a.record.started_at) / 1000))}s` : "";
    const activity = a ? `${status(a)}${elapsed ? ` · ${elapsed}` : ""} · ${logText(a.activity).replace(/\n/g, " ")}` : "No assignments yet";
    const idle = a?.live && a.lastEventAt ? ` · last event ${Math.floor((Date.now() - a.lastEventAt) / 1000)}s ago` : "";
    const contents = [this.theme.fg("accent", "HYPERION / AGENTS · coordinator view"),
      this.theme.fg("muted", activity + idle),
      this.theme.fg("accent", wide ? `Agents${this.focus === "agents" ? " [focused]" : ""}`.padEnd(leftWidth) + ` │ Logs${this.focus === "logs" ? " [focused]" : ""}`
        : this.focus === "agents" ? "Agents · Tab opens logs" : "Logs · Tab returns to agents"),
      ...rows, this.theme.fg("muted", "[B] Back · Tab: pane · ↑↓: navigate · PgUp/PgDn: logs"),
      this.theme.fg("muted", `Home: oldest · End: follow · Esc: close${this.logs.isFollowingEnd ? " · following" : " · paused"}`),
      this.theme.fg("dim", "Read-only · closing this view does not stop an assignment")];
    return [this.theme.fg("border", `┌${"─".repeat(w)}┐`),
      ...contents.map(line => this.theme.fg("border", "│") + fit(line) + this.theme.fg("border", "│")),
      this.theme.fg("border", `└${"─".repeat(w)}┘`)].slice(0, height).map(line => truncateToWidth(line, Math.max(1, width)));
  }
}

export function registerAgentView(pi: ExtensionAPI) {
  let actor: string | undefined, state = new AgentActivityState(), open = false, statusText = "";
  const get = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (actor !== id) {
      actor = id; state = new AgentActivityState(); statusText = "";
      const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
      state.restore(entries.filter(e => e.type === "custom" && e.customType === AGENT_ENTRY).map(e => (e as any).data));
    }
    return state;
  };
  const status = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    const agents = [...state.agents.values()];
    const active = agents.filter(a => a.live).length, unknown = agents.filter(a => !a.live && !a.record.settled).length;
    const next = agents.length ? `Agents: ${active} active${unknown ? ` · ${unknown} unknown` : ""} · /hyperion → A` : "";
    if (next !== statusText) { statusText = next; ctx.ui.setStatus?.("hyperion-agents", next || undefined); }
  };
  const show = async (ctx: ExtensionContext): Promise<"back" | "close"> => {
    if (ctx.mode !== "tui") { ctx.ui.notify("The Agents view requires Pi interactive TUI mode.", "warning"); return "close"; }
    if (open) return "close";
    const source = get(ctx); open = true;
    let finish: ((navigation: "back" | "close") => void) | undefined, render: (() => void) | undefined, closed = false;
    const close = () => { closed = true; finish?.("close"); };
    const unsubscribers = [source.subscribe(() => render?.()), pi.on("session_before_switch", close), pi.on("session_before_tree", close),
      pi.on("session_before_fork", close), pi.on("session_start", close), pi.on("session_shutdown", close)];
    const timer = setInterval(() => render?.(), 1000);
    try {
      return await ctx.ui.custom<"back" | "close">((tui, theme, _keys, done) => {
        finish = navigation => { render = undefined; done(navigation); };
        if (closed) { queueMicrotask(() => finish?.("close")); return new Text("Agents view closed", 0, 0); }
        render = () => tui.requestRender();
        return new AgentScreen(source, theme, render, () => tui.terminal.rows, finish,
          id => source.restoreLog(id, ctx.sessionManager.getSessionDir()));
      }, { overlay: true, overlayOptions: { width: "96%", maxHeight: "95%", anchor: "center" } });
    } finally { render = undefined; finish = undefined; clearInterval(timer); for (const off of unsubscribers) off?.(); open = false; }
  };
  pi.on("session_start", (_event, ctx) => {
    actor = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus?.("hyperion-agents", undefined);
    get(ctx); status(ctx);
  });
  return {
    open: show,
    record(ctx: ExtensionContext, r: AgentRecord) { get(ctx).record(r, true); status(ctx); },
    event(ctx: ExtensionContext, id: string, event: AgentSessionEvent) { get(ctx).event(id, event); },
  };
}

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
