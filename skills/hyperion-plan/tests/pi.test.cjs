const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const core = require("../dist/index.cjs");

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-pi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function samplePlan(steps = [
  { id: "a", title: "First", status: "pending", description: "Foundation" },
  { id: "b", title: "Second", status: "pending", depends_on: ["a"] },
  { id: "c", title: "Independent", status: "pending" },
]) {
  return core.initialize({ title: "Pi integration", steps });
}
function savedPlan(dir, steps) {
  const planPath = path.join(dir, "plan.md");
  const plan = samplePlan(steps);
  core.saveMarkdown(planPath, plan);
  return { planPath, plan };
}

let uiPromise;
function loadUI() {
  if (!uiPromise) {
    const piEntry = path.resolve(__dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    const piRequire = createRequire(piEntry);
    const tuiPath = piRequire.resolve("@earendil-works/pi-tui");
    uiPromise = import(pathToFileURL(piRequire.resolve("jiti")).href).then(({ createJiti }) => {
      const jiti = createJiti(pathToFileURL(__filename).href, {
        alias: { "@earendil-works/pi-tui": tuiPath },
      });
      return Promise.all([
        jiti.import(path.resolve(__dirname, "../src/pi/ui.ts")),
        import(pathToFileURL(tuiPath).href),
        jiti.import(path.resolve(__dirname, "../src/pi/extension.ts")),
      ]);
    });
  }
  return uiPromise;
}

test("the packaged Pi extension bundle imports with host-provided TUI APIs", async () => {
  const extension = await import("../dist/hyperion-plan-pi.js");
  assert.equal(typeof extension.default, "function");
});

test("the selected path is explicit, supports session-relative resolution, and creates only there", async (t) => {
  const cwd = scratch(t);
  const expected = path.join(cwd, "tasks", "selected.md");
  assert.equal(core.selectedPlanPath("tasks/selected.md", cwd), expected);
  const snapshot = await core.createPlan("tasks/selected.md", "Selected task", { cwd });
  assert.equal(snapshot.path, expected);
  assert.equal(snapshot.plan.title, "Selected task");
  assert.deepEqual(snapshot.plan.steps, []);
  assert.equal((await core.loadPlanSnapshot("tasks/selected.md", { cwd })).refresh_required, false);
  assert.equal(fs.existsSync(path.join(cwd, "plan.md")), false);
});

test("external Markdown changes require an explicit refresh before writes", async (t) => {
  const dir = scratch(t), { planPath } = savedPlan(dir);
  const initial = await core.loadPlanSnapshot(planPath);
  fs.writeFileSync(planPath, fs.readFileSync(planPath, "utf8").replace("# Pi integration", "# Updated from editor"));
  const stale = await core.loadPlanSnapshot(planPath);
  assert.equal(stale.refresh_required, true);
  assert.equal(stale.plan.title, "Updated from editor");
  assert.equal(stale.plan.revision, initial.plan.revision + 1);

  const refreshed = await core.loadPlanSnapshot(planPath, { refresh: true, actorId: "pi-session" });
  assert.equal(refreshed.refresh_required, false);
  assert.equal(refreshed.plan.revision, stale.plan.revision);
  const request = {
    plan_id: refreshed.plan.plan_id,
    base_revision: refreshed.plan.revision,
    request_id: "pi-edit-test",
    intent: "edit",
    operations: [{ type: "update_step", step_id: "b", fields: { title: "Revised second" } }],
  };
  const result = await core.mutatePlan(planPath, "pi-session", plan => core.applyRequest(plan, request));
  assert.equal(result.plan.revision, refreshed.plan.revision + 1);
  assert.equal(result.plan.steps[1].title, "Revised second");
  assert.equal(result.plan.execution, undefined);
  assert.match(fs.readFileSync(core.notesPath(planPath), "utf8"), /Revised second/);
});

test("refresh and mutation check execution ownership before persisting external edits", async (t) => {
  const dir = scratch(t), { planPath, plan } = savedPlan(dir);
  plan.execution_owner = "owner-session";
  core.saveMarkdown(planPath, plan);
  fs.writeFileSync(planPath, fs.readFileSync(planPath, "utf8").replace("# Pi integration", "# External change"));
  const before = [planPath, core.markdownStatePath(planPath)].map(file => fs.readFileSync(file));
  await assert.rejects(core.loadPlanSnapshot(planPath, { refresh: true, actorId: "other-session" }), /belongs to task owner-session/);
  await assert.rejects(core.mutatePlan(planPath, "other-session", current => [current, false]), /belongs to task owner-session/);
  assert.deepEqual([planPath, core.markdownStatePath(planPath)].map(file => fs.readFileSync(file)), before);
  const ownerRead = await core.loadPlanSnapshot(planPath, { refresh: true, actorId: "owner-session" });
  assert.equal(ownerRead.refresh_required, false);
  assert.equal(ownerRead.plan.title, "External change");
});

test("JSON mutations refuse to overwrite a file changed during the operation", async (t) => {
  const dir = scratch(t), planPath = path.join(dir, "plan.json"), plan = samplePlan();
  core.atomicWrite(planPath, plan);
  const request = {
    plan_id: plan.plan_id,
    base_revision: plan.revision,
    request_id: "json-race",
    intent: "edit",
    operations: [{ type: "update_step", step_id: "a", fields: { title: "Hyperion write" } }],
  };
  await assert.rejects(core.mutatePlan(planPath, "actor", current => {
    fs.writeFileSync(planPath, JSON.stringify({ ...current, title: "External JSON write" }, null, 2));
    return core.applyRequest(current, request);
  }), /changed during this operation/);
  assert.equal(JSON.parse(fs.readFileSync(planPath, "utf8")).title, "External JSON write");
});

test("update_step uses null to clear optional fields through the shared validator", () => {
  const plan = samplePlan([
    { id: "a", title: "First", status: "pending", short_title: "F" },
    { id: "b", title: "Second", status: "pending", depends_on: ["a"] },
  ]);
  const [updated] = core.applyRequest(plan, {
    plan_id: plan.plan_id, base_revision: plan.revision, request_id: "clear-optional-fields", intent: "edit",
    operations: [{ type: "update_step", step_id: "a", fields: { short_title: null } },
      { type: "update_step", step_id: "b", fields: { depends_on: null } }],
  });
  assert.equal(Object.hasOwn(updated.steps[0], "short_title"), false);
  assert.equal(Object.hasOwn(updated.steps[1], "depends_on"), false);
});

test("step-scope edits revoke approval and invalidate dependents without losing progress", () => {
  let plan = samplePlan([
    { id: "a", title: "First", status: "pending" },
    { id: "b", title: "Second", status: "pending", depends_on: ["a"] },
  ]);
  [plan] = core.applyRequest(plan, {
    plan_id: plan.plan_id, base_revision: plan.revision, request_id: "approve",
    intent: "implement", execution_mode: "sequential", operations: [], selected_step_ids: ["a", "b"],
  });
  [plan] = core.checkpoint(plan, plan.revision, "a", "in_progress", "Partial implementation evidence");
  [plan] = core.applyRequest(plan, {
    plan_id: plan.plan_id, base_revision: plan.revision, request_id: "revise-scope", intent: "edit",
    operations: [{ type: "update_step", step_id: "a", fields: { description: "Revised requirements" } }],
  });
  assert.equal(plan.steps[0].status, "in_progress");
  assert.equal(plan.steps[0].needs_replanning, true);
  assert.equal(plan.steps[0].progress_note, "Partial implementation evidence");
  assert.deepEqual(plan.execution.selected_step_ids, ["b"]);
  assert.equal(plan.steps[1].review_state, "needs_review");
});

test("local selection is not approval and Run enforces prerequisites, review and handover barriers", async () => {
  const [{ PlanScreenState }] = await loadUI();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-pi-ui-"));
  try {
    const { planPath } = savedPlan(dir);
    const snapshot = await core.loadPlanSnapshot(planPath);
    const busyState = new PlanScreenState(snapshot, "pi-session", true);
    assert.match(busyState.runBlocker, /Pi is busy/);
    assert.throws(() => busyState.stage({ type: "update_step", step_id: "a", fields: { title: "Blocked write" } }), /Pi is busy/);
    const state = new PlanScreenState(snapshot, "pi-session", false);
    state.toggleSelection("b");
    assert.match(state.runBlocker, /Missing prerequisite for b: a/);
    state.toggleSelection("a");
    assert.equal(state.runBlocker, undefined);
    assert.equal(state.plan.execution, undefined);
    assert.deepEqual(state.selectedStepIds, ["a", "b"]);

    state.stage({ type: "update_step", step_id: "b", fields: { title: "Draft title" } });
    assert.equal(state.displayPlan.steps[1].title, "Draft title");
    assert.equal(state.plan.steps[1].title, "Second");
    assert.equal(state.runBlocker, undefined);
    const advanced = core.clone(state.plan);
    advanced.revision++;
    advanced.steps[2].description = "External edit";
    state.acceptSnapshot({ ...snapshot, plan: advanced, summary: core.summary(advanced) });
    assert.equal(state.staleDraft, true);
    assert.equal(state.displayPlan.steps[1].title, "Draft title");
    assert.match(state.mutationBlocker, /draft is preserved/);

    const sameRevisionState = new PlanScreenState({ ...snapshot, source_digest: "json-before-edit" }, "pi-session", false);
    sameRevisionState.stage({ type: "update_step", step_id: "a", fields: { title: "Another draft" } });
    sameRevisionState.acceptSnapshot({ ...snapshot, source_digest: "json-edited-without-revision-bump" });
    assert.equal(sameRevisionState.plan.revision, snapshot.plan.revision);
    assert.equal(sameRevisionState.staleDraft, true);
    assert.match(sameRevisionState.mutationBlocker, /draft is preserved/);

    const reviewPlan = samplePlan([
      { id: "a", title: "Implementation", status: "pending" },
      { id: "r", title: "Independent review", kind: "review", status: "pending", depends_on: ["a"], checks: ["Inspect changes"] },
      { id: "b", title: "Later implementation", status: "pending", depends_on: ["r"] },
    ]);
    const reviewState = new PlanScreenState({ ...snapshot, plan: reviewPlan, summary: core.summary(reviewPlan) }, "pi-session", false);
    reviewState.toggleSelection("b");
    assert.equal(reviewState.selected.size, 0);
    assert.match(reviewState.notice, /Review barrier first/);

    const handoverPlan = samplePlan([
      { id: "a", title: "Before transfer", status: "pending" },
      { id: "h", title: "Transfer ownership", kind: "handover", status: "pending", depends_on: ["a"] },
      { id: "b", title: "After transfer", status: "pending", depends_on: ["h"] },
    ]);
    const handoverState = new PlanScreenState({ ...snapshot, plan: handoverPlan, summary: core.summary(handoverPlan) }, "pi-session", false);
    handoverState.toggleSelection("a");
    assert.match(handoverState.runBlocker, /handover checkpoint/);
    handoverState.toggleSelection("b");
    assert.match(handoverState.notice, /Handover checkpoint first/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registers an explicit native command and keeps non-TUI behavior available", async () => {
  const [, , extensionModule] = await loadUI();
  let registered;
  extensionModule.default({ on() {}, registerTool() {}, registerMessageRenderer() {}, registerCommand: (name, options) => { registered = { name, options }; } });
  assert.equal(registered.name, "hyperion-plan");
  assert.match(registered.options.description, /canonical Hyperion plan/);
  const notifications = [];
  await registered.options.handler("", {
    mode: "json",
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  });
  assert.match(notifications[0].message, /requires Pi interactive TUI/);
  assert.equal(notifications[0].type, "warning");
});

test("session binding refuses a different plan that replaced the bound path", async (t) => {
  const [, , extensionModule] = await loadUI();
  const dir = scratch(t), { planPath } = savedPlan(dir);
  const entries = [{ type: "custom", customType: "hyperion-plan.binding", data: { path: planPath, plan_id: "old-plan-id" } }];
  const notifications = [];
  const pi = {
    on() {}, registerTool() {}, registerMessageRenderer() {},
    registerCommand(name, options) { this.command = { name, options }; },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  extensionModule.default(pi);
  await pi.command.options.handler("", {
    cwd: dir,
    mode: "tui",
    isIdle: () => true,
    sessionManager: { getSessionId: () => "pi-session", getBranch: () => entries },
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      custom: async () => assert.fail("A replaced plan must not open through the old binding"),
    },
  });
  assert.match(notifications[0].message, /Specify the path explicitly/);
  assert.equal(entries.length, 1);
});

test("session drafts survive screen closure and are cleared after save", async (t) => {
  const [, , extensionModule] = await loadUI();
  const dir = scratch(t), { planPath } = savedPlan(dir);
  const entries = [], renders = [], notifications = [];
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  const tui = { requestRender() {}, terminal: { rows: 42 } };
  const pi = {
    on() {}, registerTool() {}, registerMessageRenderer() {},
    registerCommand(name, options) { this.command = { name, options }; },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage() { assert.fail("No user message should be sent during edit-only actions"); },
  };
  extensionModule.default(pi);
  const context = (script) => {
    const actions = [...script];
    return {
      cwd: dir,
      mode: "tui",
      isIdle: () => true,
      sessionManager: { getSessionId: () => "pi-session", getBranch: () => entries },
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
        input: async () => undefined,
        confirm: async () => true,
        editor: async (_title, prefill) => {
          if (prefill.includes('"title": "First"')) return JSON.stringify({ title: "Draft rename" }, null, 2);
          return prefill;
        },
        custom: async (factory) => {
          let result;
          const screen = factory(tui, theme, {}, action => { result = action; });
          renders.push(screen.render(120).join("\n"));
          const input = actions.shift();
          if (input === "edit") screen.handleInput("e");
          else if (input === "save") screen.handleInput("s");
          else screen.handleInput("\x1b");
          return result;
        },
      },
    };
  };

  await pi.command.options.handler(planPath, context(["edit", "close"]));
  assert.equal((await core.loadPlanSnapshot(planPath)).plan.steps[0].title, "First");
  assert.ok(entries.some(entry => entry.customType === "hyperion-plan.draft" && entry.data.operations.length === 1));

  renders.length = 0;
  await pi.command.options.handler("", context(["close"]));
  assert.match(renders[0], /Draft rename/);
  assert.match(renders[0], /UNSAVED EDITS/);
  assert.match(renders[0], /Restored 1 unsaved plan edit/);

  const planId = (await core.loadPlanSnapshot(planPath)).plan.plan_id;
  entries.push({
    type: "custom", customType: "hyperion-plan.draft",
    data: { path: planPath, plan_id: planId, operations: "malformed latest draft" },
  });
  renders.length = 0;
  await pi.command.options.handler("", context(["close"]));
  assert.doesNotMatch(renders[0], /UNSAVED EDITS|STALE DRAFT/);
  assert.match(renders[0], /First/);

  await pi.command.options.handler("", context(["edit", "close"]));
  assert.ok(entries.at(-1).data.operations.length === 1);
  renders.length = 0;
  await pi.command.options.handler("", context(["save", "close"]));
  assert.equal((await core.loadPlanSnapshot(planPath)).plan.steps[0].title, "Draft rename");
  assert.equal(entries.at(-1).customType, "hyperion-plan.draft");
  assert.deepEqual(entries.at(-1).data.operations, []);

  renders.length = 0;
  await pi.command.options.handler("", context(["close"]));
  assert.doesNotMatch(renders[0], /UNSAVED EDITS|STALE DRAFT/);
  assert.match(renders[0], /Draft rename/);
  assert.ok(notifications.some(item => /preserved in this Pi session/.test(item.message)));
});

test("native screen remains within narrow and resized overlays and keyboard controls work", async () => {
  const [{ PlanScreen, PlanScreenState }, tui] = await loadUI();
  const plan = samplePlan();
  const fakeSnapshot = { path: "/tmp/plan.md", plan, refresh_required: false, source_digest: "", summary: core.summary(plan) };
  const state = new PlanScreenState(fakeSnapshot, "pi-session", false);
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  let rows = 42, action;
  const screen = new PlanScreen(state, theme, () => {}, () => rows, value => { action = value; });
  for (const width of [1, 20, 41, 42, 60, 80, 99, 100, 120, 160]) {
    for (rows of [1, 10, 20, 24, 32, 42, 70]) {
      const lines = screen.render(width);
      assert.ok(lines.length <= Math.floor(rows * 0.95), `${width}x${rows}: ${lines.length} lines`);
      for (const line of lines) assert.ok(tui.visibleWidth(line) <= width, `${width}: ${line}`);
    }
  }
  rows = 42;
  screen.handleInput("j");
  assert.equal(state.focusedStepId, "b");
  screen.handleInput(" ");
  assert.deepEqual(state.selectedStepIds, ["b"]);
  assert.equal(action, undefined);
  screen.handleInput("r");
  assert.equal(action, undefined); // The missing prerequisite is explained; no request is emitted.
  assert.match(state.notice, /Missing prerequisite for b: a/);
  screen.handleInput("\x1b");
  assert.equal(action?.type, "close");
});
