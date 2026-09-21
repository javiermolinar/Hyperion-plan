import { parseJSON } from "./json";
import {
  CardConfig,
  Step,
  Intent,
  Operation,
  ChangeRequest,
  clone,
  equal,
  prerequisites,
  validate,
  applyOperations,
  reorderPendingSteps,
} from "./model";
type UiStep = Step & { comments: NonNullable<Step["comments"]> };
type ReviewStep = UiStep & {
  kind: "review";
  depends_on: string[];
  checks: string[];
};
interface Removed {
  step: UiStep;
  index: number;
  selected: boolean;
}
interface SavedDraft {
  modelContent?: {
    kind: string;
    ui_version: number;
    plan_id: string;
    base_revision: number;
    operations: unknown;
    selected_step_ids?: string[];
  };
  privateContent?: {
    expanded?: string[];
    settings?: string[];
    request_ids?: Record<string, string | null>;
    note_editors?: { step_id: string; id: string }[];
  };
}
interface Host {
  widgetState?: SavedDraft;
  setWidgetState?: (state: unknown) => Promise<void> | undefined;
  sendFollowUpMessage?: (message: {
    prompt: string;
    title?: string;
  }) => Promise<void>;
}
declare global {
  interface Window {
    openai?: Host;
  }
  var lucide: { createIcons: (options: unknown) => void } | undefined;
}
(() => {
  const root = document.getElementById("__PLAN_ROOT__")!;
  function q<T extends HTMLElement = HTMLElement>(
    selector: string,
    parent: ParentNode = root,
  ): T {
    const element = parent.querySelector<T>(selector);
    if (!element) throw Error("Missing card element: " + selector);
    return element;
  }
  const config = parseJSON(q(".pc-data").textContent!) as CardConfig;
  const finished = config.plan.lifecycle === "finished";
  const { execution, ...view } = config.plan;
  validate(view);
  const base = {
    ...config.plan,
    steps: config.plan.steps.map((step) => ({
      ...step,
      comments: step.comments || [],
    })),
  };
  base.steps.forEach((step) => {
    step.comments = step.comments || [];
  });
  const uid = () =>
    globalThis.crypto?.randomUUID?.() ||
    "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  const list = q(".pc-steps"),
    apply = q<HTMLButtonElement>(".pc-apply"),
    implement = q<HTMLButtonElement>(".pc-implement"),
    lifecycle = q<HTMLButtonElement>(".pc-lifecycle"),
    message = q(".pc-status");
  let draft = clone(base.steps),
    selected = new Set<string>(),
    expanded = new Set<string>(),
    settings = new Set<string>(),
    removed: Removed[] = [],
    notes = new Map<string, { id: string; text: string }>(),
    menu: string | null = null,
    sending: Intent | false = false,
    requestIds: Record<string, string | null> = {},
    interacted = false;
  let dragging: string | null = null;
  let dragPointer: {
    id: number;
    handle: HTMLButtonElement;
    x: number;
    y: number;
    started: boolean;
  } | null = null;
  let dropTarget: {
    id: string;
    after: boolean;
    steps: UiStep[] | null;
    error: string;
  } | null = null;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    text?: string,
  ) => {
    const item = document.createElement(tag);
    if (cls) item.className = cls;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  const btn = (
    text: string,
    cls: string,
    handler: (event: MouseEvent) => unknown,
  ) => {
    const item = el("button", cls + " cursor-interaction", text);
    item.type = "button";
    item.addEventListener("click", handler);
    return item;
  };
  const icon = (name: string) => {
    const item = el("i");
    item.dataset.lucide = name;
    item.setAttribute("aria-hidden", "true");
    return item;
  };
  const focus = (id: string) =>
    document.getElementById(root.id + "-" + id)?.focus();
  function notify(text: string) {
    message.textContent = text;
    message.hidden = !text;
  }
  const byId = (id: string) => draft.find((s) => s.id === id);
  const stepNumber = (id: string) => draft.findIndex((s) => s.id === id) + 1;
  const shortLabel = (step: Step) => step.short_title || step.title;
  const isReview = (step: Step | undefined): step is ReviewStep =>
    step?.kind === "review";
  const executionDeps = prerequisites;
  function dependsOn(
    id: string,
    target: string,
    seen = new Set<string>(),
  ): boolean {
    if (id === target) return true;
    if (seen.has(id) || !byId(id)) return false;
    seen.add(id);
    return executionDeps(byId(id)!).some((dep) => dependsOn(dep, target, seen));
  }
  const defaultChecks = [
    "Verify the intended behavior and acceptance criteria.",
    "Check regressions in surrounding behavior.",
    "Exercise relevant edge cases and failure paths.",
    "Inspect test coverage and independently run relevant checks.",
  ];
  function runLabel(ids = selection()) {
    const count = ids.length,
      reviews = ids.filter((id) => isReview(byId(id))).length;
    return count
      ? reviews === count
        ? `Run ${count === 1 ? "review" : count + " reviews"}`
        : reviews
          ? `Run ${count} steps`
          : `Implement ${count} ${count === 1 ? "step" : "steps"}`
      : draft.some(isReview)
        ? "Run selected"
        : "Implement selected";
  }
  function openStep(id: string) {
    expanded.add(id);
    save();
    render();
    const target = document.getElementById(root.id + "-expand-" + id);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }
  const complexityLabel = (step: Step) =>
    !step.complexity || step.complexity === "unknown"
      ? "Complexity not assessed"
      : step.complexity[0].toUpperCase() +
        step.complexity.slice(1) +
        " complexity";
  function selectStep(id: string, checked: boolean, focusId: string) {
    if (checked) selected.add(id);
    else selected.delete(id);
    const before = selected.size;
    selected = new Set(selection());
    requestIds.implement = null;
    notify(
      before > selected.size ? "Dependent steps were also deselected." : "",
    );
    save();
    render();
    focus(focusId);
  }
  function planningActions(container: HTMLElement, step: UiStep) {
    if (step.status === "completed") return;
    if (reviewReason(step)) {
      const targets = relatedReviewTargets(step),
        label =
          targets.length <= 2
            ? "Review " + targets.map((id) => "#" + stepNumber(id)).join(" & ")
            : `Review ${targets.length} affected steps`;
      const review = btn(label, "pc-row-action pc-review-action", () =>
        submit("review", targets),
      );
      review.disabled = !!sending;
      container.append(review);
    }
    if (broad(step)) {
      const split = btn("Split step", "pc-row-action pc-split-action", () =>
        submit("decompose", [step.id]),
      );
      split.disabled = !!sending;
      container.append(split);
    }
  }
  function relatedReviewTargets(step: UiStep) {
    const roots = new Set<string>(),
      visited = new Set<string>();
    function collect(s: UiStep | undefined) {
      if (!s || visited.has(s.id) || s.status === "completed") return;
      visited.add(s.id);
      if (s.review_state === "needs_review") roots.add(s.id);
      for (const id of executionDeps(s)) collect(byId(id));
    }
    collect(step);
    if (!roots.size) roots.add(step.id);
    for (let pass = 0; pass < draft.length; pass++)
      for (const s of draft)
        if (
          s.status !== "completed" &&
          executionDeps(s).some((id) => roots.has(id))
        )
          roots.add(s.id);
    return draft.filter((s) => roots.has(s.id)).map((s) => s.id);
  }
  const broad = (step: Step) => step.size === "XL" || !!step.scope_warning;
  function reviewReason(
    step: Step,
    visited = new Set<string>(),
    memo = new Map<string, string>(),
  ): string {
    if (memo.has(step.id)) return memo.get(step.id)!;
    if (step.review_state === "needs_review")
      return step.review_note || "Review this step against the current code.";
    if (visited.has(step.id)) return "Prerequisite cycle needs review.";
    const next = new Set(visited);
    next.add(step.id);
    for (const id of executionDeps(step)) {
      const dep = byId(id),
        old = base.steps.find((s) => s.id === id);
      if (dep && old && dep.status !== old.status)
        return "Save prerequisite changes and review this step first.";
      if (
        dep && old &&
        (!equal(dep.comments, old.comments) || notes.get(dep.id)?.text.trim())
      )
        return "Save prerequisite notes and review this step first.";
      if (dep && reviewReason(dep, next, memo)) {
        memo.set(step.id, "A prerequisite needs review first.");
        return memo.get(step.id)!;
      }
    }
    memo.set(step.id, "");
    return "";
  }
  function blockReason(step: Step, candidates = selected) {
    if (reviewReason(step)) return "Needs review";
    if (step.blocked_by) return "Blocked: " + step.blocked_by;
    const missing = executionDeps(step).filter(
      (id) => byId(id)?.status !== "completed" && !candidates.has(id),
    );
    return missing.length
      ? "Select first: " +
          (byId(missing[0])?.title || missing[0]) +
          (missing.length > 1 ? ` (+${missing.length - 1} more)` : "")
      : "";
  }
  function availableSelection(
    candidates = new Set(
      draft.filter((s) => s.status !== "completed").map((s) => s.id),
    ),
  ) {
    const result = new Set<string>();
    for (let pass = 0; pass < draft.length; pass++)
      for (const step of draft)
        if (
          step.status !== "completed" &&
          candidates.has(step.id) &&
          !blockReason(step, result)
        )
          result.add(step.id);
    return result;
  }
  function selection() {
    const valid = availableSelection(selected);
    return draft.filter((step) => valid.has(step.id)).map((step) => step.id);
  }
  function operations(): Operation[] {
    const ops: Operation[] = [],
      statusOps: Operation[] = [];
    for (const old of base.steps)
      if (!draft.some((s) => s.id === old.id))
        ops.push({ type: "remove_step", step_id: old.id });
    for (const [index, step] of draft.entries()) {
      const old = base.steps.find((s) => s.id === step.id);
      if (old && step.status !== old.status)
        statusOps.push({
          type: "set_status",
          step_id: step.id,
          status: step.status as "pending" | "completed",
        });
      if (!old) {
        const op: Extract<Operation, { type: "add_step" }> = {
          type: "add_step",
          step_id: step.id,
          title: step.title,
          description: step.description || "",
          done_when: step.done_when || "",
        };
        if (isReview(step))
          Object.assign(op, {
            kind: "review",
            depends_on: step.depends_on,
            checks: step.checks,
            run_after: step.run_after,
            after_step_id: draft[index - 1]?.id,
          });
        ops.push(op);
      } else if (isReview(step) && canReorder(step)) {
        if (
          JSON.stringify(step.depends_on) !== JSON.stringify(old.depends_on) ||
          JSON.stringify(step.checks) !== JSON.stringify(old.checks)
        )
          ops.push({
            type: "update_review",
            step_id: step.id,
            depends_on: step.depends_on,
            checks: step.checks,
          });
        if (step.run_after !== old.run_after)
          ops.push({
            type: "move_review",
            step_id: step.id,
            after_step_id: step.run_after!,
          });
      }
      if (!old && step.status !== "pending")
        statusOps.push({
          type: "set_status",
          step_id: step.id,
          status: step.status as "pending" | "completed",
        });
      for (const comment of old?.comments || [])
        if (!step.comments.some((c) => c.id === comment.id))
          ops.push({
            type: "remove_comment",
            step_id: step.id,
            comment_id: comment.id,
          });
      for (const comment of step.comments)
        if (!(old?.comments || []).some((c) => c.id === comment.id))
          ops.push({
            type: "add_comment",
            step_id: step.id,
            comment_id: comment.id,
            text: comment.text,
          });
      const note = notes.get(step.id);
      if (note?.text.trim())
        ops.push({
          type: "add_comment",
          step_id: step.id,
          comment_id: note.id,
          text: note.text.trim(),
        });
    }
    const projected = base.steps.map((step) => step.id);
    for (const op of ops) {
      if (op.type === "remove_step" || op.type === "move_review")
        projected.splice(projected.indexOf(op.step_id), 1);
      if (op.type === "add_step" || op.type === "move_review") {
        const index = op.after_step_id
          ? projected.indexOf(op.after_step_id) + 1
          : projected.length;
        projected.splice(index, 0, op.step_id);
      }
    }
    const order = draft.map((step) => step.id);
    if (projected.some((id, index) => order[index] !== id))
      ops.push({ type: "reorder_steps", step_ids: order });
    return [...ops, ...statusOps];
  }
  function withinLimit() {
    const ops = operations();
    return (
      ops.length <= 100 &&
      new TextEncoder().encode(JSON.stringify(ops)).length < 10000
    );
  }
  function replay(ops: unknown): UiStep[] {
    const { execution, ...publicBase } = base;
    return applyOperations(publicBase, ops).steps.map((step) => ({
      ...step,
      comments: step.comments || [],
    }));
  }
  function save() {
    interacted = true;
    const snapshot = {
      modelContent: {
        kind: "plan-companion",
        ui_version: 3,
        plan_id: base.plan_id,
        base_revision: base.revision,
        unsubmitted: true,
        selected_step_ids: selection(),
        operations: operations(),
      },
      privateContent: {
        expanded: [...expanded],
        settings: [...settings],
        request_ids: requestIds,
        note_editors: [...notes]
          .filter(([id]) => draft.some((s) => s.id === id))
          .map(([step_id, n]) => ({ step_id, id: n.id })),
      },
    };
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length >= 15000)
      return;
    try {
      window.openai?.setWidgetState?.(snapshot)?.catch(() => {});
    } catch {}
  }
  function restoredView() {
    return JSON.stringify({
      draft,
      selected: [...selected].sort(),
      expanded: [...expanded].sort(),
      settings: [...settings].sort(),
      notes: [...notes].sort(([a], [b]) => a.localeCompare(b)),
    });
  }
  function restore(saved: SavedDraft | null | undefined) {
    const state = saved?.modelContent;
    if (
      !saved ||
      state?.kind !== "plan-companion" ||
      state.plan_id !== base.plan_id ||
      state.base_revision !== base.revision
    )
      return false;
    try {
      const previousView = restoredView();
      if (finished) {
        // Restore inspection and retry state only; closed plans never replay edits.
        expanded = new Set((saved.privateContent?.expanded || []).filter(id => base.steps.some(step => step.id === id)));
        const retry = saved.privateContent?.request_ids?.reopen;
        requestIds = typeof retry === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(retry) ? { reopen: retry } : {};
        return restoredView() !== previousView;
      }
      const restored = replay(state.operations),
        restoredNotes = new Map<string, { id: string; text: string }>();
      for (const editor of saved.privateContent?.note_editors || []) {
        const step = restored.find((s) => s.id === editor.step_id),
          note = step?.comments.find((c) => c.id === editor.id);
        if (
          step &&
          note &&
          !(base.steps.find((s) => s.id === step.id)?.comments || []).some(
            (c) => c.id === note.id,
          )
        ) {
          restoredNotes.set(step.id, { id: note.id, text: note.text });
          step.comments = step.comments.filter((c) => c.id !== note.id);
        }
      }
      draft = restored;
      notes = restoredNotes;
      selected = new Set(
        (Array.isArray(state.selected_step_ids)
          ? state.selected_step_ids
          : []
        ).filter((id) =>
          draft.some((s) => s.id === id && s.status !== "completed"),
        ),
      );
      selected = new Set(selection());
      expanded = new Set(
        Array.isArray(saved.privateContent?.expanded)
          ? saved.privateContent.expanded
          : [],
      );
      settings = new Set(
        Array.isArray(saved.privateContent?.settings)
          ? saved.privateContent.settings
          : [],
      );
      requestIds =
        (state.ui_version === 3 && saved.privateContent?.request_ids) || {};
      // Host environment updates can repeat a saved draft. Keep the existing
      // rows, focus, text selection, and open menu when its visible state is
      // unchanged, including the first late delivery of an empty draft.
      if (restoredView() === previousView) return false;
      menu = null;
      return true;
    } catch {
      return false;
    }
  }
  function changed() {
    requestIds = {};
    notify("");
    save();
  }
  function mutate(change: () => unknown) {
    if (finished) return false;
    const before = clone(draft);
    try {
      change();
      if (!withinLimit())
        throw Error("Save your existing edits before adding more.");
      replay(operations());
    } catch (error) {
      draft = before;
      render();
      notify((error as Error).message);
      return false;
    }
    selected = new Set(selection());
    changed();
    render();
    return true;
  }
  function canReorder(step: UiStep) {
    const original = base.steps.find((old) => old.id === step.id);
    return (
      step.status === "pending" && (!original || original.status === "pending")
    );
  }
  function orderAt(id: string, target: string, after: boolean) {
    const source = byId(id);
    if (!source || !canReorder(source) || !byId(target))
      throw Error("Only pending tasks can be reordered");
    if (id === target) return draft;
    const order = draft.filter((step) => step.id !== id).map((step) => step.id);
    order.splice(order.indexOf(target) + Number(after), 0, id);
    return reorderPendingSteps(draft, order, base.steps);
  }
  function commitOrder(id: string, steps: UiStep[]) {
    if (sending || steps.every((step, index) => step.id === draft[index].id))
      return;
    if (
      mutate(() => {
        draft = steps;
        menu = null;
      })
    ) {
      focus("drag-" + id);
      notify(`Moved “${byId(id)!.title}” to #${stepNumber(id)}.`);
    }
  }
  function moveOne(id: string, direction: number) {
    const target = draft[draft.findIndex((step) => step.id === id) + direction];
    if (!target) return;
    try {
      commitOrder(id, orderAt(id, target.id, direction > 0));
    } catch (error) {
      notify((error as Error).message);
    }
  }
  function clearDropMarks() {
    list
      .querySelectorAll(".pc-drop-before,.pc-drop-after,.pc-drop-invalid")
      .forEach((row) =>
        row.classList.remove(
          "pc-drop-before",
          "pc-drop-after",
          "pc-drop-invalid",
        ),
      );
  }
  function endDrag() {
    const pointer = dragPointer;
    dragPointer = null;
    dragging = null;
    dropTarget = null;
    clearDropMarks();
    list.querySelector(".pc-dragging")?.classList.remove("pc-dragging");
    if (pointer?.handle.hasPointerCapture(pointer.id))
      pointer.handle.releasePointerCapture(pointer.id);
  }
  function updateDrop(event: PointerEvent) {
    if (!dragging || !dragPointer || event.pointerId !== dragPointer.id) return;
    if (!dragPointer.started) {
      if (
        Math.hypot(
          event.clientX - dragPointer.x,
          event.clientY - dragPointer.y,
        ) < 4
      )
        return;
      dragPointer.started = true;
      dragPointer.handle.closest(".pc-row")?.classList.add("pc-dragging");
    }
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".pc-row");
    const step = row?.dataset.step ? byId(row.dataset.step) : undefined;
    if (!row || !list.contains(row) || !step) {
      dropTarget = null;
      clearDropMarks();
      return;
    }
    const bounds = row.getBoundingClientRect();
    const after = event.clientY > bounds.top + bounds.height / 2;
    if (dropTarget?.id === step.id && dropTarget.after === after) return;
    clearDropMarks();
    try {
      dropTarget = {
        id: step.id,
        after,
        steps: orderAt(dragging, step.id, after),
        error: "",
      };
    } catch (error) {
      dropTarget = {
        id: step.id,
        after,
        steps: null,
        error: (error as Error).message,
      };
    }
    row.classList.add(
      dropTarget.error
        ? "pc-drop-invalid"
        : after
          ? "pc-drop-after"
          : "pc-drop-before",
    );
    notify(dropTarget.error);
  }
  function updateActions() {
    const ids = selection(),
      ops = operations(),
      available = draft.filter((s) => s.status !== "completed").length;
    q(".pc-selection-summary").textContent = ids.length
      ? `${ids.length} selected · ${available - ids.length} left for later`
      : available
        ? draft.some(isReview)
          ? "Choose steps to run"
          : "Choose steps to implement"
        : "All steps complete";
    const selectable = availableSelection();
    const all = q<HTMLButtonElement>(".pc-select-all");
    all.textContent =
      ids.length && ids.length === selectable.size
        ? "Clear selection"
        : selectable.size === available
          ? "Select all"
          : "Select available";
    all.disabled = !selectable.size || !!sending;
    const edited = new Set(
      ops.flatMap((op) => (op.type === "reorder_steps" ? [] : [op.step_id])),
    ).size;
    const hint = q(".pc-interaction-hint");
    hint.hidden = !available;
    hint.textContent = draft.some(canReorder)
      ? "Drag the grip to reorder pending tasks · Tick a checkbox to choose work"
      : "Tick a checkbox to choose work";
    q(".pc-scope").hidden = !edited;
    q(".pc-scope").textContent = edited
      ? `${edited} ${edited === 1 ? "step has" : "steps have"} unsaved edits`
      : ids.length
        ? "Only selected steps will run"
        : "Nothing selected";
    apply.hidden = !edited;
    apply.disabled = !!sending;
    apply.textContent = sending === "edit" ? "Opening…" : "Save edits";
    q<HTMLButtonElement>(".pc-add-toggle").disabled = !!sending;
    q<HTMLButtonElement>(".pc-add-button").disabled = !!sending;
    q<HTMLSelectElement>(".pc-add-type").disabled = !!sending;
    q<HTMLOptionElement>('.pc-add-type option[value="review"]').disabled =
      !draft.some((s) => !isReview(s));
    q<HTMLButtonElement>(".pc-insert-review").disabled =
      !!sending || draft.length >= 30 || !draft.some((s) => !isReview(s));
    q(".pc-storage").textContent = config.preview
      ? "Demo edits stay in this card; they are not written to the plan file."
      : edited
        ? "Unsaved draft · Save edits sends it to Codex for writing to disk."
        : ops.length
          ? "Order updated in this card · included with your next plan action."
          : `Saved plan · revision ${base.revision} · checks and notes kept in ${config.source_name || "the plan file"} and PR notes.`;
    implement.disabled = !!sending || !ids.length;
    implement.textContent =
      sending === "implement" ? "Opening…" : runLabel(ids);
    const large = ids.filter((id) => broad(byId(id)!));
    q(".pc-large-warning").hidden = !large.length;
    q<HTMLButtonElement>(".pc-decompose-selection").disabled = !!sending;
    if (ops.length && ids.length)
      q(".pc-scope").textContent += " · included when implementing";
    lifecycle.disabled = !!sending;
    lifecycle.textContent = sending === "finish" || sending === "reopen"
      ? "Opening…"
      : finished ? "Reopen plan" : ops.length ? "Save & finish plan" : "Finish plan";
    q(".pc-lifecycle-note").textContent = finished
      ? "Automatic cards are off. Reopen to continue planning."
      : "Stops automatic cards; keeps unfinished tasks.";
    if (finished) {
      q(".pc-selection-bar").hidden = true;
      q(".pc-interaction-hint").hidden = true;
      q(".pc-add-area").hidden = true;
      apply.hidden = true;
      implement.hidden = true;
      q(".pc-large-warning").hidden = true;
      q(".pc-scope").hidden = true;
    }
  }
  function updateParallelSummary() {
    const unfinished = draft.filter((s) => s.status !== "completed"),
      ready = unfinished
        .filter((s) => !blockReason(s, new Set()))
        .map((s) => "#" + stepNumber(s.id));
    q(".pc-parallel-summary").textContent =
      finished
        ? unfinished.length ? `${unfinished.length} unfinished ${unfinished.length === 1 ? "task kept" : "tasks kept"} in plan history` : "All steps complete"
        : ready.length > 1
        ? `Parallel candidates: ${ready.join(", ")}`
        : ready.length
          ? `Available first: ${ready[0]}`
          : !unfinished.length
            ? "All steps complete"
            : unfinished.some((s) => reviewReason(s))
              ? "Review flagged steps to unlock work"
              : "Resolve blockers before starting work";
  }
  // Note input can change dependent availability. Update those rows in place so
  // native details, editor focus, composition and text selection stay intact.
  function updateAvailability() {
    updateParallelSummary();
    for (const row of list.querySelectorAll<HTMLElement>("[data-step]")) {
      const step = byId(row.dataset.step!)!;
      const reason = step.status !== "completed" && blockReason(step);
      const check = row.querySelector<HTMLInputElement>(".pc-check input");
      row.classList.toggle("pc-selected", selected.has(step.id));
      if (check) {
        check.checked = selected.has(step.id);
        check.disabled = !!sending || !!reason;
        if (reason) check.setAttribute("aria-describedby", root.id + "-condition-" + step.id);
        else check.removeAttribute("aria-describedby");
      }
      const copy = q(".pc-copy", row);
      copy.querySelector(".pc-condition")?.remove();
      if (reason) {
        const condition = el("span", "pc-condition", reason === "Needs review" ? reviewReason(step) : reason);
        condition.id = root.id + "-condition-" + step.id;
        copy.append(condition);
      }
      const meta = q(".pc-step-meta", row);
      meta.querySelector(".pc-review-label")?.remove();
      if (step.status !== "completed" && reviewReason(step))
        meta.append(el("span", "pc-review-label", "Needs review"));
      const context = q(".pc-row-context", row);
      context.querySelectorAll(".pc-row-action").forEach(action => action.remove());
      planningActions(context, step);
    }
  }
  function render() {
    q(".pc-heading").textContent = base.title;
    const done = draft.filter((s) => s.status === "completed").length;
    q(".pc-progress").textContent = done
      ? `${done} of ${draft.length} complete`
      : `${draft.length} steps`;
    if (finished)
      q(".pc-kind").textContent = config.preview ? "Interactive demo · finished plan" : "Finished plan";
    else if (config.preview)
      q(".pc-kind").textContent = "Interactive demo · sample plan";
    updateParallelSummary();
    updateActions();
    const afterSelect = q<HTMLSelectElement>(".pc-review-after"),
      previousAfter = afterSelect.value;
    afterSelect.replaceChildren();
    for (const step of draft.filter((s) => !isReview(s))) {
      const option = el(
        "option",
        "",
        `#${stepNumber(step.id)} ${shortLabel(step)}`,
      );
      option.value = step.id;
      afterSelect.append(option);
    }
    afterSelect.value =
      byId(previousAfter) && !isReview(byId(previousAfter))
        ? previousAfter
        : draft.filter((s) => !isReview(s)).at(-1)?.id || "";
    const last = removed[removed.length - 1];
    q(".pc-undo-line").hidden = !last;
    q(".pc-undo-label").textContent = last
      ? `Removed “${last.step.title}”`
      : "";
    q<HTMLButtonElement>(".pc-undo").disabled = draft.length >= 30 || !!sending;
    list.replaceChildren();
    if (!draft.length)
      list.append(
        el("li", "pc-empty", "No steps yet. Add one below or undo a removal."),
      );
    for (const step of draft) {
      const original = base.steps.find((s) => s.id === step.id),
        isOpen = expanded.has(step.id),
        isDone = step.status === "completed";
      const row = el(
        "li",
        "pc-row" +
          (isReview(step) ? " pc-review-step" : "") +
          (isDone ? " pc-done" : "") +
          (selected.has(step.id) ? " pc-selected" : ""),
      );
      row.dataset.step = step.id;
      const top = el("div", "pc-row-top");
      if (canReorder(step)) {
        const handle = btn("", "pc-drag", () => {});
        handle.id = root.id + "-drag-" + step.id;
        handle.setAttribute("aria-label", "Reorder: " + step.title);
        handle.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
        handle.dataset.tooltip = "Drag to reorder. Use ↑ or ↓ when focused.";
        handle.disabled = !!sending || draft.length < 2;
        handle.append(icon("grip-vertical"));
        handle.addEventListener("keydown", (event) => {
          if (dragging) return;
          if (["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            moveOne(step.id, event.key === "ArrowUp" ? -1 : 1);
          }
        });
        handle.addEventListener("pointerdown", (event) => {
          if (
            handle.disabled ||
            !event.isPrimary ||
            event.button !== 0 ||
            !canReorder(step)
          )
            return;
          event.preventDefault();
          dragging = step.id;
          dragPointer = {
            id: event.pointerId,
            handle,
            x: event.clientX,
            y: event.clientY,
            started: false,
          };
          interacted = true;
          handle.focus({ preventScroll: true });
          handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener("pointermove", updateDrop);
        handle.addEventListener("pointerup", (event) => {
          if (!dragging || event.pointerId !== dragPointer?.id) return;
          event.preventDefault();
          const id = dragging,
            target = dropTarget;
          endDrag();
          if (target?.steps) commitOrder(id, target.steps);
          else if (target?.error) notify(target.error);
        });
        handle.addEventListener("pointercancel", endDrag);
        handle.addEventListener("lostpointercapture", endDrag);
        top.append(handle);
      }
      if (isDone) {
        const done = el("span", "pc-completed-icon");
        done.append(icon("circle-check"));
        done.setAttribute("aria-label", "Completed");
        top.append(done);
      } else {
        const label = el("label", "pc-check cursor-interaction"),
          check = el("input");
        check.type = "checkbox";
        check.id = root.id + "-select-" + step.id;
        check.checked = selected.has(step.id);
        check.disabled = !!sending || !!blockReason(step);
        check.setAttribute(
          "aria-label",
          (isReview(step) ? "Select review: " : "Select for implementation: ") +
            step.title,
        );
        if (blockReason(step))
          check.setAttribute(
            "aria-describedby",
            root.id + "-condition-" + step.id,
          );
        check.addEventListener("change", () =>
          selectStep(step.id, check.checked, "select-" + step.id),
        );
        label.append(check);
        top.append(label);
      }
      const toggle = btn("", "pc-expand", () => {
        if (isOpen) expanded.delete(step.id);
        else expanded.add(step.id);
        menu = null;
        save();
        render();
        focus("expand-" + step.id);
      });
      toggle.id = root.id + "-expand-" + step.id;
      toggle.setAttribute("aria-expanded", String(isOpen));
      toggle.setAttribute("aria-controls", root.id + "-details-" + step.id);
      toggle.setAttribute(
        "aria-label",
        (isOpen ? "Collapse" : "Expand") + " details: " + step.title,
      );
      const copy = el("span", "pc-copy");
      copy.append(
        el("span", "pc-title", `#${stepNumber(step.id)} ${step.title}`),
      );
      const meta = el("span", "pc-step-meta");
      if (isReview(step)) {
        const type = el("span", "pc-review-type");
        type.append(
          icon("shield-check"),
          el("span", "", "Review · fresh task"),
        );
        meta.append(type);
      } else meta.append(el("span", "pc-complexity", complexityLabel(step)));
      if (!isDone && reviewReason(step))
        meta.append(el("span", "pc-review-label", "Needs review"));
      if (isDone)
        meta.append(
          el(
            "span",
            "",
            step.completion_source === "user"
              ? "Marked done by you"
              : "Complete",
          ),
        );
      else if (step.status === "in_progress")
        meta.append(el("span", "", "In progress"));
      else if (!original) meta.append(el("span", "", "New step"));
      const noteCount =
        step.comments.length + (notes.get(step.id)?.text.trim() ? 1 : 0);
      if (noteCount) {
        const count = el("span", "pc-note-count");
        count.append(icon("message-square"), el("span", "", String(noteCount)));
        count.setAttribute("aria-label", `${noteCount} notes`);
        meta.append(count);
      }
      if (meta.childNodes.length) copy.append(meta);
      const reason = !isDone && blockReason(step);
      if (reason) {
        const condition = el(
          "span",
          "pc-condition",
          reason === "Needs review" ? reviewReason(step) : reason,
        );
        condition.id = root.id + "-condition-" + step.id;
        copy.append(condition);
      }
      const arrow = el("span", "pc-chevron");
      arrow.append(icon(isOpen ? "chevron-up" : "chevron-down"));
      toggle.append(copy, arrow);
      top.append(toggle);
      const wrap = el("div", "pc-menu-wrap"),
        more = btn("", "pc-more", () => {
          menu = menu === step.id ? null : step.id;
          render();
          focus(menu ? "menu-first-" + step.id : "more-" + step.id);
        });
      more.id = root.id + "-more-" + step.id;
      more.setAttribute("aria-label", "Step actions: " + step.title);
      more.setAttribute("aria-expanded", String(menu === step.id));
      more.setAttribute("aria-controls", root.id + "-menu-" + step.id);
      more.append(icon("ellipsis"));
      wrap.append(more);
      more.disabled = !!sending;
      top.append(wrap);
      row.append(top);
      if (menu === step.id) {
        const actions = el("div", "pc-menu");
        actions.id = root.id + "-menu-" + step.id;
        actions.setAttribute("role", "group");
        actions.setAttribute(
          "aria-label",
          `Actions for #${stepNumber(step.id)} ${step.title}`,
        );
        const heading = el("div", "pc-menu-heading"),
          close = btn("", "pc-quiet", () => {
            menu = null;
            render();
            focus("more-" + step.id);
          });
        close.append(icon("x"));
        close.setAttribute("aria-label", "Close step actions");
        heading.append(
          el("span", "", `Actions for #${stepNumber(step.id)} ${step.title}`),
          close,
        );
        actions.append(heading);
        const buttons = el("div", "pc-menu-buttons");
        if (canReorder(step)) {
          const index = draft.indexOf(step);
          for (const [label, direction] of [
            ["Move earlier", -1],
            ["Move later", 1],
          ] as const) {
            const move = btn(label, "", () => moveOne(step.id, direction));
            move.disabled = !!sending || !draft[index + direction];
            buttons.append(move);
          }
        }
        if (!isReview(step)) {
          const insert = btn("Add review after this", "", () =>
            insertReview(step.id),
          );
          insert.prepend(icon("shield-check"));
          insert.disabled = draft.length >= 30;
          buttons.append(insert);
        }
        const status = btn(
          isDone ? "Mark as pending" : "Mark as done",
          "",
          () => {
            menu = null;
            if (
              mutate(() => {
                step.status = isDone ? "pending" : "completed";
                step.completion_source = isDone ? null : "user";
              })
            )
              focus("more-" + step.id);
          },
        );
        status.id = root.id + "-menu-first-" + step.id;
        const dependents = draft.filter((s) =>
          executionDeps(s).includes(step.id),
        );
        const historyStatus =
          original && original.status !== "pending"
            ? original.status
            : step.status;
        const remove = btn("Remove planned step", "pc-remove", () => {
          if (historyStatus !== "pending") return;
          const index = draft.findIndex((s) => s.id === step.id),
            wasSelected = selected.has(step.id);
          menu = null;
          if (mutate(() => draft.splice(index, 1))) {
            removed.push({ step, index, selected: wasSelected });
            render();
            q<HTMLButtonElement>(".pc-undo").focus();
          }
        });
        remove.prepend(icon("trash-2"));
        remove.disabled = dependents.length > 0 || historyStatus !== "pending";
        buttons.append(status, remove);
        actions.append(buttons);
        actions.append(
          el(
            "p",
            "",
            historyStatus === "completed"
              ? "Completed work is kept in plan history."
              : historyStatus === "in_progress"
                ? "Active work is kept in the plan."
                : "Removal deletes only this planned step. It does not revert code.",
          ),
        );
        if (dependents.length) {
          const affected = el("div", "pc-links");
          affected.append(el("span", "pc-label", "Required by:"));
          for (const dependent of dependents)
            affected.append(
              btn(
                `#${stepNumber(dependent.id)} ${dependent.title}`,
                "pc-step-link",
                () => {
                  menu = null;
                  openStep(dependent.id);
                },
              ),
            );
          actions.append(affected);
          const replan = btn("Replan dependencies", "pc-row-action", () =>
            submit("replan", [step.id]),
          );
          replan.disabled = !!sending;
          actions.append(replan);
        }
        row.append(actions);
      }
      const context = el("div", "pc-row-context");
      if (step.depends_on?.length) {
        const links = el("span", "pc-links");
        links.append(el("span", "", isReview(step) ? "Inspects" : "After"));
        for (const id of step.depends_on) {
          const dep = byId(id);
          if (!dep) continue;
          const link = btn(
            `#${stepNumber(id)} ${shortLabel(dep)}`,
            "pc-step-link",
            () => openStep(id),
          );
          link.setAttribute("aria-label", "Show prerequisite: " + dep.title);
          links.append(link);
        }
        context.append(links);
      } else context.append(el("span", "", "No prerequisites"));
      if (isReview(step) && step.run_after) {
        const after = byId(step.run_after);
        context.append(
          el(
            "span",
            "",
            `Runs after #${stepNumber(step.run_after)} ${after ? shortLabel(after) : step.run_after}`,
          ),
        );
      }
      planningActions(context, step);
      row.append(context);
      const details = el("div", "pc-details");
      details.id = root.id + "-details-" + step.id;
      details.hidden = !isOpen;
      if (isOpen) {
        let extra: HTMLElement & { open?: boolean } = details;
        if (isReview(step)) {
          details.append(el("span", "pc-label", "Review checks"));
          const checks = el("ul", "pc-checks");
          for (const check of step.checks || [])
            checks.append(el("li", "", check));
          details.append(checks);
          extra = el("details", "pc-settings");
          extra.open = settings.has(step.id);
          extra.append(
            el("summary", "cursor-interaction", "Context & settings"),
          );
          extra.addEventListener("toggle", () => {
            if (!extra.isConnected) return;
            const changed = extra.open !== settings.has(step.id);
            if (extra.open) settings.add(step.id);
            else settings.delete(step.id);
            if (changed) save();
          });
          details.append(extra);
        }
        if (step.description)
          extra.append(el("p", "pc-description", step.description));
        if (isReview(step)) {
          if (canReorder(step)) {
            const controls = el("div", "pc-review-controls"),
              position = el("label", "", "Run after"),
              select = el("select");
            select.setAttribute(
              "aria-label",
              "Run review after: " + step.title,
            );
            const index = draft.indexOf(step),
              lastTarget = Math.max(
                ...step.depends_on.map((id) =>
                  draft.findIndex((s) => s.id === id),
                ),
              );
            for (const [i, other] of draft.entries())
              if (other.id !== step.id) {
                const cycle = dependsOn(other.id, step.id),
                  disabled = i < lastTarget || cycle,
                  option = el(
                    "option",
                    "",
                    `#${i + 1} ${shortLabel(other)}${disabled ? " — " + (cycle ? "depends on this review" : "before inspected work") : ""}`,
                  );
                option.value = other.id;
                option.disabled = disabled;
                select.append(option);
              }
            select.value = step.run_after || draft[index - 1]?.id;
            select.disabled = !!sending;
            select.addEventListener("change", () => {
              const after = select.value;
              mutate(() => {
                step.run_after = after;
                draft.splice(draft.indexOf(step), 1);
                draft.splice(
                  draft.findIndex((s) => s.id === after) + 1,
                  0,
                  step,
                );
              });
            });
            position.append(select);
            controls.append(position);
            controls.append(
              el(
                "p",
                "pc-label",
                "Changes timing only. The inspected steps stay the same.",
              ),
            );
            const scope = el("details");
            scope.append(
              el(
                "summary",
                "cursor-interaction",
                `What to inspect · ${step.depends_on.length} ${step.depends_on.length === 1 ? "step" : "steps"}`,
              ),
            );
            for (const other of draft
              .slice(0, index)
              .filter((s) => !isReview(s))) {
              const label = el("label", "cursor-interaction"),
                check = el("input");
              check.type = "checkbox";
              check.checked = step.depends_on.includes(other.id);
              check.disabled =
                !!sending || (check.checked && step.depends_on.length === 1);
              check.setAttribute(
                "aria-label",
                "Include in review: " + other.title,
              );
              check.addEventListener("change", () => {
                mutate(() => {
                  step.depends_on = check.checked
                    ? [...step.depends_on, other.id]
                    : step.depends_on.filter((id) => id !== other.id);
                });
                const current = list.querySelector<HTMLDetailsElement>(
                  `[data-step="${step.id}"] .pc-review-controls details`,
                );
                if (current) current.open = true;
              });
              label.append(
                check,
                el("span", "", `#${stepNumber(other.id)} ${other.title}`),
              );
              scope.append(label);
            }
            controls.append(scope);
            extra.append(controls);
          } else if (step.status === "pending") {
            extra.append(
              el(
                "p",
                "pc-label",
                "Save the reopened review before changing its timing or scope.",
              ),
            );
          }
          const inherited = el("div", "pc-inherited");
          inherited.append(
            el("span", "pc-label", "Reviewer context · included automatically"),
          );
          for (const id of step.depends_on) {
            const source = byId(id);
            if (!source) continue;
            inherited.append(el("p", "", `#${stepNumber(id)} ${source.title}`));
            if (source.description)
              inherited.append(el("p", "", source.description));
            if (source.done_when)
              inherited.append(el("p", "", "Acceptance: " + source.done_when));
            for (const note of source.comments || []) {
              inherited.append(el("p", "", "Note: " + note.text));
              if (note.response)
                inherited.append(el("p", "", "Response: " + note.response));
            }
            if (notes.get(id)?.text.trim())
              inherited.append(
                el("p", "", "Draft note: " + notes.get(id)!.text.trim()),
              );
          }
          extra.append(inherited);
        } else if (step.depends_on?.length) {
          details.append(el("span", "pc-label", "Prerequisites"));
          const deps = el("ul", "pc-dependencies");
          for (const id of step.depends_on) {
            const dep = byId(id);
            deps.append(
              el(
                "li",
                "",
                `${dep?.title || id} · ${dep?.status === "completed" ? "complete" : selected.has(id) ? "selected" : "not selected"}`,
              ),
            );
          }
          details.append(deps);
        }
        if (step.complexity_reason && !isReview(step))
          details.append(
            el("p", "pc-description", "Complexity: " + step.complexity_reason),
          );
        if (Number.isInteger(step.estimated_files))
          details.append(
            el(
              "p",
              "pc-condition",
              `Estimated change footprint: ~${step.estimated_files} files.`,
            ),
          );
        if (step.estimate_note)
          details.append(el("p", "pc-condition", step.estimate_note));
        if (step.progress_note)
          details.append(
            el("p", "pc-description", "Latest result: " + step.progress_note),
          );
        if (!isDone && broad(step))
          details.append(
            el(
              "p",
              "pc-condition",
              step.scope_warning ||
                "This step combines several outcomes; use Split step to make them independently verifiable.",
            ),
          );
        if (step.done_when) {
          const criterion = el("div", "pc-criterion");
          criterion.append(
            el("span", "pc-label", "Done when"),
            el("span", "", step.done_when),
          );
          extra.append(criterion);
        }
        for (const note of step.comments) {
          const box = el("div", "pc-note"),
            head = el("div", "pc-note-head"),
            saved = (original?.comments || []).some((c) => c.id === note.id);
          head.append(
            el(
              "span",
              "",
              !saved
                ? "Your note · draft"
                : note.state === "acknowledged"
                  ? "Addressed"
                  : "Your note",
            ),
          );
          const remove = btn("", "pc-quiet", () =>
            mutate(() => {
              step.comments = step.comments.filter((c) => c.id !== note.id);
            }),
          );
          remove.disabled = !!sending;
          remove.setAttribute("aria-label", "Remove note: " + note.text);
          remove.append(icon("x"));
          head.append(remove);
          box.append(head, el("p", "", note.text));
          if (note.response)
            box.append(el("p", "pc-reply", "Codex: " + note.response));
          extra.append(box);
        }
        const editor = el("div", "pc-editor"),
          label = el(
            "label",
            "",
            isReview(step)
              ? "Additional notes for reviewer"
              : "Notes for Codex",
          ),
          text = el("textarea");
        text.id = root.id + "-note-" + step.id;
        label.htmlFor = text.id;
        text.rows = 2;
        text.maxLength = 1000;
        text.placeholder = "Add a constraint, question, or change…";
        text.setAttribute("aria-label", "Note for: " + step.title);
        text.value = notes.get(step.id)?.text || "";
        text.disabled = !!sending;
        const shortcut = el(
          "span",
          "pc-label",
          "Enter saves edits · Command+Enter adds a line",
        );
        shortcut.id = text.id + "-shortcut";
        text.setAttribute("aria-describedby", shortcut.id);
        text.setAttribute("aria-keyshortcuts", "Enter Meta+Enter");
        text.addEventListener("keydown", (event) => {
          if (
            event.key !== "Enter" ||
            event.isComposing ||
            event.keyCode === 229
          )
            return;
          if (event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            const { selectionStart: start, selectionEnd: end } = text;
            if (text.value.length - (end - start) >= text.maxLength) return;
            text.setRangeText("\n", start, end, "end");
            text.dispatchEvent(new Event("input", { bubbles: true }));
          } else if (!event.shiftKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) void submit("edit");
          }
        });
        text.addEventListener("input", () => {
          const previous = notes.get(step.id);
          const previousReasons = draft.map((s) => reviewReason(s));
          if (step.comments.length >= 20 && text.value.trim()) {
            text.value = previous?.text || "";
            notify("This step already has twenty notes.");
            return;
          }
          notes.set(step.id, { id: previous?.id || uid(), text: text.value });
          if (!withinLimit()) {
            if (previous) notes.set(step.id, previous);
            else notes.delete(step.id);
            text.value = previous?.text || "";
            notify("Save your existing edits before adding more.");
            return;
          }
          selected = new Set(selection());
          changed();
          updateActions();
          if (draft.some((s, index) => reviewReason(s) !== previousReasons[index]))
            updateAvailability();
        });
        editor.append(label, text, shortcut);
        extra.append(editor);
      }
      row.append(details);
      list.append(row);
    }
    if (finished) {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("button,input,textarea,select"))
        if (!control.matches(".pc-expand,.pc-step-link,.pc-lifecycle")) control.disabled = true;
    }
    if (globalThis.lucide)
      globalThis.lucide.createIcons({ attrs: { width: 16, height: 16 } });
  }
  q<HTMLButtonElement>(".pc-select-all").addEventListener("click", () => {
    const available = availableSelection();
    selected = selection().length === available.size ? new Set() : available;
    requestIds.implement = null;
    notify("");
    save();
    render();
    q<HTMLButtonElement>(".pc-select-all").focus();
  });
  q<HTMLButtonElement>(".pc-undo").addEventListener("click", () => {
    if (!removed.length || draft.length >= 30) return;
    const entry = removed[removed.length - 1];
    if (
      mutate(() => {
        const steps = [...draft, entry.step],
          preferred = Math.min(entry.index, draft.length),
          positions = Array.from(
            { length: steps.length },
            (_, index) => index,
          ).sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
        let failure: unknown;
        for (const index of positions) {
          const order = draft.map((step) => step.id);
          order.splice(index, 0, entry.step.id);
          try {
            draft = reorderPendingSteps(steps, order, base.steps);
            return;
          } catch (error) {
            failure = error;
          }
        }
        throw failure;
      })
    ) {
      removed.pop();
      if (entry.selected) selected.add(entry.step.id);
      save();
      render();
      focus("more-" + entry.step.id);
    }
  });
  function updateAddType() {
    const review = q<HTMLSelectElement>(".pc-add-type").value === "review";
    q(".pc-add").hidden = review;
    q(".pc-review-insert").hidden = !review;
  }
  q<HTMLButtonElement>(".pc-add-toggle").addEventListener("click", () => {
    const form = q(".pc-composer");
    form.hidden = !form.hidden;
    updateAddType();
    q<HTMLButtonElement>(".pc-add-toggle").setAttribute(
      "aria-expanded",
      String(!form.hidden),
    );
    if (!form.hidden) q<HTMLSelectElement>(".pc-add-type").focus();
  });
  q<HTMLSelectElement>(".pc-add-type").addEventListener(
    "change",
    updateAddType,
  );
  function insertReview(after: string) {
    if (sending || draft.length >= 30 || !byId(after) || isReview(byId(after)))
      return;
    const step: UiStep = {
      id: uid(),
      kind: "review",
      title: "Review changes in a fresh Codex task",
      description:
        "A fresh Codex task checks the chosen work against its requirements and reports findings here.",
      done_when:
        "Every required check has evidence for the exact code snapshot and no blocking findings remain.",
      depends_on: [after],
      run_after: after,
      checks: clone(defaultChecks),
      status: "pending",
      comments: [],
    };
    menu = null;
    if (
      mutate(() =>
        draft.splice(draft.findIndex((s) => s.id === after) + 1, 0, step),
      )
    ) {
      expanded.add(step.id);
      q(".pc-composer").hidden = true;
      q<HTMLButtonElement>(".pc-add-toggle").setAttribute(
        "aria-expanded",
        "false",
      );
      save();
      render();
      focus("expand-" + step.id);
    }
  }
  q<HTMLButtonElement>(".pc-insert-review").addEventListener("click", () =>
    insertReview(q<HTMLSelectElement>(".pc-review-after").value),
  );
  function addStep() {
    if (sending) return;
    const form = q(".pc-add"),
      title = q<HTMLInputElement>("input", form),
      description = q<HTMLTextAreaElement>("textarea", form);
    if (!title.value.trim()) {
      title.reportValidity();
      return;
    }
    if (draft.length >= 30) {
      notify("This proof of concept supports up to thirty steps.");
      return;
    }
    const step: UiStep = {
      id: uid(),
      title: title.value.trim(),
      description: description.value.trim(),
      done_when: "",
      status: "pending",
      comments: [],
    };
    if (mutate(() => draft.push(step))) {
      title.value = "";
      description.value = "";
      q(".pc-composer").hidden = true;
      q<HTMLDetailsElement>("details", form).open = false;
      q<HTMLButtonElement>(".pc-add-toggle").setAttribute(
        "aria-expanded",
        "false",
      );
      focus("select-" + step.id);
    }
  }
  q<HTMLButtonElement>(".pc-add-button").addEventListener("click", addStep);
  q<HTMLInputElement>(".pc-add input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addStep();
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dragging) {
      event.preventDefault();
      endDrag();
      notify("");
      return;
    }
    if (event.key === "Escape" && menu) {
      const id = menu;
      menu = null;
      render();
      focus("more-" + id);
    }
  });
  document.addEventListener("click", (event) => {
    if (
      menu &&
      !(
        event.target instanceof Element &&
        event.target.closest(".pc-menu-wrap,.pc-menu")
      )
    ) {
      const id = menu;
      menu = null;
      document.getElementById(root.id + "-menu-" + id)?.remove();
      document
        .getElementById(root.id + "-more-" + id)
        ?.setAttribute("aria-expanded", "false");
    }
  });
  async function submit(intent: Intent, targets: string[] = []) {
    const lifecycleAction = intent === "finish" || intent === "reopen";
    if (finished && intent !== "reopen") return;
    const ops = intent === "reopen" ? [] : operations(),
      ids = selection(),
      planning = ["review", "decompose", "replan"].includes(intent);
    if (
      sending ||
      (!lifecycleAction && (intent === "edit"
        ? !ops.some((op) => op.type !== "reorder_steps")
        : planning
          ? !targets.length
          : !ids.length))
    )
      return;
    try {
      replay(ops);
    } catch (error) {
      notify(
        `Cannot submit: ${(error as Error).message}. Your edits are preserved.`,
      );
      return;
    }
    if (config.preview) {
      notify(
        lifecycleAction
          ? `Preview: Codex would ${intent === "finish" ? "finish this plan and stop automatic cards, keeping task statuses" : "reopen this plan without authorizing work"}. No request was sent.`
          : intent === "implement"
          ? `Preview: ${runLabel(ids)}. Review steps open fresh Codex tasks; unselected steps stay for later. No request was sent.`
          : planning
            ? `Preview: Codex would ${intent === "replan" ? "replan dependencies for" : intent === "decompose" ? "break down" : "review"} ${targets.length} ${targets.length === 1 ? "step" : "steps"} without starting implementation. No request was sent.`
            : "Preview: edits are kept here. No request was sent.",
      );
      return;
    }
    if (typeof window.openai?.sendFollowUpMessage !== "function") {
      notify(
        "Open this card inside Codex to submit. Your edits and selection are preserved.",
      );
      return;
    }
    const key = planning ? intent + ":" + targets.join(",") : intent;
    requestIds[key] = requestIds[key] || uid();
    const request: ChangeRequest = {
      plan_id: base.plan_id,
      base_revision: base.revision,
      request_id: requestIds[key]!,
      intent,
      operations: ops,
    };
    if (intent === "implement") request.selected_step_ids = ids;
    if (planning) request.target_step_ids = targets;
    const instruction =
      intent === "finish"
        ? "Apply the included draft edits and finish this plan through the helper. Preserve every task's actual status and notes; unfinished tasks remain unfinished. Clear implementation approval. Confirm briefly in text and do not render another card. Keep this plan quiet on future follow-ups unless the user explicitly asks to show or reopen it."
        : intent === "reopen"
          ? "Reopen this plan through the helper and show the current card for selection. Preserve task history. Reopening does not approve or resume implementation; wait for a fresh work selection."
          : intent === "implement"
        ? "Apply the included plan edits, then implement ONLY the selected_step_ids listed below in prerequisite order. Keep unselected steps for later. Selection is not completion. After meaningful changes, revalidate affected unfinished steps and preserve completed history. Do not silently expand scope. If the active collaboration mode prohibits implementation, retain this selected scope and explain the mode constraint. Do not execute the same request twice. Refresh the card with observed progress afterward."
        : intent === "decompose"
          ? "Apply the included edits, then break ONLY the target_step_ids into smaller verifiable steps with explicit dependencies and grounded effort estimates. Preserve completed history and unrelated steps. Rewire downstream dependencies. New child steps are not authorized for implementation. Show the revised plan for selection; this request does not start implementation."
          : intent === "review"
            ? "Apply the included edits, then inspect current code and review the target_step_ids and their prerequisites. Update assumptions, dependencies, and estimates as needed; clear freshness warnings only with evidence. Preserve completed history. Show the revised plan; this request does not start implementation."
            : "Revise the plan and acknowledge notes; this request does not start implementation. Refresh the interactive card afterward.";
    const reviewInstruction =
      intent === "implement"
        ? ' Steps with kind="review" are independent reviews: export their review brief including covered step descriptions, acceptance criteria, and notes, and create a fresh Codex task with that brief and the scoped code snapshot; follow references/review-checks.md. Honor run_after as timing and depends_on as inspected scope. Follow list order among ready selected steps. Review selection does not authorize fixes.'
        : intent === "replan"
          ? " Replan dependencies of the target_step_ids so a later removal can be considered. Identify every dependent by name, including run_after references and review coverage. Rewire only when the actual requirements support it; otherwise explain the concrete decision needed. Preserve the target, completed history, and active work. Do not delete steps, revert code, or start implementation. Clear affected freshness warnings only after checking the revised plan."
          : "";
    const prompt =
      "Use $plan-companion. Read the skill at " +
      config.skill_path +
      ".\nPlan file: " +
      config.plan_path +
      "\nAdapt explanations and necessary questions to the user’s demonstrated familiarity with this task. Short messages alone do not imply low expertise. For unfamiliar users, clarify functional goals and explain architectural tradeoffs in plain language; do not repeat resolved questions.\n" +
      instruction +
      reviewInstruction +
      "\n\nChange request JSON:\n" +
      JSON.stringify(request, null, 2);
    sending = intent;
    menu = null;
    save();
    render();
    try {
      await window.openai.sendFollowUpMessage({
        prompt,
        title:
          intent === "finish"
            ? "Finish this plan"
            : intent === "reopen"
              ? "Reopen this plan"
              : intent === "implement"
            ? runLabel(ids)
            : intent === "replan"
              ? "Replan dependencies"
              : intent === "decompose"
                ? "Break down the selected steps"
                : intent === "review"
                  ? "Review the affected plan steps"
                  : "Save edits to this task plan",
      });
      notify(
        "Review the send dialog. Codex will confirm the disk save in its reply; your edits and selection stay here.",
      );
    } catch {
      notify(
        "Request not confirmed. Your edits and selection are preserved; you can retry.",
      );
    } finally {
      sending = false;
      render();
    }
  }
  apply.addEventListener("click", () => submit("edit"));
  implement.addEventListener("click", () => submit("implement"));
  lifecycle.addEventListener("click", () => submit(finished ? "reopen" : "finish"));
  q<HTMLButtonElement>(".pc-decompose-selection").addEventListener(
    "click",
    () =>
      submit(
        "decompose",
        selection().filter((id) => broad(byId(id)!)),
      ),
  );
  restore(window.openai?.widgetState);
  render();
  window.addEventListener("openai:set_globals", (event) => {
    const saved = (
      event as CustomEvent<{ globals?: { widgetState?: SavedDraft } }>
    ).detail?.globals?.widgetState;
    if (!sending && !interacted && saved && restore(saved)) render();
  });
})();
