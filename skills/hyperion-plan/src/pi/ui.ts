import {
  applyOperations,
  prerequisites,
  stepFingerprint,
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
import { piRunBlocker, piStepBlocker } from "./execution";

type Foreground = "accent" | "border" | "muted" | "warning" | "success" | "error" | "dim" | "text";
type Background = "selectedBg";

interface ThemeLike {
  fg(color: Foreground, text: string): string;
  bg(color: Background, text: string): string;
  bold(text: string): string;
}

export type PlanScreenAction =
  | { type: "close" }
  | { type: "run"; selectedStepIds: string[] }
  | { type: "ask"; stepId: string }
  | { type: "review"; targetStepIds: string[] }
  | { type: "decompose"; stepId: string }
  | { type: "edit"; stepId: string }
  | { type: "add"; afterStepId?: string; milestone?: string }
  | { type: "note"; stepId: string }
  | { type: "remove"; stepId: string }
  | { type: "move"; stepId: string; direction: -1 | 1 }
  | { type: "save" }
  | { type: "discard" }
  | { type: "refresh" }
  | { type: "lifecycle"; lifecycle: "finish" | "reopen" };

type Hit = { x: number; y: number; width: number; action: () => void };

export class PlanScreenState {
  snapshot: PlanSnapshot;
  readonly actorId: string;
  readOnly: boolean;
  selected = new Set<string>();
  focusedStepId?: string;
  view: "steps" | "details" = "steps";
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
    if (readOnly) this.notice = "View only: Pi is busy. No actions are queued or sent.";
    else if (snapshot.refresh_required) this.notice = "Markdown changed outside Hyperion. Press g to refresh before writing.";
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
    if (this.readOnly) return "Pi is busy; this screen is view-only and nothing will be queued.";
    if (this.snapshot.refresh_required) return "Refresh external Markdown changes before writing.";
    if (this.ownerMismatch) return `Plan belongs to ${this.plan.execution_owner}; continue in its owning session.`;
    if (this.plan.handovers?.some(item => ["requested", "prepared", "blocked"].includes(item.state)))
      return "An ownership handover is active. Pi cannot write until a supported host resolves it.";
    if (this.plan.plan_reviews?.some(item => item.state === "requested" || item.state === "running"))
      return "An independent plan review is active. Wait for its findings before writing.";
    if (this.staleDraft) return "A newer canonical revision exists. The local draft is preserved; discard it or reconcile it before saving.";
    return undefined;
  }

  get editBlocker(): string | undefined {
    return this.mutationBlocker ?? (this.plan.lifecycle === "finished" ? "Reopen the finished plan before editing it." : undefined);
  }

  get runBlocker(): string | undefined {
    const common = this.editBlocker;
    if (common) return common;
    return this.selectionProblem();
  }

  setNotice(message: string): void { this.notice = message; }

  setBusy(busy: boolean): void {
    if (this.readOnly === busy) return;
    this.readOnly = busy;
    this.notice = busy
      ? "View only: Pi is busy. Drafts are preserved; no work is queued."
      : this.staleDraft
        ? "Pi is idle. The preserved draft conflicts with newer canonical content; reconcile before saving."
        : "Pi is idle. Editing is available; saved work has not been resumed.";
  }

  acceptSnapshot(snapshot: PlanSnapshot): void {
    const previous = this.plan;
    this.snapshot = snapshot;
    if (this.dirty) {
      this.draftConflict = this.draftBaseRevision !== snapshot.plan.revision ||
        this.draftBaseDigest !== snapshot.source_digest;
      this.notice = this.draftConflict
        ? `Canonical plan content no longer matches the draft from r${this.draftBaseRevision}; the draft is preserved but cannot be saved yet.`
        : snapshot.refresh_required
          ? "Markdown still needs refresh. The staged draft is preserved."
          : "Canonical snapshot refreshed; staged draft is preserved.";
    } else {
      this.reconcileSelection(previous, snapshot.plan);
      this.notice = snapshot.refresh_required
        ? "Markdown changed outside Hyperion. Press g to refresh before writing."
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
      ? `Restored draft from r${baseRevision}, but canonical content has changed. Reconcile before saving.`
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
    const oldById = new Map(previous.steps.map(step => [step.id, step]));
    const nextById = new Map(next.steps.map(step => [step.id, step]));
    for (const id of [...this.selected]) {
      const oldStep = oldById.get(id), nextStep = nextById.get(id);
      if (!oldStep || !nextStep || nextStep.status === "completed" ||
        (nextStep.kind && nextStep.kind !== "implementation") ||
        stepFingerprint(oldStep).scope !== stepFingerprint(nextStep).scope)
        this.selected.delete(id);
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

  constructor(
    private readonly state: PlanScreenState,
    private readonly theme: ThemeLike,
    private readonly refresh: () => void,
    private readonly height: () => number,
    private readonly done: (action: PlanScreenAction) => void,
  ) {}

  invalidate(): void {}

  private dispatch(type: PlanScreenAction["type"]): void {
    const step = this.state.focusedStep;
    if (type === "close") this.done({ type });
    else if (type === "run") {
      const reason = this.state.runBlocker;
      if (reason) { this.state.setNotice(reason); this.refresh(); return; }
      this.done({ type, selectedStepIds: this.state.selectedStepIds });
    } else if (type === "ask") {
      if (this.state.mutationBlocker || this.state.plan.lifecycle === "finished") {
        this.state.setNotice(this.state.mutationBlocker ?? "Reopen the finished plan before asking about it.");
        this.refresh(); return;
      }
      if (this.state.dirty) { this.state.setNotice("Save or discard the current draft before asking Pi."); this.refresh(); return; }
      if (step) this.done({ type, stepId: step.id });
      else { this.state.setNotice("Add a step before asking about one."); this.refresh(); }
    } else if (type === "review") {
      if (this.state.editBlocker || this.state.dirty) {
        this.state.setNotice(this.state.editBlocker ?? "Save or discard the current draft before checking plan freshness.");
        this.refresh(); return;
      }
      const targets = this.state.selectedStepIds.length
        ? this.state.selectedStepIds
        : this.state.displayPlan.steps.filter(item => item.status !== "completed").map(item => item.id);
      if (!targets.length) { this.state.setNotice("There are no unfinished steps to review."); this.refresh(); return; }
      this.done({ type, targetStepIds: targets });
    } else if (type === "decompose") {
      if (this.state.editBlocker || this.state.dirty || !step || step.status !== "pending") {
        this.state.setNotice(this.state.editBlocker ?? (this.state.dirty ? "Save or discard the current draft before decomposition." : "Only pending steps can be decomposed."));
        this.refresh(); return;
      }
      this.done({ type, stepId: step.id });
    } else if (type === "edit") {
      if (this.state.editBlocker || !step) { this.state.setNotice(this.state.editBlocker ?? "Add a step first."); this.refresh(); return; }
      this.done({ type, stepId: step.id });
    } else if (type === "add") {
      if (this.state.editBlocker) { this.state.setNotice(this.state.editBlocker); this.refresh(); return; }
      this.done({ type, ...(step ? { afterStepId: step.id } : {}), ...(step?.milestone ? { milestone: step.milestone } : {}) });
    } else if (type === "note") {
      if (this.state.editBlocker || !step) { this.state.setNotice(this.state.editBlocker ?? "Add a step first."); this.refresh(); return; }
      this.done({ type, stepId: step.id });
    } else if (type === "remove") {
      if (this.state.editBlocker || !step || step.status !== "pending") {
        this.state.setNotice(this.state.editBlocker ?? "Only pending steps can be removed."); this.refresh(); return;
      }
      this.done({ type, stepId: step.id });
    } else if (type === "save") {
      if (this.state.mutationBlocker) { this.state.setNotice(this.state.mutationBlocker); this.refresh(); return; }
      if (!this.state.dirty) { this.state.setNotice("No unsaved plan edits."); this.refresh(); return; }
      this.done({ type });
    } else if (type === "discard") {
      if (this.state.dirty) this.done({ type });
      else { this.state.setNotice("There is no plan draft to discard."); this.refresh(); }
    } else if (type === "refresh") {
      const unsupportedHandover = this.state.plan.handovers?.some(item => ["requested", "prepared", "blocked"].includes(item.state));
      const activeReview = this.state.plan.plan_reviews?.some(item => item.state === "requested" || item.state === "running");
      if (this.state.readOnly || unsupportedHandover || activeReview) {
        const reason = this.state.readOnly ? "Pi is busy; refresh is not queued."
          : unsupportedHandover ? "An ownership handover is active; Pi cannot refresh or write it safely."
            : "An independent plan review is active; wait before refreshing or writing.";
        this.state.setNotice(reason);
        this.refresh(); return;
      }
      this.done({ type });
    } else if (type === "lifecycle") {
      if (this.state.mutationBlocker || this.state.dirty) {
        this.state.setNotice(this.state.mutationBlocker ?? "Save or discard the current draft before finishing or reopening the plan.");
        this.refresh(); return;
      }
      const lifecycle = this.state.plan.lifecycle === "finished" ? "reopen" : "finish";
      this.done({ type, lifecycle });
    }
  }

  private dispatchMove(direction: -1 | 1): void {
    const step = this.state.focusedStep;
    if (!step || step.status !== "pending") { this.state.setNotice("Only pending steps can be reordered."); this.refresh(); return; }
    if (this.state.editBlocker) { this.state.setNotice(this.state.editBlocker); this.refresh(); return; }
    this.done({ type: "move", stepId: step.id, direction });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.dispatch("close"); return; }
    const plan = this.state.displayPlan;
    const index = plan.steps.findIndex(step => step.id === this.state.focusedStepId);
    if (matchesKey(data, "up") || data === "k") this.moveFocus(index - 1);
    else if (matchesKey(data, "down") || data === "j") this.moveFocus(index + 1);
    else if (data === " " || matchesKey(data, "space")) {
      const step = this.state.focusedStep;
      if (step) this.state.toggleSelection(step.id);
      this.refresh();
    } else if (matchesKey(data, "tab") || matchesKey(data, "return")) {
      this.state.view = this.state.view === "steps" ? "details" : "steps";
      this.refresh();
    } else if (matchesKey(data, "pageDown")) { this.state.detailOffset += 4; this.refresh(); }
    else if (matchesKey(data, "pageUp")) { this.state.detailOffset = Math.max(0, this.state.detailOffset - 4); this.refresh(); }
    else if (data === "r") this.dispatch("run");
    else if (data === "v") this.dispatch("review");
    else if (data === "a") this.dispatch("ask");
    else if (data === "e") this.dispatch("edit");
    else if (data === "n") this.dispatch("add");
    else if (data === "m") this.dispatch("note");
    else if (data === "d") this.dispatch("decompose");
    else if (data === "x") this.dispatch("remove");
    else if (data === "s") this.dispatch("save");
    else if (data === "z") this.dispatch("discard");
    else if (data === "g") this.dispatch("refresh");
    else if (data === "f") this.dispatch("lifecycle");
    else if (data === "[") this.dispatchMove(-1);
    else if (data === "]") this.dispatchMove(1);
    else if (data === "q") this.dispatch("close");
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
      if (event.x >= this.detailStart) this.state.detailOffset = Math.max(0, this.state.detailOffset + (event.wheelDelta ?? 0));
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
    return { handled: true, focus: true, render: true };
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
    const bodyHeight = Math.max(1, Math.min(25, availableRows - 15));
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
    const meta = state.readOnly ? "VIEW ONLY · Pi busy · nothing queued" : state.snapshot.refresh_required ? "EXTERNAL EDIT · refresh required" : state.ownerMismatch ? "VIEW ONLY · another session owns execution" : wide ? "One canonical plan · explicit Run · current Pi session executes sequentially" : "Selection is not approval · Run is sequential in this Pi session";
    row(muted(meta));
    rule();

    const leftWidth = wide ? Math.floor((inner - 3) * 0.52) : inner;
    const rightWidth = wide ? inner - leftWidth - 3 : inner;
    this.detailStart = wide ? 2 + leftWidth + 3 : state.view === "details" ? 2 : Infinity;
    row(wide
      ? fit(muted(" STEPS / SPACE TO SELECT"), leftWidth) + muted(" │ ") + fit(muted("CANONICAL DETAILS"), rightWidth)
      : muted(state.view === "steps" ? "STEPS  /  Tab for details" : "DETAILS  /  Tab for steps · PgDn scroll"));

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
      const title = `${kindMark}${this.singleLine(step.short_title || step.title)}`;
      const focused = step.id === state.focusedStepId;
      let titleLine = `${focused ? accent("›") : " "} ${check} ${step.id} ${focused ? theme.bold(title) : title}`;
      titleLine = fit(titleLine, leftWidth);
      if (focused) titleLine = theme.bg("selectedBg", titleLine);
      entries.push({ text: titleLine, stepId: step.id, checkbox: true });
      const status = step.status === "completed"
        ? step.completion_source === "user" ? "done · user marked" : "done"
        : step.status === "in_progress" ? "in progress" : step.blocked_by ? "blocked" : "pending";
      const tags = [status];
      if (step.complexity) tags.push(`${step.complexity} complexity`);
      if (step.reasoning_effort) tags.push(`effort ${step.reasoning_effort}`);
      if (step.parallel_group) tags.push(`group ${step.parallel_group} · sequential here`);
      if (step.needs_replanning) tags.push("needs replanning");
      else if (step.review_state === "needs_review") tags.push("changed · review advisory");
      if (step.depends_on?.length) tags.push(`needs ${step.depends_on.join(",")}`);
      if (step.run_after) tags.push(`run after ${step.run_after}`);
      entries.push({ text: muted(`      ${tags.join(" · ")}`), stepId: step.id });
    }
    const focusLine = entries.findIndex(entry => entry.stepId === state.focusedStepId && entry.checkbox);
    if (focusLine < state.listOffset) state.listOffset = Math.max(0, focusLine - 1);
    if (focusLine >= state.listOffset + bodyHeight) state.listOffset = focusLine - bodyHeight + 1;
    state.listOffset = Math.max(0, Math.min(state.listOffset, Math.max(0, entries.length - bodyHeight)));

    this.lastRightWidth = wide ? rightWidth : inner;
    const details = this.detailLines(plan, state.focusedStep);
    const detailMax = Math.max(0, details.length - bodyHeight);
    state.detailOffset = Math.max(0, Math.min(state.detailOffset, detailMax));
    for (let i = 0; i < bodyHeight; i++) {
      const entry = entries[state.listOffset + i];
      const y = lines.length;
      if (entry?.stepId && (wide || state.view === "steps")) {
        this.hits.push({ x: 2, y, width: leftWidth, action: () => state.setFocused(entry.stepId!) });
        if (entry.checkbox) this.hits.unshift({ x: 4, y, width: 3, action: () => { state.setFocused(entry.stepId!); state.toggleSelection(entry.stepId!); } });
      }
      const detail = details[state.detailOffset + i] ?? "";
      row(wide
        ? fit(entry?.text ?? "", leftWidth) + muted(" │ ") + fit(detail, rightWidth)
        : state.view === "steps" ? entry?.text ?? "" : detail);
    }
    rule();
    const selectedLabel = state.selectedStepIds.length
      ? accent(`${state.selectedStepIds.length} selected`) + muted(" · local only; not approved")
      : muted("No steps selected · saved scopes never resume automatically");
    row(selectedLabel + (state.dirty ? muted(` · ${state.draftOperations.length} draft edit(s)`) : ""));

    const controls: { label: string; action: () => void; enabled: boolean }[] = [
      { label: "[r] Run", action: () => this.dispatch("run"), enabled: !state.runBlocker },
      { label: "[v] Check plan", action: () => this.dispatch("review"), enabled: !state.editBlocker && !state.dirty && state.plan.lifecycle !== "finished" },
      { label: "[a] Ask", action: () => this.dispatch("ask"), enabled: !state.mutationBlocker && !state.dirty && state.plan.lifecycle !== "finished" && !!state.focusedStep },
      { label: "[e] Edit", action: () => this.dispatch("edit"), enabled: !state.editBlocker && !!state.focusedStep },
      { label: "[n] Add", action: () => this.dispatch("add"), enabled: !state.editBlocker },
      { label: "[m] Note", action: () => this.dispatch("note"), enabled: !state.editBlocker && !!state.focusedStep },
      { label: "[d] Split", action: () => this.dispatch("decompose"), enabled: !state.editBlocker && !state.dirty && state.focusedStep?.status === "pending" },
      { label: "[x] Remove", action: () => this.dispatch("remove"), enabled: !state.editBlocker && state.focusedStep?.status === "pending" },
      { label: "[s] Save", action: () => this.dispatch("save"), enabled: state.dirty && !state.mutationBlocker },
      { label: "[z] Discard", action: () => this.dispatch("discard"), enabled: state.dirty },
      { label: state.plan.lifecycle === "finished" ? "[f] Reopen" : "[f] Finish", action: () => this.dispatch("lifecycle"), enabled: !state.mutationBlocker && !state.dirty },
      { label: "[g] Refresh", action: () => this.dispatch("refresh"), enabled: !state.readOnly },
      { label: "[q] Close", action: () => this.dispatch("close"), enabled: true },
    ];
    const controlRows = [controls.slice(0, 7), controls.slice(7)];
    for (const controlRow of controlRows) {
      let x = 2;
      const y = lines.length;
      const labels: string[] = [];
      for (const control of controlRow) {
        const label = control.enabled ? accent(control.label) : muted(control.label);
        labels.push(label);
        if (control.enabled && x + control.label.length <= w - 2)
          this.hits.push({ x, y, width: control.label.length, action: control.action });
        x += control.label.length + 2;
      }
      row(labels.join("  "));
    }
    const notice = this.displayNotice(state);
    const wrappedNotice = wrapTextWithAnsi(notice, inner);
    row(wrappedNotice[0] ?? "");
    row(wrappedNotice[1] ?? "");
    row(muted(wide
      ? "↑↓/jk focus · Space select · PgUp/PgDn details · [ ] reorder · Esc close · mouse in fullscreen"
      : "↑↓/jk focus · Space select · Tab details · PgDn · [ ] reorder · Esc close"));
    lines.push(theme.fg("border", `╰${"─".repeat(w - 2)}╯`));
    return lines.map(line => fit(line, w));
  }

  private singleLine(value: string): string { return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim(); }

  private displayNotice(state: PlanScreenState): string {
    const blocker = state.dirty && state.staleDraft
      ? state.mutationBlocker
      : state.snapshot.refresh_required
        ? state.mutationBlocker
        : state.notice;
    return state.dirty ? `Draft: ${blocker ?? state.notice}` : blocker ?? state.notice;
  }

  private detailLines(plan: Plan, step?: Step): string[] {
    const theme = this.theme;
    const wrap = (value: string) => wrapTextWithAnsi(value, Math.max(1, this.detailWidth));
    if (!step) return [theme.fg("accent", "EMPTY PLAN"), "", ...wrap("No steps yet. Press n to add the first step."), "", theme.fg("muted", "Creating or editing a plan never authorizes implementation.")];
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
    if (step.parallel_group) lines.push(...wrap(`Planned parallel group ${step.parallel_group}; this Pi adapter runs sequentially.`));
    if (step.handover_after) lines.push(...wrap(`Suggested handover after this step: ${step.handover_after}`));
    if (step.kind === "handover") lines.push(theme.fg("warning", "Ownership transfer is not implemented by the first Pi adapter."));
    if (step.comments?.length) {
      lines.push("", theme.fg("muted", "NOTES"));
      for (const note of step.comments) {
        lines.push(...wrap(`[${note.state}] ${note.text}`));
        if (note.response) lines.push(...wrap(`Response: ${note.response}`));
      }
    }
    lines.push("", theme.fg("accent", "[a] Ask Pi about this step"), ...wrap("A question does not authorize implementation."));
    return lines;
  }

  private get detailWidth(): number {
    // Wide-mode detail width is calculated from the current render width. The
    // narrow view still uses the full overlay width through this fallback.
    return Math.max(1, this.lastRightWidth ?? 72);
  }
  private lastRightWidth?: number;
}
