"use strict";
(() => {
  // src/json.ts
  function floatJSON(value) {
    if (!Number.isFinite(value))
      throw new Error(
        "Non-finite numeric metadata is unsupported; source was not changed"
      );
    if (Object.is(value, -0)) return "-0.0";
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16))
      return value.toExponential().replace(
        /e([+-])(\d+)$/,
        (_, sign, digits) => "e" + sign + digits.padStart(2, "0")
      );
    const text = String(value);
    return Number.isInteger(value) ? text + ".0" : text;
  }
  var JsonNumber = class {
    constructor(token) {
      this.token = token;
    }
    toJSON() {
      const raw = JSON.rawJSON;
      if (!raw)
        throw new Error(
          "Lossless numeric metadata requires JSON.rawJSON support"
        );
      return raw(this.token);
    }
  };
  function parseJSON(text) {
    return JSON.parse(
      text,
      (_key, value, context) => {
        if (typeof value !== "number") return value;
        const source = context?.source;
        if (!source)
          throw new Error("Lossless JSON parsing is unavailable in this runtime");
        if (/[.eE]/.test(source)) return new JsonNumber(floatJSON(value));
        if (Number.isSafeInteger(value)) return value === 0 ? 0 : value;
        return new JsonNumber(BigInt(source).toString());
      }
    );
  }

  // src/model.ts
  var STATUSES = ["pending", "in_progress", "completed"];
  var EXECUTION_STATES = ["approved", "paused", "cancelled"];
  function requireValue(condition, message) {
    if (!condition) throw new Error(message);
  }
  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function string(value, name, limit, empty = false) {
    requireValue(
      typeof value === "string" && [...value].length <= limit,
      `Invalid ${name}`
    );
    requireValue(empty || !!value.trim(), `Empty ${name}`);
    return value;
  }
  function identifier(value) {
    requireValue(
      typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value),
      "Invalid ID"
    );
    return value;
  }
  function prerequisites(step) {
    return [
      .../* @__PURE__ */ new Set([
        ...step.depends_on || [],
        ...step.run_after ? [step.run_after] : []
      ])
    ];
  }
  function defaultValue(value, fallback) {
    return value === void 0 ? fallback : value;
  }
  function clone(value) {
    return parseJSON(JSON.stringify(value));
  }
  function canonicalJSON(value) {
    if (value instanceof JsonNumber) return value.token;
    if (value === null) return "null";
    if (typeof value === "string")
      return JSON.stringify(value).replace(
        /[\u007f-\uffff]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
      );
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new Error("Non-finite numeric metadata is unsupported");
      if (Number.isInteger(value)) {
        requireValue(
          Number.isSafeInteger(value),
          "Unsafe numeric metadata must be read from lossless JSON"
        );
        return String(value);
      }
      return floatJSON(value);
    }
    if (typeof value === "boolean") return JSON.stringify(value);
    if (Array.isArray(value))
      return "[" + value.map(canonicalJSON).join(", ") + "]";
    requireValue(record(value), "Expected JSON data");
    return "{" + Object.keys(value).sort().map((k) => canonicalJSON(k) + ": " + canonicalJSON(value[k])).join(", ") + "}";
  }
  function equal(a, b) {
    return canonicalJSON(a) === canonicalJSON(b);
  }
  function validate(value) {
    requireValue(
      record(value) && value.schema_version === 1,
      "Unsupported plan schema"
    );
    const plan = value;
    identifier(plan.plan_id);
    requireValue(
      Number.isSafeInteger(plan.revision) && plan.revision >= 1,
      "Invalid revision"
    );
    string(plan.title, "plan title", 200);
    requireValue(plan.lifecycle === void 0 || ["active", "finished"].includes(plan.lifecycle), "Invalid plan lifecycle");
    const steps = plan.steps;
    requireValue(
      Array.isArray(steps) && steps.length <= 30,
      "A plan supports up to 30 steps"
    );
    const ids = /* @__PURE__ */ new Set(), commentIds = /* @__PURE__ */ new Set();
    for (const step of steps) {
      requireValue(record(step), "Invalid step");
      const sid = identifier(step.id);
      requireValue(!ids.has(sid), "Duplicate step ID");
      ids.add(sid);
      string(step.title, "step title", 200);
      string(defaultValue(step.short_title, ""), "short title", 80, true);
      if (step.milestone !== void 0) string(step.milestone, "milestone", 100, true);
      string(defaultValue(step.description, ""), "description", 4e3, true);
      string(defaultValue(step.done_when, ""), "done_when", 2e3, true);
      requireValue(
        ["implementation", "review"].includes(
          defaultValue(step.kind, "implementation")
        ),
        "Invalid step kind"
      );
      const checks = defaultValue(step.checks, []);
      requireValue(
        Array.isArray(checks) && checks.length <= 12,
        "Invalid review checks"
      );
      for (const check of checks) string(check, "review check", 500);
      if (step.kind === "review") {
        requireValue(checks.length, "A review needs at least one check");
        requireValue(step.depends_on?.length, "A review needs work to review");
        if ("run_after" in step) identifier(step.run_after);
      } else {
        requireValue(!checks.length, "Only review steps have review checks");
        requireValue(
          !("run_after" in step),
          "Only reviews have a run-after constraint"
        );
      }
      requireValue(STATUSES.includes(step.status), "Invalid step status");
      requireValue(
        step.completion_source == null || ["user", "agent"].includes(step.completion_source),
        "Invalid completion source"
      );
      string(defaultValue(step.progress_note, ""), "progress note", 2e3, true);
      string(defaultValue(step.blocked_by, ""), "blocker", 2e3, true);
      requireValue(
        !(step.status === "completed" && step.blocked_by),
        "Completed step cannot remain blocked"
      );
      requireValue(
        ["S", "M", "L", "XL", "unknown"].includes(
          defaultValue(step.size, "unknown")
        ),
        "Invalid effort size"
      );
      requireValue(
        ["low", "moderate", "high", "unknown"].includes(
          defaultValue(step.complexity, "unknown")
        ),
        "Invalid complexity"
      );
      string(
        defaultValue(step.complexity_reason, ""),
        "complexity rationale",
        2e3,
        true
      );
      if (defaultValue(step.complexity, "unknown") !== "unknown")
        string(step.complexity_reason, "complexity rationale", 2e3);
      requireValue(
        step.estimated_files == null || Number.isSafeInteger(step.estimated_files) && step.estimated_files >= 0 && step.estimated_files <= 1e4,
        "Invalid file estimate"
      );
      for (const field of [
        "estimate_note",
        "scope_warning",
        "review_note"
      ])
        string(defaultValue(step[field], ""), field, 2e3, true);
      requireValue(
        ["current", "needs_review"].includes(
          defaultValue(step.review_state, "current")
        ),
        "Invalid review state"
      );
      if (step.review_state === "needs_review") {
        string(step.review_note, "reason for review", 2e3);
        requireValue(
          step.status !== "completed",
          "Reopen a completed step before marking it stale"
        );
      }
      const deps = defaultValue(step.depends_on, []);
      requireValue(
        Array.isArray(deps) && deps.length <= 30,
        "Invalid prerequisites"
      );
      for (const dep of deps) identifier(dep);
      requireValue(
        new Set(deps).size === deps.length && !deps.includes(sid),
        "Duplicate or self prerequisite"
      );
      const comments = defaultValue(step.comments, []);
      requireValue(
        Array.isArray(comments) && comments.length <= 20,
        "Too many comments"
      );
      for (const comment of comments) {
        requireValue(record(comment), "Invalid comment");
        const cid = identifier(comment.id);
        requireValue(!commentIds.has(cid), "Duplicate comment ID");
        commentIds.add(cid);
        string(comment.text, "comment", 1e3);
        requireValue(
          ["pending", "acknowledged"].includes(comment.state),
          "Invalid comment state"
        );
        string(
          defaultValue(comment.response, ""),
          "comment response",
          2e3,
          true
        );
      }
    }
    const graph = new Map(steps.map((s) => [s.id, prerequisites(s)])), visiting = /* @__PURE__ */ new Set(), visited = /* @__PURE__ */ new Set();
    function visit(sid) {
      requireValue(graph.has(sid), `Unknown prerequisite: ${sid}`);
      requireValue(!visiting.has(sid), "Dependency cycle in plan");
      if (visited.has(sid)) return;
      visiting.add(sid);
      for (const dep of graph.get(sid)) visit(dep);
      visiting.delete(sid);
      visited.add(sid);
    }
    for (const sid of graph.keys()) visit(sid);
    const positions = new Map(steps.map((s, i) => [s.id, i])), byId = new Map(steps.map((s) => [s.id, s]));
    for (const step of steps)
      if (step.kind === "review") {
        if (step.run_after)
          requireValue(
            positions.get(step.run_after) < positions.get(step.id),
            "Run-after step must precede the review"
          );
        for (const target of step.depends_on) {
          requireValue(
            byId.get(target).kind !== "review",
            "Review scope must name implementation steps"
          );
          requireValue(
            positions.get(target) < positions.get(step.id),
            "Place a review after all work it covers"
          );
        }
      }
    const receipts = defaultValue(plan.applied_requests, {});
    requireValue(record(receipts), "Invalid request receipts");
    for (const [key, v] of Object.entries(receipts)) {
      identifier(key);
      requireValue(
        typeof v === "string" && /^[0-9a-f]{64}$/.test(v),
        "Invalid receipt"
      );
    }
    if (plan.execution != null) {
      const execution = plan.execution;
      requireValue(record(execution), "Invalid execution scope");
      requireValue(
        Object.hasOwn(receipts, identifier(execution.request_id)),
        "Execution scope needs a recorded request"
      );
      requireValue(
        EXECUTION_STATES.includes(execution.state),
        "Invalid execution state"
      );
      const selected = execution.selected_step_ids;
      requireValue(
        Array.isArray(selected) && selected.length <= 30,
        "Invalid execution selection"
      );
      for (const sid of selected)
        requireValue(
          ids.has(identifier(sid)),
          "Execution refers to an absent step"
        );
      requireValue(
        new Set(selected).size === selected.length,
        "Duplicate execution step"
      );
    }
    requireValue(
      new TextEncoder().encode(canonicalJSON(plan)).length < 25e4,
      "Plan is too large"
    );
    return plan;
  }
  function invalidateDependents(plan, changedIds, reason) {
    const changed = new Set(changedIds), affected = new Set(changed);
    for (let pass = 0; pass < plan.steps.length; pass++)
      for (const s of plan.steps)
        if (prerequisites(s).some((id) => affected.has(id))) affected.add(s.id);
    for (const s of plan.steps)
      if (affected.has(s.id) && !changed.has(s.id) && s.status !== "completed") {
        s.review_state = "needs_review";
        s.review_note = reason;
      }
  }
  function preserveProtectedOrder(original, steps) {
    const fixed = original.filter((s) => s.status !== "pending").map((s) => s.id);
    const ids = new Set(fixed);
    requireValue(
      equal(
        fixed,
        steps.filter((s) => ids.has(s.id)).map((s) => s.id)
      ),
      "Only pending tasks can be reordered; preserve original protected history"
    );
  }
  function validateStepOrder(steps) {
    const positions = new Map(steps.map((s, index) => [s.id, index]));
    const titles = new Map(steps.map((s) => [s.id, s.title]));
    for (const step of steps)
      for (const dep of prerequisites(step))
        requireValue(
          positions.has(dep) && positions.get(dep) < positions.get(step.id),
          `Keep \u201C${step.title}\u201D after \u201C${titles.get(dep) || dep}\u201D`
        );
  }
  function reorderPendingSteps(steps, ids, original = steps) {
    requireValue(
      Array.isArray(ids) && ids.length === steps.length,
      "Order must include every task exactly once"
    );
    ids.forEach(identifier);
    const byId = new Map(steps.map((step) => [step.id, step]));
    requireValue(
      new Set(ids).size === steps.length && ids.every((id) => byId.has(id)),
      "Order must include every task exactly once"
    );
    const protectedIds = new Set(
      steps.filter((step) => step.status !== "pending").map((step) => step.id)
    );
    const fixed = steps.filter((step) => protectedIds.has(step.id)).map((step) => step.id);
    requireValue(
      ids.filter((id) => protectedIds.has(id)).every((id, index) => fixed[index] === id),
      "Only pending tasks can be reordered"
    );
    const reordered = ids.map((id) => byId.get(id));
    preserveProtectedOrder(original, reordered);
    validateStepOrder(reordered);
    return reordered;
  }
  function applyOperations(plan, operations) {
    requireValue(
      Array.isArray(operations) && operations.length <= 100,
      "Expected at most 100 operations"
    );
    const result = clone(plan), original = Object.fromEntries(plan.steps.map((s) => [s.id, s])), changedStatuses = /* @__PURE__ */ new Set();
    const revoke = (sid) => {
      if (result.execution)
        result.execution.selected_step_ids = result.execution.selected_step_ids.filter((id) => id !== sid);
    };
    for (const raw of operations) {
      requireValue(record(raw), "Invalid operation");
      const kind = raw.type, op = raw;
      if (op.type === "reorder_steps") {
        result.steps = reorderPendingSteps(result.steps, op.step_ids, plan.steps);
        continue;
      }
      const sid = identifier(raw.step_id);
      const step = result.steps.find((s) => s.id === sid);
      if (op.type === "add_step") {
        requireValue(!step, "Step ID already exists");
        const added = {
          id: sid,
          title: string(op.title, "step title", 200),
          description: string(
            defaultValue(op.description, ""),
            "description",
            4e3,
            true
          ),
          done_when: string(
            defaultValue(op.done_when, ""),
            "done_when",
            2e3,
            true
          ),
          status: "pending",
          comments: []
        };
        for (const field of [
          "kind",
          "milestone",
          "depends_on",
          "checks",
          "run_after"
        ])
          if (field in op) Object.assign(added, { [field]: clone(op[field]) });
        let index = result.steps.length;
        if ("after_step_id" in op) {
          const after = identifier(op.after_step_id);
          requireValue(
            result.steps.some((s) => s.id === after),
            "Unknown placement target"
          );
          index = result.steps.findIndex((s) => s.id === after) + 1;
          if (added.kind === "review" && !("run_after" in added))
            added.run_after = after;
        }
        result.steps.splice(index, 0, added);
        continue;
      }
      requireValue(step, `Unknown step: ${sid}`);
      if (op.type === "move_review" || op.type === "update_review") {
        requireValue(step.kind === "review", "Expected a review step");
        requireValue(
          step.status === "pending" && (!Object.hasOwn(original, sid) || original[sid].status === "pending"),
          "Only pending reviews can be edited or moved"
        );
        if (op.type === "move_review") {
          const after = identifier(op.after_step_id);
          requireValue(
            after !== sid && result.steps.some((s) => s.id === after),
            "Unknown placement target"
          );
          result.steps.splice(result.steps.indexOf(step), 1);
          result.steps.splice(
            result.steps.findIndex((s) => s.id === after) + 1,
            0,
            step
          );
          step.run_after = after;
          revoke(sid);
        } else {
          requireValue(Array.isArray(op.depends_on), "Invalid review scope");
          for (const target of op.depends_on) identifier(target);
          step.depends_on = clone(op.depends_on);
          step.checks = clone(op.checks);
          revoke(sid);
          invalidateDependents(
            result,
            [sid],
            "Review scope changed. Check this step against the updated plan."
          );
        }
      } else if (op.type === "remove_step") {
        requireValue(
          step.status === "pending" && (Object.hasOwn(original, sid) ? original[sid] : step).status === "pending",
          "Keep completed or active steps in plan history"
        );
        result.steps.splice(result.steps.indexOf(step), 1);
        revoke(sid);
      } else if (op.type === "set_status") {
        requireValue(
          ["pending", "completed"].includes(op.status),
          "Invalid user completion status"
        );
        if (step.status !== op.status) changedStatuses.add(sid);
        step.status = op.status;
        step.completion_source = op.status === "completed" ? "user" : null;
        delete step.blocked_by;
        delete step.progress_note;
        if (step.status === "completed") {
          step.review_state = "current";
          delete step.review_note;
        }
      } else if (op.type === "add_comment") {
        (step.comments ??= []).push({
          id: identifier(op.comment_id),
          text: string(op.text, "comment", 1e3),
          state: "pending"
        });
      } else if (op.type === "remove_comment") {
        const cid = identifier(op.comment_id);
        requireValue(
          step.comments?.some((c) => c.id === cid),
          "Unknown comment"
        );
        step.comments = step.comments.filter((c) => c.id !== cid);
      } else throw new Error(`Unknown operation: ${String(kind)}`);
    }
    validate(result);
    preserveProtectedOrder(plan.steps, result.steps);
    if (operations.some(
      (op) => [
        "reorder_steps",
        "move_review",
        "update_review",
        "add_step",
        "remove_step"
      ].includes(op.type)
    ))
      validateStepOrder(result.steps);
    if (changedStatuses.size)
      invalidateDependents(
        result,
        changedStatuses,
        "A prerequisite's progress changed. Check this step against the current code."
      );
    return result;
  }

  // src/browser.ts
  (() => {
    const root = document.getElementById("__PLAN_ROOT__");
    function q(selector, parent = root) {
      const element = parent.querySelector(selector);
      if (!element) throw Error("Missing card element: " + selector);
      return element;
    }
    const config = parseJSON(q(".pc-data").textContent);
    const finished = config.plan.lifecycle === "finished";
    const { execution, ...view } = config.plan;
    validate(view);
    const base = {
      ...config.plan,
      steps: config.plan.steps.map((step) => ({
        ...step,
        comments: step.comments || []
      }))
    };
    base.steps.forEach((step) => {
      step.comments = step.comments || [];
    });
    const uid = () => globalThis.crypto?.randomUUID?.() || "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    const list = q(".pc-steps"), apply = q(".pc-apply"), implement = q(".pc-implement"), lifecycle = q(".pc-lifecycle"), message = q(".pc-status");
    let draft = clone(base.steps), selected = /* @__PURE__ */ new Set(), expanded = /* @__PURE__ */ new Set(), settings = /* @__PURE__ */ new Set(), milestones = /* @__PURE__ */ Object.create(null), removed = [], notes = /* @__PURE__ */ new Map(), menu = null, sending = false, requestIds = {}, interacted = false;
    let dragging = null;
    let dragPointer = null;
    let dropTarget = null;
    const el = (tag, cls, text) => {
      const item = document.createElement(tag);
      if (cls) item.className = cls;
      if (text !== void 0) item.textContent = text;
      return item;
    };
    const btn = (text, cls, handler) => {
      const item = el("button", cls + " cursor-interaction", text);
      item.type = "button";
      item.addEventListener("click", handler);
      return item;
    };
    const icon = (name) => {
      const item = el("i");
      item.dataset.lucide = name;
      item.setAttribute("aria-hidden", "true");
      return item;
    };
    const focus = (id) => document.getElementById(root.id + "-" + id)?.focus();
    function notify(text) {
      message.textContent = text;
      message.hidden = !text;
    }
    const byId = (id) => draft.find((s) => s.id === id);
    const stepNumber = (id) => draft.findIndex((s) => s.id === id) + 1;
    const shortLabel = (step) => step.short_title || step.title;
    const isReview = (step) => step?.kind === "review";
    const executionDeps = prerequisites;
    function dependsOn(id, target, seen = /* @__PURE__ */ new Set()) {
      if (id === target) return true;
      if (seen.has(id) || !byId(id)) return false;
      seen.add(id);
      return executionDeps(byId(id)).some((dep) => dependsOn(dep, target, seen));
    }
    const defaultChecks = [
      "Verify the intended behavior and acceptance criteria.",
      "Check regressions in surrounding behavior.",
      "Exercise relevant edge cases and failure paths.",
      "Inspect test coverage and independently run relevant checks."
    ];
    function runLabel(ids = selection()) {
      const count = ids.length, reviews = ids.filter((id) => isReview(byId(id))).length;
      return count ? reviews === count ? count === 1 ? "Review implemented code" : `Run ${count} code reviews` : reviews ? `Run ${count} steps` : `Implement ${count} ${count === 1 ? "step" : "steps"}` : draft.some(isReview) ? "Run selected" : "Implement selected";
    }
    function openStep(id) {
      expanded.add(id);
      revealMilestone(id);
      save();
      render();
      const target = document.getElementById(root.id + "-expand-" + id);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    }
    const complexityLabel = (step) => !step.complexity || step.complexity === "unknown" ? "Complexity not assessed" : step.complexity[0].toUpperCase() + step.complexity.slice(1) + " complexity";
    function selectStep(id, checked, focusId) {
      if (checked) selected.add(id);
      else selected.delete(id);
      const before = selected.size;
      selected = new Set(selection());
      requestIds.implement = null;
      notify(
        before > selected.size ? "Dependent steps were also deselected." : ""
      );
      save();
      render();
      focus(focusId);
    }
    function planningActions(container, step) {
      if (step.status === "completed") return;
      if (reviewReason(step)) {
        const targets = relatedReviewTargets(step), label = targets.length <= 2 ? "Review plan: " + targets.map((id) => "#" + stepNumber(id)).join(" & ") : `Review plan: ${targets.length} affected steps`;
        const review = btn(
          label,
          "pc-row-action pc-review-action",
          () => submit("review", targets)
        );
        review.disabled = !!sending;
        container.append(review);
      }
      if (broad(step)) {
        const split = btn(
          "Split step",
          "pc-row-action pc-split-action",
          () => submit("decompose", [step.id])
        );
        split.disabled = !!sending;
        container.append(split);
      }
    }
    function relatedReviewTargets(step) {
      const roots = /* @__PURE__ */ new Set(), visited = /* @__PURE__ */ new Set();
      function collect(s) {
        if (!s || visited.has(s.id) || s.status === "completed") return;
        visited.add(s.id);
        if (s.review_state === "needs_review") roots.add(s.id);
        for (const id of executionDeps(s)) collect(byId(id));
      }
      collect(step);
      if (!roots.size) roots.add(step.id);
      for (let pass = 0; pass < draft.length; pass++)
        for (const s of draft)
          if (s.status !== "completed" && executionDeps(s).some((id) => roots.has(id)))
            roots.add(s.id);
      return draft.filter((s) => roots.has(s.id)).map((s) => s.id);
    }
    const broad = (step) => step.size === "XL" || !!step.scope_warning;
    function reviewReason(step, visited = /* @__PURE__ */ new Set(), memo = /* @__PURE__ */ new Map()) {
      if (memo.has(step.id)) return memo.get(step.id);
      if (step.review_state === "needs_review") {
        const reason = step.review_note?.trim() || "Plan assumptions need review.";
        return reason.length > 160 ? reason.slice(0, 157) + "\u2026" : reason;
      }
      if (visited.has(step.id)) return "Prerequisite cycle needs review.";
      const next = new Set(visited);
      next.add(step.id);
      for (const id of executionDeps(step)) {
        const dep = byId(id), old = base.steps.find((s) => s.id === id);
        if (dep && old && dep.status !== old.status)
          return "Save prerequisite changes and review this step first.";
        if (dep && old && (!equal(dep.comments, old.comments) || notes.get(dep.id)?.text.trim()))
          return "Save prerequisite notes and review this step first.";
        if (dep && reviewReason(dep, next, memo)) {
          memo.set(step.id, "A prerequisite needs review first.");
          return memo.get(step.id);
        }
      }
      memo.set(step.id, "");
      return "";
    }
    function blockReason(step, candidates = selected) {
      if (reviewReason(step)) return "Needs plan review";
      if (step.blocked_by) return "Blocked: " + step.blocked_by;
      const missing = executionDeps(step).filter(
        (id) => byId(id)?.status !== "completed" && !candidates.has(id)
      );
      return missing.length ? "Select first: " + (byId(missing[0])?.title || missing[0]) + (missing.length > 1 ? ` (+${missing.length - 1} more)` : "") : "";
    }
    function availableSelection(candidates = new Set(
      draft.filter((s) => s.status !== "completed").map((s) => s.id)
    )) {
      const result = /* @__PURE__ */ new Set();
      for (let pass = 0; pass < draft.length; pass++)
        for (const step of draft)
          if (step.status !== "completed" && candidates.has(step.id) && !blockReason(step, result))
            result.add(step.id);
      return result;
    }
    function selection() {
      const valid = availableSelection(selected);
      return draft.filter((step) => valid.has(step.id)).map((step) => step.id);
    }
    function operations() {
      const ops = [], statusOps = [];
      for (const old of base.steps)
        if (!draft.some((s) => s.id === old.id))
          ops.push({ type: "remove_step", step_id: old.id });
      for (const [index, step] of draft.entries()) {
        const old = base.steps.find((s) => s.id === step.id);
        if (old && step.status !== old.status)
          statusOps.push({
            type: "set_status",
            step_id: step.id,
            status: step.status
          });
        if (!old) {
          const op = {
            type: "add_step",
            step_id: step.id,
            title: step.title,
            description: step.description || "",
            done_when: step.done_when || ""
          };
          if (step.milestone !== void 0) op.milestone = step.milestone;
          if (isReview(step))
            Object.assign(op, {
              kind: "review",
              depends_on: step.depends_on,
              checks: step.checks,
              run_after: step.run_after,
              after_step_id: draft[index - 1]?.id
            });
          ops.push(op);
        } else if (isReview(step) && canReorder(step)) {
          if (JSON.stringify(step.depends_on) !== JSON.stringify(old.depends_on) || JSON.stringify(step.checks) !== JSON.stringify(old.checks))
            ops.push({
              type: "update_review",
              step_id: step.id,
              depends_on: step.depends_on,
              checks: step.checks
            });
          if (step.run_after !== old.run_after)
            ops.push({
              type: "move_review",
              step_id: step.id,
              after_step_id: step.run_after
            });
        }
        if (!old && step.status !== "pending")
          statusOps.push({
            type: "set_status",
            step_id: step.id,
            status: step.status
          });
        for (const comment of old?.comments || [])
          if (!step.comments.some((c) => c.id === comment.id))
            ops.push({
              type: "remove_comment",
              step_id: step.id,
              comment_id: comment.id
            });
        for (const comment of step.comments)
          if (!(old?.comments || []).some((c) => c.id === comment.id))
            ops.push({
              type: "add_comment",
              step_id: step.id,
              comment_id: comment.id,
              text: comment.text
            });
        const note = notes.get(step.id);
        if (note?.text.trim())
          ops.push({
            type: "add_comment",
            step_id: step.id,
            comment_id: note.id,
            text: note.text.trim()
          });
      }
      const projected = base.steps.map((step) => step.id);
      for (const op of ops) {
        if (op.type === "remove_step" || op.type === "move_review")
          projected.splice(projected.indexOf(op.step_id), 1);
        if (op.type === "add_step" || op.type === "move_review") {
          const index = op.after_step_id ? projected.indexOf(op.after_step_id) + 1 : projected.length;
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
      return ops.length <= 100 && new TextEncoder().encode(JSON.stringify(ops)).length < 1e4;
    }
    function replay(ops) {
      const { execution: execution2, ...publicBase } = base;
      return applyOperations(publicBase, ops).steps.map((step) => ({
        ...step,
        comments: step.comments || []
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
          operations: operations()
        },
        privateContent: {
          expanded: [...expanded],
          settings: [...settings],
          milestones,
          request_ids: requestIds,
          note_editors: [...notes].filter(([id]) => draft.some((s) => s.id === id)).map(([step_id, n]) => ({ step_id, id: n.id }))
        }
      };
      if (new TextEncoder().encode(JSON.stringify(snapshot)).length >= 15e3)
        return;
      try {
        window.openai?.setWidgetState?.(snapshot)?.catch(() => {
        });
      } catch {
      }
    }
    function restoredView() {
      return JSON.stringify({
        draft,
        selected: [...selected].sort(),
        expanded: [...expanded].sort(),
        settings: [...settings].sort(),
        milestones,
        notes: [...notes].sort(([a], [b]) => a.localeCompare(b))
      });
    }
    function restore(saved) {
      const state = saved?.modelContent;
      if (!saved || state?.kind !== "plan-companion" || state.plan_id !== base.plan_id || state.base_revision !== base.revision)
        return false;
      try {
        const previousView = restoredView();
        const savedMilestones = saved.privateContent?.milestones;
        if (savedMilestones && typeof savedMilestones === "object")
          milestones = Object.assign(/* @__PURE__ */ Object.create(null), Object.fromEntries(Object.entries(savedMilestones).filter(([, value]) => typeof value === "boolean")));
        if (finished) {
          expanded = new Set((saved.privateContent?.expanded || []).filter((id) => base.steps.some((step) => step.id === id)));
          const retry = saved.privateContent?.request_ids?.reopen;
          requestIds = typeof retry === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(retry) ? { reopen: retry } : {};
          return restoredView() !== previousView;
        }
        const restored = replay(state.operations), restoredNotes = /* @__PURE__ */ new Map();
        for (const editor of saved.privateContent?.note_editors || []) {
          const step = restored.find((s) => s.id === editor.step_id), note = step?.comments.find((c) => c.id === editor.id);
          if (step && note && !(base.steps.find((s) => s.id === step.id)?.comments || []).some(
            (c) => c.id === note.id
          )) {
            restoredNotes.set(step.id, { id: note.id, text: note.text });
            step.comments = step.comments.filter((c) => c.id !== note.id);
          }
        }
        draft = restored;
        notes = restoredNotes;
        selected = new Set(
          (Array.isArray(state.selected_step_ids) ? state.selected_step_ids : []).filter(
            (id) => draft.some((s) => s.id === id && s.status !== "completed")
          )
        );
        selected = new Set(selection());
        expanded = new Set(
          Array.isArray(saved.privateContent?.expanded) ? saved.privateContent.expanded : []
        );
        settings = new Set(
          Array.isArray(saved.privateContent?.settings) ? saved.privateContent.settings : []
        );
        requestIds = state.ui_version === 3 && saved.privateContent?.request_ids || {};
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
    function mutate(change) {
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
        notify(error.message);
        return false;
      }
      selected = new Set(selection());
      changed();
      render();
      return true;
    }
    function canReorder(step) {
      const original = base.steps.find((old) => old.id === step.id);
      return step.status === "pending" && (!original || original.status === "pending");
    }
    function orderAt(id, target, after) {
      const source = byId(id);
      if (!source || !canReorder(source) || !byId(target))
        throw Error("Only pending tasks can be reordered");
      if (id === target) return draft;
      const order = draft.filter((step) => step.id !== id).map((step) => step.id);
      order.splice(order.indexOf(target) + Number(after), 0, id);
      return reorderPendingSteps(draft, order, base.steps);
    }
    function commitOrder(id, steps) {
      if (sending || steps.every((step, index) => step.id === draft[index].id))
        return;
      if (mutate(() => {
        draft = steps;
        revealMilestone(id);
        menu = null;
      })) {
        focus("drag-" + id);
        notify(`Moved \u201C${byId(id).title}\u201D to #${stepNumber(id)}.`);
      }
    }
    function moveOne(id, direction) {
      const target = draft[draft.findIndex((step) => step.id === id) + direction];
      if (!target) return;
      try {
        commitOrder(id, orderAt(id, target.id, direction > 0));
      } catch (error) {
        notify(error.message);
      }
    }
    function clearDropMarks() {
      list.querySelectorAll(".pc-drop-before,.pc-drop-after,.pc-drop-invalid").forEach(
        (row) => row.classList.remove(
          "pc-drop-before",
          "pc-drop-after",
          "pc-drop-invalid"
        )
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
    function updateDrop(event) {
      if (!dragging || !dragPointer || event.pointerId !== dragPointer.id) return;
      if (!dragPointer.started) {
        if (Math.hypot(
          event.clientX - dragPointer.x,
          event.clientY - dragPointer.y
        ) < 4)
          return;
        dragPointer.started = true;
        dragPointer.handle.closest(".pc-row")?.classList.add("pc-dragging");
      }
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest(".pc-row");
      const step = row?.dataset.step ? byId(row.dataset.step) : void 0;
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
          error: ""
        };
      } catch (error) {
        dropTarget = {
          id: step.id,
          after,
          steps: null,
          error: error.message
        };
      }
      row.classList.add(
        dropTarget.error ? "pc-drop-invalid" : after ? "pc-drop-after" : "pc-drop-before"
      );
      notify(dropTarget.error);
    }
    function milestoneGroups() {
      const groups = [];
      for (const step of draft) {
        const label = step.milestone?.trim() || "Other steps";
        const previous = groups.at(-1);
        if (previous?.label === label) previous.steps.push(step);
        else groups.push({ key: step.id, label, steps: [step] });
      }
      return groups;
    }
    function revealMilestone(id) {
      const group = milestoneGroups().find((g) => g.steps.some((s) => s.id === id));
      if (group) milestones[group.key] = true;
    }
    function milestoneProgress(steps) {
      const done = steps.filter((s) => s.status === "completed").length;
      const blocked = steps.filter((s) => s.status !== "completed" && (s.blocked_by || reviewReason(s))).length;
      const count = steps.filter((s) => selected.has(s.id)).length;
      return `${done}/${steps.length} complete${blocked ? ` \xB7 ${blocked} blocked or need plan review` : ""}${count ? ` \xB7 ${count} selected` : ""}`;
    }
    function suggestedBatch() {
      const ready = draft.filter((s) => s.status !== "completed" && !blockReason(s, /* @__PURE__ */ new Set()));
      const first = ready.find((s) => s.status === "in_progress") || ready[0];
      if (!first) return [];
      if (isReview(first) || broad(first) || first.status === "in_progress") return [first];
      const group = milestoneGroups().find((g) => g.steps.includes(first));
      const remaining = group.steps.slice(group.steps.indexOf(first));
      const reviewIndex = remaining.findIndex(isReview);
      return remaining.slice(0, reviewIndex < 0 ? void 0 : reviewIndex).filter((s) => ready.includes(s) && !broad(s)).slice(0, 3);
    }
    function updateNextBatch() {
      const panel = q(".pc-next");
      panel.replaceChildren();
      panel.hidden = finished || !draft.some((s) => s.status !== "completed");
      if (panel.hidden) return;
      const batch = suggestedBatch();
      panel.append(el("strong", "", batch.length && isReview(batch[0]) ? "Next: review implemented code" : "Next implementation batch"));
      const items = el("ul");
      for (const step of batch) {
        const item = el("li");
        item.append(btn(shortLabel(step), "pc-step-link", () => openStep(step.id)));
        if (step.done_when) item.append(el("p", "", step.done_when));
        items.append(item);
      }
      if (batch.length) panel.append(items);
      panel.append(el("p", "", batch.length ? isReview(batch[0]) ? "The covered work is complete. This reviews the code against its acceptance criteria; fixes require their own selection." : `${batch[0].milestone ? batch[0].milestone + " \xB7 " : ""}Prerequisites are complete. ${batch.length > 1 ? "These steps can start independently. " : ""}Select this suggestion, then adjust the selection or run it below.` : "No work is ready to start. Review flagged plan assumptions or resolve the blockers shown below."));
      const actions = el("div", "pc-next-actions");
      if (batch.length) {
        const select = btn("Select suggested batch", "pc-select-batch", () => {
          selected = new Set(batch.map((s) => s.id));
          for (const group of milestoneGroups())
            if (group.steps.some((s) => selected.has(s.id))) milestones[group.key] = true;
          requestIds.implement = null;
          save();
          render();
          q(".pc-select-batch").focus();
        });
        select.disabled = !!sending;
        actions.append(select);
      }
      const review = btn("Review plan", "pc-review-plan", () => submit("review", draft.filter((s) => s.status !== "completed").map((s) => s.id)));
      review.title = "Assess scope, sequencing, dependencies, and acceptance criteria without implementing or reviewing completed code.";
      review.disabled = !!sending;
      actions.append(review);
      panel.append(actions);
    }
    function updateActions() {
      updateNextBatch();
      const ids = selection(), ops = operations(), available = draft.filter((s) => s.status !== "completed").length;
      q(".pc-selection-summary").textContent = ids.length ? `${ids.length} selected \xB7 ${available - ids.length} left for later` : available ? draft.some(isReview) ? "Choose steps to run" : "Choose steps to implement" : "All steps complete";
      const selectable = availableSelection();
      const all = q(".pc-select-all");
      all.textContent = ids.length && ids.length === selectable.size ? "Clear selection" : selectable.size === available ? "Select all" : "Select available";
      all.disabled = !selectable.size || !!sending;
      const edited = new Set(
        ops.flatMap((op) => op.type === "reorder_steps" ? [] : [op.step_id])
      ).size;
      const hint = q(".pc-interaction-hint");
      hint.hidden = !available;
      hint.textContent = draft.some(canReorder) ? "Drag the grip to reorder pending tasks \xB7 Tick a checkbox to choose work" : "Tick a checkbox to choose work";
      q(".pc-scope").hidden = !edited;
      q(".pc-scope").textContent = edited ? `${edited} ${edited === 1 ? "step has" : "steps have"} unsaved edits` : ids.length ? "Only selected steps will run" : "Nothing selected";
      apply.hidden = !edited;
      apply.disabled = !!sending;
      apply.textContent = sending === "edit" ? "Opening\u2026" : "Save edits";
      q(".pc-add-toggle").disabled = !!sending;
      q(".pc-add-button").disabled = !!sending;
      q(".pc-add-type").disabled = !!sending;
      q('.pc-add-type option[value="review"]').disabled = !draft.some((s) => !isReview(s));
      q(".pc-insert-review").disabled = !!sending || draft.length >= 30 || !draft.some((s) => !isReview(s));
      q(".pc-storage").textContent = config.preview ? "Demo edits stay in this card; they are not written to the plan file." : edited ? "Unsaved draft \xB7 Save edits sends it to Codex for writing to disk." : ops.length ? "Order updated in this card \xB7 included with your next plan action." : `Saved plan \xB7 revision ${base.revision} \xB7 checks and notes kept in ${config.source_name || "the plan file"} and PR notes.`;
      implement.disabled = !!sending || !ids.length;
      implement.textContent = sending === "implement" ? "Opening\u2026" : runLabel(ids);
      const large = ids.filter((id) => broad(byId(id)));
      q(".pc-large-warning").hidden = !large.length;
      q(".pc-decompose-selection").disabled = !!sending;
      if (ops.length && ids.length)
        q(".pc-scope").textContent += " \xB7 included when implementing";
      lifecycle.disabled = !!sending;
      lifecycle.textContent = sending === "finish" || sending === "reopen" ? "Opening\u2026" : finished ? "Reopen plan" : ops.length ? "Save & finish plan" : "Finish plan";
      q(".pc-lifecycle-note").textContent = finished ? "Automatic cards are off. Reopen to continue planning." : "Stops automatic cards; keeps unfinished tasks.";
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
      const unfinished = draft.filter((s) => s.status !== "completed"), ready = unfinished.filter((s) => !blockReason(s, /* @__PURE__ */ new Set())).map((s) => "#" + stepNumber(s.id));
      q(".pc-parallel-summary").textContent = finished ? unfinished.length ? `${unfinished.length} unfinished ${unfinished.length === 1 ? "task kept" : "tasks kept"} in plan history` : "All steps complete" : ready.length > 1 ? `Parallel candidates: ${ready.join(", ")}` : ready.length ? `Available first: ${ready[0]}` : !unfinished.length ? "All steps complete" : unfinished.some((s) => reviewReason(s)) ? "Review flagged steps to unlock work" : "Resolve blockers before starting work";
    }
    function updateAvailability() {
      updateParallelSummary();
      const groups = milestoneGroups();
      list.querySelectorAll(".pc-milestone-progress").forEach((progress, index) => {
        progress.textContent = milestoneProgress(groups[index].steps);
      });
      for (const row of list.querySelectorAll("[data-step]")) {
        const step = byId(row.dataset.step);
        const reason = step.status !== "completed" && blockReason(step);
        const check = row.querySelector(".pc-check input");
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
          const condition = el("span", "pc-condition", reason === "Needs plan review" ? reviewReason(step) : reason);
          condition.id = root.id + "-condition-" + step.id;
          copy.append(condition);
        }
        const meta = q(".pc-step-meta", row);
        meta.querySelector(".pc-review-label")?.remove();
        if (step.status !== "completed" && reviewReason(step))
          meta.append(el("span", "pc-review-label", "Needs plan review"));
        const context = q(".pc-row-context", row);
        context.querySelectorAll(".pc-row-action").forEach((action) => action.remove());
        planningActions(context, step);
      }
    }
    function render() {
      q(".pc-heading").textContent = base.title;
      const done = draft.filter((s) => s.status === "completed").length;
      q(".pc-progress").textContent = done ? `${done} of ${draft.length} complete` : `${draft.length} steps`;
      if (finished)
        q(".pc-kind").textContent = config.preview ? "Interactive demo \xB7 finished plan" : "Finished plan";
      else if (config.preview)
        q(".pc-kind").textContent = "Interactive demo \xB7 sample plan";
      updateParallelSummary();
      updateActions();
      const afterSelect = q(".pc-review-after"), previousAfter = afterSelect.value;
      afterSelect.replaceChildren();
      for (const step of draft.filter((s) => !isReview(s))) {
        const option = el(
          "option",
          "",
          `#${stepNumber(step.id)} ${shortLabel(step)}`
        );
        option.value = step.id;
        afterSelect.append(option);
      }
      afterSelect.value = byId(previousAfter) && !isReview(byId(previousAfter)) ? previousAfter : draft.filter((s) => !isReview(s)).at(-1)?.id || "";
      const last = removed[removed.length - 1];
      q(".pc-undo-line").hidden = !last;
      q(".pc-undo-label").textContent = last ? `Removed \u201C${last.step.title}\u201D` : "";
      q(".pc-undo").disabled = draft.length >= 30 || !!sending;
      list.replaceChildren();
      if (!draft.length)
        list.append(
          el("li", "pc-empty", "No steps yet. Add one below or undo a removal.")
        );
      const grouped = draft.some((s) => s.milestone?.trim());
      const groups = milestoneGroups();
      const active = groups.find((g) => g.steps.some((s) => s.status === "in_progress")) || groups.find((g) => g.steps.some((s) => s.status !== "completed" && !blockReason(s, /* @__PURE__ */ new Set()))) || groups.find((g) => g.steps.some((s) => s.status !== "completed"));
      const destinations = /* @__PURE__ */ new Map();
      if (grouped) for (const group of groups) {
        const wrapper = el("li", "pc-milestone"), section = el("details");
        section.open = milestones[group.key] ?? group === active;
        const summary = el("summary", "cursor-interaction", group.label);
        const progress = el("span", "pc-milestone-progress");
        progress.textContent = milestoneProgress(group.steps);
        summary.append(progress);
        const children = el("ol", "pc-milestone-steps");
        section.append(summary, children);
        section.addEventListener("toggle", () => {
          if (!section.isConnected || section.open === (milestones[group.key] ?? group === active)) return;
          milestones[group.key] = section.open;
          save();
        });
        wrapper.append(section);
        list.append(wrapper);
        for (const step of group.steps) destinations.set(step.id, children);
      }
      for (const step of draft) {
        const original = base.steps.find((s) => s.id === step.id), isOpen = expanded.has(step.id), isDone = step.status === "completed";
        const row = el(
          "li",
          "pc-row" + (isReview(step) ? " pc-review-step" : "") + (isDone ? " pc-done" : "") + (selected.has(step.id) ? " pc-selected" : "")
        );
        row.dataset.step = step.id;
        const top = el("div", "pc-row-top");
        if (canReorder(step)) {
          const handle = btn("", "pc-drag", () => {
          });
          handle.id = root.id + "-drag-" + step.id;
          handle.setAttribute("aria-label", "Reorder: " + step.title);
          handle.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
          handle.dataset.tooltip = "Drag to reorder. Use \u2191 or \u2193 when focused.";
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
            if (handle.disabled || !event.isPrimary || event.button !== 0 || !canReorder(step))
              return;
            event.preventDefault();
            dragging = step.id;
            dragPointer = {
              id: event.pointerId,
              handle,
              x: event.clientX,
              y: event.clientY,
              started: false
            };
            interacted = true;
            handle.focus({ preventScroll: true });
            handle.setPointerCapture(event.pointerId);
          });
          handle.addEventListener("pointermove", updateDrop);
          handle.addEventListener("pointerup", (event) => {
            if (!dragging || event.pointerId !== dragPointer?.id) return;
            event.preventDefault();
            const id = dragging, target = dropTarget;
            endDrag();
            if (target?.steps) commitOrder(id, target.steps);
            else if (target?.error) notify(target.error);
          });
          handle.addEventListener("pointercancel", endDrag);
          handle.addEventListener("lostpointercapture", endDrag);
          top.append(handle);
        }
        if (isDone) {
          const done2 = el("span", "pc-completed-icon");
          done2.append(icon("circle-check"));
          done2.setAttribute("aria-label", "Completed");
          top.append(done2);
        } else {
          const label = el("label", "pc-check cursor-interaction"), check = el("input");
          check.type = "checkbox";
          check.id = root.id + "-select-" + step.id;
          check.checked = selected.has(step.id);
          check.disabled = !!sending || !!blockReason(step);
          check.setAttribute(
            "aria-label",
            (isReview(step) ? "Select review: " : "Select for implementation: ") + step.title
          );
          if (blockReason(step))
            check.setAttribute(
              "aria-describedby",
              root.id + "-condition-" + step.id
            );
          check.addEventListener(
            "change",
            () => selectStep(step.id, check.checked, "select-" + step.id)
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
          (isOpen ? "Collapse" : "Expand") + " details: " + step.title
        );
        const copy = el("span", "pc-copy");
        copy.append(
          el("span", "pc-title", `#${stepNumber(step.id)} ${step.title}`)
        );
        const meta = el("span", "pc-step-meta");
        if (isReview(step)) {
          const type = el("span", "pc-review-type");
          type.append(
            icon("shield-check"),
            el("span", "", "Code review \xB7 fresh task")
          );
          meta.append(type);
        } else meta.append(el("span", "pc-complexity", complexityLabel(step)));
        if (!isDone && reviewReason(step))
          meta.append(el("span", "pc-review-label", "Needs plan review"));
        if (isDone)
          meta.append(
            el(
              "span",
              "",
              step.completion_source === "user" ? "Marked done by you" : "Complete"
            )
          );
        else if (step.status === "in_progress")
          meta.append(el("span", "", "In progress"));
        else if (!original) meta.append(el("span", "", "New step"));
        const noteCount = step.comments.length + (notes.get(step.id)?.text.trim() ? 1 : 0);
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
            reason === "Needs plan review" ? reviewReason(step) : reason
          );
          condition.id = root.id + "-condition-" + step.id;
          copy.append(condition);
        }
        const arrow = el("span", "pc-chevron");
        arrow.append(icon(isOpen ? "chevron-up" : "chevron-down"));
        toggle.append(copy, arrow);
        top.append(toggle);
        const wrap = el("div", "pc-menu-wrap"), more = btn("", "pc-more", () => {
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
            `Actions for #${stepNumber(step.id)} ${step.title}`
          );
          const heading = el("div", "pc-menu-heading"), close = btn("", "pc-quiet", () => {
            menu = null;
            render();
            focus("more-" + step.id);
          });
          close.append(icon("x"));
          close.setAttribute("aria-label", "Close step actions");
          heading.append(
            el("span", "", `Actions for #${stepNumber(step.id)} ${step.title}`),
            close
          );
          actions.append(heading);
          const buttons = el("div", "pc-menu-buttons");
          if (canReorder(step)) {
            const index = draft.indexOf(step);
            for (const [label, direction] of [
              ["Move earlier", -1],
              ["Move later", 1]
            ]) {
              const move = btn(label, "", () => moveOne(step.id, direction));
              move.disabled = !!sending || !draft[index + direction];
              buttons.append(move);
            }
          }
          if (!isReview(step)) {
            const insert = btn(
              "Add code review after this",
              "",
              () => insertReview(step.id)
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
              if (mutate(() => {
                step.status = isDone ? "pending" : "completed";
                step.completion_source = isDone ? null : "user";
              }))
                focus("more-" + step.id);
            }
          );
          status.id = root.id + "-menu-first-" + step.id;
          const dependents = draft.filter(
            (s) => executionDeps(s).includes(step.id)
          );
          const historyStatus = original && original.status !== "pending" ? original.status : step.status;
          const remove = btn("Remove planned step", "pc-remove", () => {
            if (historyStatus !== "pending") return;
            const index = draft.findIndex((s) => s.id === step.id), wasSelected = selected.has(step.id);
            menu = null;
            if (mutate(() => draft.splice(index, 1))) {
              removed.push({ step, index, selected: wasSelected });
              render();
              q(".pc-undo").focus();
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
              historyStatus === "completed" ? "Completed work is kept in plan history." : historyStatus === "in_progress" ? "Active work is kept in the plan." : "Removal deletes only this planned step. It does not revert code."
            )
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
                  }
                )
              );
            actions.append(affected);
            const replan = btn(
              "Replan dependencies",
              "pc-row-action",
              () => submit("replan", [step.id])
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
              () => openStep(id)
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
              `Runs after #${stepNumber(step.run_after)} ${after ? shortLabel(after) : step.run_after}`
            )
          );
        }
        planningActions(context, step);
        row.append(context);
        const details = el("div", "pc-details");
        details.id = root.id + "-details-" + step.id;
        details.hidden = !isOpen;
        if (isOpen) {
          let extra = details;
          if (isReview(step)) {
            details.append(el("span", "pc-label", "Review checks"));
            const checks = el("ul", "pc-checks");
            for (const check of step.checks || [])
              checks.append(el("li", "", check));
            details.append(checks);
            extra = el("details", "pc-settings");
            extra.open = settings.has(step.id);
            extra.append(
              el("summary", "cursor-interaction", "Context & settings")
            );
            extra.addEventListener("toggle", () => {
              if (!extra.isConnected) return;
              const changed2 = extra.open !== settings.has(step.id);
              if (extra.open) settings.add(step.id);
              else settings.delete(step.id);
              if (changed2) save();
            });
            details.append(extra);
          }
          if (step.description)
            extra.append(el("p", "pc-description", step.description));
          if (isReview(step)) {
            if (canReorder(step)) {
              const controls = el("div", "pc-review-controls"), position = el("label", "", "Run after"), select = el("select");
              select.setAttribute(
                "aria-label",
                "Run review after: " + step.title
              );
              const index = draft.indexOf(step), lastTarget = Math.max(
                ...step.depends_on.map(
                  (id) => draft.findIndex((s) => s.id === id)
                )
              );
              for (const [i, other] of draft.entries())
                if (other.id !== step.id) {
                  const cycle = dependsOn(other.id, step.id), disabled = i < lastTarget || cycle, option = el(
                    "option",
                    "",
                    `#${i + 1} ${shortLabel(other)}${disabled ? " \u2014 " + (cycle ? "depends on this review" : "before inspected work") : ""}`
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
                    step
                  );
                });
              });
              position.append(select);
              controls.append(position);
              controls.append(
                el(
                  "p",
                  "pc-label",
                  "Changes timing only. The inspected steps stay the same."
                )
              );
              const scope = el("details");
              scope.append(
                el(
                  "summary",
                  "cursor-interaction",
                  `What to inspect \xB7 ${step.depends_on.length} ${step.depends_on.length === 1 ? "step" : "steps"}`
                )
              );
              for (const other of draft.slice(0, index).filter((s) => !isReview(s))) {
                const label2 = el("label", "cursor-interaction"), check = el("input");
                check.type = "checkbox";
                check.checked = step.depends_on.includes(other.id);
                check.disabled = !!sending || check.checked && step.depends_on.length === 1;
                check.setAttribute(
                  "aria-label",
                  "Include in review: " + other.title
                );
                check.addEventListener("change", () => {
                  mutate(() => {
                    step.depends_on = check.checked ? [...step.depends_on, other.id] : step.depends_on.filter((id) => id !== other.id);
                  });
                  const current = list.querySelector(
                    `[data-step="${step.id}"] .pc-review-controls details`
                  );
                  if (current) current.open = true;
                });
                label2.append(
                  check,
                  el("span", "", `#${stepNumber(other.id)} ${other.title}`)
                );
                scope.append(label2);
              }
              controls.append(scope);
              extra.append(controls);
            } else if (step.status === "pending") {
              extra.append(
                el(
                  "p",
                  "pc-label",
                  "Save the reopened review before changing its timing or scope."
                )
              );
            }
            const inherited = el("div", "pc-inherited");
            inherited.append(
              el("span", "pc-label", "Reviewer context \xB7 included automatically")
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
                  el("p", "", "Draft note: " + notes.get(id).text.trim())
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
                  `${dep?.title || id} \xB7 ${dep?.status === "completed" ? "complete" : selected.has(id) ? "selected" : "not selected"}`
                )
              );
            }
            details.append(deps);
          }
          if (step.complexity_reason && !isReview(step))
            details.append(
              el("p", "pc-description", "Complexity: " + step.complexity_reason)
            );
          if (Number.isInteger(step.estimated_files))
            details.append(
              el(
                "p",
                "pc-condition",
                `Estimated change footprint: ~${step.estimated_files} files.`
              )
            );
          if (step.estimate_note)
            details.append(el("p", "pc-condition", step.estimate_note));
          if (step.review_note)
            details.append(el("p", "pc-description", "Plan review evidence: " + step.review_note));
          if (step.progress_note)
            details.append(
              el("p", "pc-description", "Latest result: " + step.progress_note)
            );
          if (!isDone && broad(step))
            details.append(
              el(
                "p",
                "pc-condition",
                step.scope_warning || "This step combines several outcomes; use Split step to make them independently verifiable."
              )
            );
          if (step.done_when) {
            const criterion = el("div", "pc-criterion");
            criterion.append(
              el("span", "pc-label", "Done when"),
              el("span", "", step.done_when)
            );
            extra.append(criterion);
          }
          for (const note of step.comments) {
            const box = el("div", "pc-note"), head = el("div", "pc-note-head"), saved = (original?.comments || []).some((c) => c.id === note.id);
            head.append(
              el(
                "span",
                "",
                !saved ? "Your note \xB7 draft" : note.state === "acknowledged" ? "Addressed" : "Your note"
              )
            );
            const remove = btn(
              "",
              "pc-quiet",
              () => mutate(() => {
                step.comments = step.comments.filter((c) => c.id !== note.id);
              })
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
          const editor = el("div", "pc-editor"), label = el(
            "label",
            "",
            isReview(step) ? "Additional notes for reviewer" : "Notes for Codex"
          ), text = el("textarea");
          text.id = root.id + "-note-" + step.id;
          label.htmlFor = text.id;
          text.rows = 2;
          text.maxLength = 1e3;
          text.placeholder = "Add a constraint, question, or change\u2026";
          text.setAttribute("aria-label", "Note for: " + step.title);
          text.value = notes.get(step.id)?.text || "";
          text.disabled = !!sending;
          const shortcut = el(
            "span",
            "pc-label",
            "Enter saves edits \xB7 Command+Enter adds a line"
          );
          shortcut.id = text.id + "-shortcut";
          text.setAttribute("aria-describedby", shortcut.id);
          text.setAttribute("aria-keyshortcuts", "Enter Meta+Enter");
          text.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || event.isComposing || event.keyCode === 229)
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
        (destinations.get(step.id) || list).append(row);
      }
      if (finished) {
        for (const control of root.querySelectorAll("button,input,textarea,select"))
          if (!control.matches(".pc-expand,.pc-step-link,.pc-lifecycle")) control.disabled = true;
      }
      if (globalThis.lucide)
        globalThis.lucide.createIcons({ attrs: { width: 16, height: 16 } });
    }
    q(".pc-select-all").addEventListener("click", () => {
      const available = availableSelection();
      selected = selection().length === available.size ? /* @__PURE__ */ new Set() : available;
      requestIds.implement = null;
      notify("");
      save();
      render();
      q(".pc-select-all").focus();
    });
    q(".pc-undo").addEventListener("click", () => {
      if (!removed.length || draft.length >= 30) return;
      const entry = removed[removed.length - 1];
      if (mutate(() => {
        const steps = [...draft, entry.step], preferred = Math.min(entry.index, draft.length), positions = Array.from(
          { length: steps.length },
          (_, index) => index
        ).sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
        let failure;
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
      })) {
        removed.pop();
        if (entry.selected) selected.add(entry.step.id);
        save();
        render();
        focus("more-" + entry.step.id);
      }
    });
    function updateAddType() {
      const review = q(".pc-add-type").value === "review";
      q(".pc-add").hidden = review;
      q(".pc-review-insert").hidden = !review;
    }
    q(".pc-add-toggle").addEventListener("click", () => {
      const form = q(".pc-composer");
      form.hidden = !form.hidden;
      updateAddType();
      q(".pc-add-toggle").setAttribute(
        "aria-expanded",
        String(!form.hidden)
      );
      if (!form.hidden) q(".pc-add-type").focus();
    });
    q(".pc-add-type").addEventListener(
      "change",
      updateAddType
    );
    function insertReview(after) {
      if (sending || draft.length >= 30 || !byId(after) || isReview(byId(after)))
        return;
      const step = {
        id: uid(),
        kind: "review",
        title: "Review changes in a fresh Codex task",
        ...byId(after)?.milestone ? { milestone: byId(after).milestone } : {},
        description: "A fresh Codex task checks the chosen work against its requirements and reports findings here.",
        done_when: "Every required check has evidence for the exact code snapshot and no blocking findings remain.",
        depends_on: [after],
        run_after: after,
        checks: clone(defaultChecks),
        status: "pending",
        comments: []
      };
      menu = null;
      if (mutate(() => {
        draft.splice(draft.findIndex((s) => s.id === after) + 1, 0, step);
        revealMilestone(step.id);
      })) {
        expanded.add(step.id);
        q(".pc-composer").hidden = true;
        q(".pc-add-toggle").setAttribute(
          "aria-expanded",
          "false"
        );
        save();
        render();
        focus("expand-" + step.id);
      }
    }
    q(".pc-insert-review").addEventListener(
      "click",
      () => insertReview(q(".pc-review-after").value)
    );
    function addStep() {
      if (sending) return;
      const form = q(".pc-add"), title = q("input", form), description = q("textarea", form);
      if (!title.value.trim()) {
        title.reportValidity();
        return;
      }
      if (draft.length >= 30) {
        notify("This proof of concept supports up to thirty steps.");
        return;
      }
      const step = {
        id: uid(),
        title: title.value.trim(),
        description: description.value.trim(),
        done_when: "",
        status: "pending",
        comments: []
      };
      if (mutate(() => {
        draft.push(step);
        revealMilestone(step.id);
      })) {
        title.value = "";
        description.value = "";
        q(".pc-composer").hidden = true;
        q("details", form).open = false;
        q(".pc-add-toggle").setAttribute(
          "aria-expanded",
          "false"
        );
        focus("select-" + step.id);
      }
    }
    q(".pc-add-button").addEventListener("click", addStep);
    q(".pc-add input").addEventListener("keydown", (event) => {
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
      if (menu && !(event.target instanceof Element && event.target.closest(".pc-menu-wrap,.pc-menu"))) {
        const id = menu;
        menu = null;
        document.getElementById(root.id + "-menu-" + id)?.remove();
        document.getElementById(root.id + "-more-" + id)?.setAttribute("aria-expanded", "false");
      }
    });
    async function submit(intent, targets = []) {
      const lifecycleAction = intent === "finish" || intent === "reopen";
      if (finished && intent !== "reopen") return;
      const ops = intent === "reopen" ? [] : operations(), ids = selection(), planning = ["review", "decompose", "replan"].includes(intent);
      if (sending || !lifecycleAction && (intent === "edit" ? !ops.some((op) => op.type !== "reorder_steps") : planning ? !targets.length : !ids.length))
        return;
      try {
        replay(ops);
      } catch (error) {
        notify(
          `Cannot submit: ${error.message}. Your edits are preserved.`
        );
        return;
      }
      if (config.preview) {
        notify(
          lifecycleAction ? `Preview: Codex would ${intent === "finish" ? "finish this plan and stop automatic cards, keeping task statuses" : "reopen this plan without authorizing work"}. No request was sent.` : intent === "implement" ? `Preview: ${runLabel(ids)}. Review steps open fresh Codex tasks; unselected steps stay for later. No request was sent.` : planning ? `Preview: Codex would ${intent === "replan" ? "replan dependencies for" : intent === "decompose" ? "break down" : "review"} ${targets.length} ${targets.length === 1 ? "step" : "steps"} without starting implementation. No request was sent.` : "Preview: edits are kept here. No request was sent."
        );
        return;
      }
      if (typeof window.openai?.sendFollowUpMessage !== "function") {
        notify(
          "Open this card inside Codex to submit. Your edits and selection are preserved."
        );
        return;
      }
      const key = planning ? intent + ":" + targets.join(",") : intent;
      requestIds[key] = requestIds[key] || uid();
      const request = {
        plan_id: base.plan_id,
        base_revision: base.revision,
        request_id: requestIds[key],
        intent,
        operations: ops
      };
      if (intent === "implement") request.selected_step_ids = ids;
      if (planning) request.target_step_ids = targets;
      const instruction = intent === "finish" ? "Apply the included draft edits and finish this plan through the helper. Preserve every task's actual status and notes; unfinished tasks remain unfinished. Clear implementation approval. Confirm briefly in text and do not render another card. Keep this plan quiet on future follow-ups unless the user explicitly asks to show or reopen it." : intent === "reopen" ? "Reopen this plan through the helper and show the current card for selection. Preserve task history. Reopening does not approve or resume implementation; wait for a fresh work selection." : intent === "implement" ? "Apply the included plan edits, then implement ONLY the selected_step_ids listed below in prerequisite order. Keep unselected steps for later. Selection is not completion. After meaningful changes, revalidate affected unfinished steps and preserve completed history. Do not silently expand scope. If the active collaboration mode prohibits implementation, retain this selected scope and explain the mode constraint. Do not execute the same request twice. Refresh the card with observed progress afterward." : intent === "decompose" ? "Apply the included edits, then break ONLY the target_step_ids into smaller verifiable steps with explicit dependencies and grounded effort estimates. Preserve completed history and unrelated steps. Rewire downstream dependencies. New child steps are not authorized for implementation. Show the revised plan for selection; this request does not start implementation." : intent === "review" ? "Apply the included edits, then review the plan for target_step_ids and their prerequisites: assess scope, sequencing, dependencies, and acceptance criteria against current code. This is a plan review, not an implemented-code review. Update assumptions, dependencies, and estimates as needed; clear freshness warnings only with evidence. Preserve completed history. Show the revised plan; this request does not start implementation." : "Revise the plan and acknowledge notes; this request does not start implementation. Refresh the interactive card afterward.";
      const reviewInstruction = intent === "implement" ? ' Steps with kind="review" are independent reviews: export their review brief including covered step descriptions, acceptance criteria, and notes, and create a fresh Codex task with that brief and the scoped code snapshot; follow references/review-checks.md. Honor run_after as timing and depends_on as inspected scope. Follow list order among ready selected steps. Review selection does not authorize fixes.' : intent === "replan" ? " Replan dependencies of the target_step_ids so a later removal can be considered. Identify every dependent by name, including run_after references and review coverage. Rewire only when the actual requirements support it; otherwise explain the concrete decision needed. Preserve the target, completed history, and active work. Do not delete steps, revert code, or start implementation. Clear affected freshness warnings only after checking the revised plan." : "";
      const prompt = "Use $hyperion-plan. Read the skill at " + config.skill_path + ".\nPlan file: " + config.plan_path + "\nAdapt explanations and necessary questions to the user\u2019s demonstrated familiarity with this task. Short messages alone do not imply low expertise. For unfamiliar users, clarify functional goals and explain architectural tradeoffs in plain language; do not repeat resolved questions.\n" + instruction + reviewInstruction + "\n\nChange request JSON:\n" + JSON.stringify(request, null, 2);
      sending = intent;
      menu = null;
      save();
      render();
      try {
        await window.openai.sendFollowUpMessage({
          prompt,
          title: intent === "finish" ? "Finish this plan" : intent === "reopen" ? "Reopen this plan" : intent === "implement" ? runLabel(ids) : intent === "replan" ? "Replan dependencies" : intent === "decompose" ? "Break down the selected steps" : intent === "review" ? "Review the affected plan steps" : "Save edits to this task plan"
        });
        notify(
          "Review the send dialog. Codex will confirm the disk save in its reply; your edits and selection stay here."
        );
      } catch {
        notify(
          "Request not confirmed. Your edits and selection are preserved; you can retry."
        );
      } finally {
        sending = false;
        render();
      }
    }
    apply.addEventListener("click", () => submit("edit"));
    implement.addEventListener("click", () => submit("implement"));
    lifecycle.addEventListener("click", () => submit(finished ? "reopen" : "finish"));
    q(".pc-decompose-selection").addEventListener(
      "click",
      () => submit(
        "decompose",
        selection().filter((id) => broad(byId(id)))
      )
    );
    restore(window.openai?.widgetState);
    render();
    window.addEventListener("openai:set_globals", (event) => {
      const saved = event.detail?.globals?.widgetState;
      if (!sending && !interacted && saved && restore(saved)) render();
    });
  })();
})();
