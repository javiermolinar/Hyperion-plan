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

for (const dirty of [false, true]) test(`review fix F1: snapshot acceptance preserves original identity, selection and draft=${dirty}`, async t => {
  const [{ PlanScreenState }] = await loadUI();
  const { planPath } = savedPlan(scratch(t)), snapshot = await core.loadPlanSnapshot(planPath);
  const persisted = [], state = new PlanScreenState(snapshot, 'pi-session', false, draft => persisted.push(structuredClone(draft.draftOperations)));
  state.toggleSelection('a');
  if (dirty) state.stage({ type: 'update_step', step_id: 'a', fields: { title: 'Preserved draft' } });
  const operations = structuredClone(state.draftOperations), before = structuredClone(persisted);
  assert.throws(() => state.acceptSnapshot({ ...snapshot, plan: samplePlan() }), /replaced/);
  assert.equal(state.snapshot, snapshot);
  assert.deepEqual(state.selectedStepIds, ['a']);
  assert.deepEqual(state.draftOperations, operations);
  assert.deepEqual(persisted, before);
  state.acceptSnapshot(snapshot);
  assert.deepEqual(state.selectedStepIds, ['a']);
});

test("local selection is intent; readiness stays in canonical admission, not disabled Run",  async () => {
  const [{ PlanScreenState }] = await loadUI();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-pi-ui-"));
  try {
    const { planPath } = savedPlan(dir);
    const snapshot = await core.loadPlanSnapshot(planPath);
    const busyState = new PlanScreenState(snapshot, "pi-session", true);
    busyState.toggleSelection("a");
    assert.equal(busyState.runBlocker, undefined, "busy requests can be queued");
    assert.throws(() => busyState.stage({ type: "update_step", step_id: "a", fields: { title: "Blocked write" } }), /Pi is busy/);
    const state = new PlanScreenState(snapshot, "pi-session", false);
    state.toggleSelection("b");
    assert.equal(state.runBlocker, undefined);
    assert.match(state.selectionProblem(), /Missing prerequisite for b: a/);
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
    assert.match(state.mutationBlocker, /preserved draft/);

    const sameRevisionState = new PlanScreenState({ ...snapshot, source_digest: "json-before-edit" }, "pi-session", false);
    sameRevisionState.stage({ type: "update_step", step_id: "a", fields: { title: "Another draft" } });
    sameRevisionState.acceptSnapshot({ ...snapshot, source_digest: "json-edited-without-revision-bump" });
    assert.equal(sameRevisionState.plan.revision, snapshot.plan.revision);
    assert.equal(sameRevisionState.staleDraft, true);
    assert.match(sameRevisionState.mutationBlocker, /preserved draft/);

    const reviewPlan = samplePlan([
      { id: "a", title: "Implementation", status: "pending" },
      { id: "r", title: "Independent review", kind: "review", status: "pending", depends_on: ["a"], checks: ["Inspect changes"] },
      { id: "b", title: "Later implementation", status: "pending", depends_on: ["r"] },
    ]);
    const reviewState = new PlanScreenState({ ...snapshot, plan: reviewPlan, summary: core.summary(reviewPlan) }, "pi-session", false);
    reviewState.toggleSelection("b");
    assert.deepEqual(reviewState.selectedStepIds, ["b"]);
    assert.equal(reviewState.runBlocker, undefined);
    assert.match(reviewState.selectionProblem(), /Missing prerequisite/);

    const handoverPlan = samplePlan([
      { id: "a", title: "Before transfer", status: "pending" },
      { id: "h", title: "Transfer ownership", kind: "handover", status: "pending", depends_on: ["a"] },
      { id: "b", title: "After transfer", status: "pending", depends_on: ["h"] },
    ]);
    const handoverState = new PlanScreenState({ ...snapshot, plan: handoverPlan, summary: core.summary(handoverPlan) }, "pi-session", false);
    handoverState.toggleSelection("a");
    assert.equal(handoverState.runBlocker, undefined, 'explicit Run may include the existing trailing handover checkpoint');
    handoverState.toggleSelection("b");
    assert.equal(handoverState.runBlocker, undefined);
    assert.deepEqual(handoverState.selectedStepIds, ['a', 'b']);
    assert.equal(handoverState.plan.execution, undefined, 'selection is not transfer or execution approval');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review intent stays selectable before reconciliation while execution blockers remain enforced",  async (t) => {
  const [{ PlanScreenState }] = await loadUI();
  const dir = scratch(t);
  const { planPath } = savedPlan(dir, [
    { id: "a", title: "Implementation", status: "completed" },
    { id: "r", title: "Independent review", kind: "review", status: "in_progress",
      depends_on: ["a"], checks: ["Inspect changes"], review_state: "needs_review",
      review_note: "Implementation changed after the prior review.",
      progress_note: "Prior review settled; report covers pre-fix code.",
      blocked_by: "Awaiting a fresh explicit review request." },
    { id: "b", title: "Later work", status: "pending", depends_on: ["r"] },
  ]);
  const snapshot = await core.loadPlanSnapshot(planPath);
  const blocked = new PlanScreenState(snapshot, "pi-session", false);
  blocked.toggleSelection("r");
  assert.deepEqual(blocked.selectedStepIds, ["r"]);
  assert.equal(blocked.runBlocker, undefined);
  assert.match(blocked.selectionProblem(), /blocked/);

  // Reconcile the incorrect data, not the execution guard. Preserve history and
  // acceptance; neither a saved correction nor a checkbox authorizes review.
  const replacement = core.clone(snapshot.plan);
  delete replacement.steps[1].blocked_by;
  replacement.steps[1].review_note = "Post-fix independent evidence is still required.";
  const plan = core.revise(snapshot.plan, replacement, snapshot.plan.revision);
  const review = plan.steps[1];
  assert.equal(review.status, "in_progress");
  assert.equal(review.progress_note, snapshot.plan.steps[1].progress_note);
  assert.equal(review.review_state, "needs_review");
  assert.equal(plan.execution, undefined);
  const state = new PlanScreenState({ ...snapshot, plan, summary: core.summary(plan) }, "pi-session", false);
  state.toggleSelection("r");
  assert.deepEqual(state.selectedStepIds, ["r"]);
  assert.equal(state.runBlocker, undefined);
  assert.equal(state.plan.execution, undefined);
  state.acceptSnapshot({ ...snapshot, plan, summary: core.summary(plan) });
  assert.deepEqual(state.selectedStepIds, ["r"], "unchanged refresh must preserve a selected review");
  state.toggleSelection("b");
  assert.deepEqual(state.selectedStepIds, ["r", "b"]);
  const approved = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision,
    request_id: "post-fix-review", intent: "implement", operations: [], selected_step_ids: ["r"] })[0];
  assert.deepEqual(approved.execution.selected_step_ids, ["r"]);
  assert.equal(approved.steps[1].status, "in_progress");

  const unavailable = core.clone(plan);
  unavailable.steps[1].blocked_by = "Earlier reviewer has unknown surviving writers.";
  const held = new PlanScreenState({ ...snapshot, plan: unavailable, summary: core.summary(unavailable) }, "pi-session", false);
  held.toggleSelection("r");
  assert.deepEqual(held.selectedStepIds, ["r"]);
  assert.equal(held.runBlocker, undefined);
  assert.match(held.selectionProblem(), /blocked/);
  assert.throws(() => core.applyRequest(unavailable, { plan_id: unavailable.plan_id, base_revision: unavailable.revision,
    request_id: "unsafe-review", intent: "implement", operations: [], selected_step_ids: ["r"] }), /blocked/);
});

test("registers an explicit native command and keeps non-TUI behavior available", async () => {
  const [, , extensionModule] = await loadUI();
  let registered; const commands = [], shortcuts = [];
  extensionModule.default({ on() {}, registerTool() {}, registerMessageRenderer() {},
    registerShortcut: key => shortcuts.push(key), registerCommand: (name, options) => { commands.push(name); registered = { name, options }; } });
  assert.deepEqual(commands, ['hyperion']);
  assert.deepEqual(shortcuts, []);
  assert.equal(registered.name, "hyperion");
  assert.match(registered.options.description, /canonical Hyperion plan/);
  const notifications = [];
  await registered.options.handler("", {
    mode: "json",
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  });
  assert.match(notifications[0].message, /requires Pi interactive TUI/);
  assert.equal(notifications[0].type, "warning");
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
          // Preserve legacy Save-receipt coverage without restoring a hidden menu key.
          if (input === "save") result = { type: "save" };
          else screen.handleInput("\x1b");
          return result;
        },
      },
    };
  };

  const seedDraft = async () => {
    const snapshot = await core.loadPlanSnapshot(planPath);
    entries.push({ type: "custom", customType: "hyperion-plan.draft", data: {
      path: snapshot.path, plan_id: snapshot.plan.plan_id, base_revision: snapshot.plan.revision,
      base_digest: snapshot.source_digest, base_plan: snapshot.plan,
      operations: [{ type: "update_step", step_id: "a", fields: { title: "Draft rename" } }],
    } });
  };
  await seedDraft();
  await pi.command.options.handler(planPath, context(["close"]));
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

  await seedDraft();
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

test('planned executor icons precede stable step IDs and preserve labels, width and mouse selection', async () => {
  const [{ PlanScreen, PlanScreenState }, tui] = await loadUI();
  const plan = core.initialize({ title: 'Executor labels', steps: [
    { id: 'docs', title: '🤖 Summarize installation and usage', short_title: 'Usage' },
    { id: 'ui', title: '🤖 Explain views' },
    { id: 'summary', title: '◉ Verify reports' },
    { id: 'plain', title: 'No assigned executor' },
  ] });
  const state = new PlanScreenState({ path: '/unused/plan.md', plan, source_digest: 'fixture', refresh_required: false, summary: core.summary(plan) }, 'test', false);
  const actions = [];
  const theme = { fg: (_, text) => text, bg: (_, text) => text, bold: text => text };
  const screen = new PlanScreen(state, theme, () => {}, () => 42, action => actions.push(action));
  const lines = screen.render(120);
  const docsRow = lines.findIndex(line => line.includes('[ ] 🤖 docs Usage'));
  assert.ok(docsRow >= 0);
  assert.match(lines.join('\n'), /\[ \] 🤖 ui Explain views/);
  assert.match(lines.join('\n'), /\[ \] ◉ summary Verify reports/);
  assert.match(lines.join('\n'), /\[ \] plain No assigned executor/);
  assert.equal((lines[docsRow].match(/🤖/gu) || []).length, 1);
  assert.doesNotMatch(lines.join('\n'), /(?:docs|ui) 🤖|summary ◉/);
  assert.equal(screen.handleMouse({ x: 5, y: docsRow, type: 'click', button: 'left' }).handled, true);
  assert.deepEqual(state.selectedStepIds, ['docs']);
  assert.deepEqual(actions, []);
  assert.equal(state.plan.steps[0].title, '🤖 Summarize installation and usage');
  assert.equal(state.plan.execution, undefined);
  for (const width of [1, 20, 42, 60, 99, 100, 120, 160]) {
    for (const line of screen.render(width)) assert.ok(tui.visibleWidth(line) <= width, `${width}: ${line}`);
  }
});

// Mouse, resize, Unicode and focus contracts
{
async function fixture() {
  const [{ PlanScreen, PlanScreenState }, tui] = await loadUI();
  const plan = core.initialize({ title: '日本語 e\u0301 👩‍💻', steps: [
    { id: 'a', title: 'Inspect 日本語 👩‍💻', description: 'Detail '.repeat(120) },
    { id: 'b', title: 'Leave untouched', depends_on: ['a'] },
  ] });
  const state = new PlanScreenState({ path: '/unused/plan.md', plan, source_digest: 'fixture', refresh_required: false, summary: core.summary(plan) }, 'test', false);
  let rows = 42, renders = 0, palette = 'dark';
  const actions = [];
  const theme = { fg: (_, s) => `\x1b[${palette === 'dark' ? 36 : 34}m${s}\x1b[0m`, bg: (_, s) => s, bold: s => s };
  const screen = new PlanScreen(state, theme, () => renders++, () => rows, a => actions.push(a));
  return { state, screen, actions, tui, height: n => { rows = n; }, theme: n => { palette = n; }, renders: () => renders };
}
function position(lines, label) {
  const y = lines.findIndex(line => line.includes(label));
  assert.ok(y >= 0, `Missing visible control ${label}`);
  return { x: lines[y].indexOf(label) + 1, y };
}
function click(screen, p) {
  assert.equal(screen.handleMouse({ ...p, type: 'press', button: 'left' }).handled, true);
  screen.handleMouse({ ...p, type: 'click', button: 'left' });
}
function plain(lines) { return lines.map(s => s.replace(/\x1b\[[0-9;]*m/g, '')); }

for (const width of [42, 60, 80, 99, 100, 160]) test(`exactly four plan controls are visible and mouse-addressable at ${width} columns`, async () => {
  const f = await fixture();
  f.state.stage({ type: 'update_step', step_id: 'a', fields: { title: 'Staged edit' } });
  let lines = plain(f.screen.render(width));
  for (const label of ['[Space] Select', '[Enter] Run', '[Esc] Close', '[A] Agents']) position(lines, label);
  assert.doesNotMatch(lines.join('\n'), /\[(?:r|v|\?|e|n|m|d|x|s|z|f|g|q|Tab)\] (?:Run|Check|Ask|Edit|Add|Note|Split|Remove|Save|Discard|Finish|Refresh|Close|Details)/);
  if (width < 100) assert.match(lines.join('\n'), /─ DETAILS ─/);
  click(f.screen, position(lines, '[Space] Select'));
  assert.deepEqual(f.state.selectedStepIds, ['a']); assert.deepEqual(f.actions, []);
  lines = plain(f.screen.render(width));
  click(f.screen, position(lines, '[Enter] Run'));
  assert.deepEqual(f.actions, [{ type: 'run', selectedStepIds: ['a'] }]);
  assert.equal(f.state.plan.execution, undefined);
});

test('mouse press does not select or run; click acts once and wheel changes focus/details', async () => {
  const f = await fixture();
  let lines = plain(f.screen.render(120));
  const y = lines.findIndex(s => s.includes('[ ] a'));
  f.screen.handleMouse({ x: 5, y, type: 'press', button: 'left' });
  assert.deepEqual(f.state.selectedStepIds, []);
  f.screen.handleMouse({ x: 5, y, type: 'click', button: 'left' });
  assert.deepEqual(f.state.selectedStepIds, ['a']);
  lines = plain(f.screen.render(120));
  const run = position(lines, '[Enter] Run');
  f.screen.handleMouse({ ...run, type: 'press', button: 'left' });
  assert.equal(f.actions.length, 0);
  const result = f.screen.handleMouse({ ...run, type: 'click', button: 'left' });
  assert.equal(result.focus, undefined, 'do not refocus an overlay that Run just disposed');
  assert.deepEqual(f.actions, [{ type: 'run', selectedStepIds: ['a'] }]);
  assert.equal(f.state.plan.execution, undefined);
  f.screen.handleMouse({ x: 100, y, type: 'wheel', wheelDelta: 3 });
  assert.equal(f.state.detailOffset, 3);
  f.screen.handleMouse({ x: 4, y, type: 'wheel', wheelDelta: 1 });
  assert.equal(f.state.focusedStepId, 'b');
});

test('resize, Unicode, theme and keyboard controls preserve drafts and leave readiness to admission', async () => {
  const f = await fixture();
  f.state.stage({ type: 'update_step', step_id: 'b', fields: { title: '中文 e\u0301 👩‍💻' } });
  f.state.setFocused('b');
  f.state.toggleSelection('b');
  const before = f.screen.render(120).join('\n');
  f.theme('light'); f.screen.invalidate();
  assert.notEqual(f.screen.render(120).join('\n'), before);
  // One layout matrix covers tiny overlays, the stacking boundary, and normal sizes.
  for (const width of [1, 20, 41, 42, 60, 80, 99, 100, 120, 160]) for (const height of [1, 10, 20, 24, 32, 42, 70]) {
    f.height(height);
    const lines = f.screen.render(width);
    assert.ok(lines.length <= Math.floor(height * .95), `${width}x${height}: ${lines.length}`);
    for (const line of lines) assert.ok(f.tui.visibleWidth(line) <= width);
  }
  assert.equal(f.state.focusedStepId, 'b');
  assert.deepEqual(f.state.selectedStepIds, ['b']);
  assert.equal(f.state.draftOperations.length, 1);
  assert.equal(f.state.plan.execution, undefined);
  f.height(42);
  f.state.toggleSelection('b'); f.state.setFocused('a');
  f.screen.handleInput('\x1b[B'); assert.equal(f.state.focusedStepId, 'b');
  f.screen.handleInput(' '); assert.deepEqual(f.state.selectedStepIds, ['b']);
  assert.deepEqual(f.actions, []);
  f.screen.handleInput('\r');
  assert.deepEqual(f.actions, [{ type: 'run', selectedStepIds: ['b'] }]);
  assert.match(f.state.selectionProblem(), /Missing prerequisite for b: a/);
  f.screen.handleInput('\x1b'); assert.equal(f.actions.at(-1).type, 'close');
  assert.equal(f.state.draftOperations.length, 1);
  assert.equal(f.state.plan.execution, undefined);
});

test('pasted command letters and focus sequences do not invoke actions', async () => {
  const f = await fixture();
  f.state.toggleSelection('a');
  for (const input of ['\x1b[200~\r\x1b[201~', 'rsf', '\x1b[I', '\x1b[O', '日本語', ...'rv?enmdxszgf[]qjk', '\t', '\x03']) f.screen.handleInput(input);
  assert.deepEqual(f.actions, []);
  assert.equal(f.state.plan.execution, undefined);
});

const agentRecord = (id, fields = {}) => ({ id, state: 'running', native_id: `native-${id}`,
  transcript_path: `/tmp/${id}.jsonl`, context_digest: 'digest', settled: false, ...fields });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });

test('agent monitor distinguishes live observation from restored unknown state and bounds logs', async () => {
  const [{ AgentActivityState }] = await loadUI();
  const state = new AgentActivityState(); let updates = 0;
  const off = state.subscribe(() => updates++);
  state.restore([agentRecord('restored')]);
  assert.equal(state.agents.get('restored').live, false);
  assert.match(state.agents.get('restored').activity, /Unknown/);
  state.event('restored', { type: 'message_update', message: assistant('must not claim live') });
  assert.equal(state.agents.get('restored').streaming, '');
  state.record(agentRecord('live'), true);
  state.event('live', { type: 'tool_execution_start', toolName: 'read', args: { path: '中文.ts' } });
  assert.equal(state.agents.get('live').activity, 'read 中文.ts');
  state.event('live', { type: 'message_update', message: { ...assistant('visible'), content: [
    { type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: 'visible' }] } });
  assert.equal(state.agents.get('live').streaming, 'visible');
  state.event('live', { type: 'message_end', message: assistant('\x1b[31mREPORT\x1b[0m') });
  assert.match(state.agents.get('live').log, /Assistant\nREPORT/);
  assert.doesNotMatch(state.agents.get('live').log, /PRIVATE_REASONING|\x1b/);
  state.event('live', { type: 'tool_execution_end', toolName: 'read', isError: true, result: { content: [{ type: 'text', text: 'x'.repeat(100000) }] } });
  assert.ok(state.agents.get('live').log.length <= 65536);
  assert.equal(state.agents.get('live').clipped, true);
  state.record(agentRecord('live', { state: 'failed', settled: true }), true);
  assert.equal(state.agents.get('live').live, false);
  assert.equal(state.agents.get('live').streaming, '');
  off(); const before = updates;
  state.event('live', { type: 'message_end', message: assistant('late') });
  assert.equal(updates, before);
});

test('Agents shows a rejected dispatch honestly, with its reason and no transcript lookup', async () => {
  const [{ AgentActivityState, AgentScreen }, tui] = await loadUI();
  const state = new AgentActivityState();
  state.restore([{ id: 'run-docs', title: 'Docs', state: 'rejected', native_id: '', transcript_path: '', context_digest: 'scope', settled: true,
    rejection: { code: 'outside_workspace', workspace: '/tmp/demo', path: '/repo/README.md' },
    limitation: 'Assigned file is outside the coordinator workspace. Path: /repo/README.md. Workspace: /tmp/demo.' }]);
  state.restoreLog('run-docs', '/must-not-be-read');
  const activity = state.agents.get('run-docs');
  assert.equal(activity.live, false); assert.match(activity.activity, /Not launched/);
  assert.match(activity.log, /Path: \/repo\/README.md/); assert.doesNotMatch(activity.log, /Transcript unavailable/);
  const theme = { fg: (_, text) => text, bg: (_, text) => text, bold: text => text };
  let actions = 0;
  const screen = new AgentScreen(state, theme, () => {}, () => 30, () => actions++);
  const rendered = screen.render(120).join('\n');
  assert.match(rendered, /rejected · Docs/); assert.match(rendered, /Not launched/);
  assert.match(rendered, /Workspace: \/tmp\/demo/);
  assert.doesNotMatch(rendered, /Waiting for.*activity|No assignments|Assignment settled|Transcript unavailable/);
  for (const width of [1, 20, 42, 60, 80, 120, 160]) {
    for (const line of screen.render(width)) assert.ok(tui.visibleWidth(line) <= width);
  }
  assert.equal(actions, 0);
});

test('agent transcript restoration is read-only, bounded and verifies native identity', async t => {
  const [{ AgentActivityState }] = await loadUI();
  const dir = scratch(t), child = path.join(dir, 'hyperion-agents', 'child'); fs.mkdirSync(child, { recursive: true });
  const file = path.join(child, 'agent.jsonl');
  const contents = [{ type: 'session', id: 'native-a' }, { type: 'message', message: assistant('Restored report') }].map(JSON.stringify).join('\n') + '\n';
  fs.writeFileSync(file, contents);
  const state = new AgentActivityState();
  state.restore([agentRecord('a', { transcript_path: file, state: 'succeeded', settled: true })]);
  state.restoreLog('a', dir);
  assert.match(state.agents.get('a').log, /Restored report/);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
  for (const [id, transcript_path] of [['wrong-id', file], ['outside', path.join(dir, 'outside.jsonl')]]) {
    fs.writeFileSync(path.join(dir, 'outside.jsonl'), contents);
    state.record(agentRecord(id, { transcript_path, state: 'succeeded', settled: true, report: 'Fallback evidence' }));
    state.restoreLog(id, dir);
    assert.match(state.agents.get(id).log, /Transcript unavailable/);
    assert.match(state.agents.get(id).log, /Fallback evidence/);
    assert.doesNotMatch(state.agents.get(id).log, /Restored report/);
  }
  const report = 'Evidence '.repeat(40000) + ' REPORT_END', large = path.join(child, 'large.jsonl');
  fs.writeFileSync(large, JSON.stringify({ type: 'session', id: 'native-large' }) + '\n' +
    JSON.stringify({ type: 'message', message: assistant(report) }) + '\n');
  state.record(agentRecord('large', { transcript_path: large, state: 'succeeded', settled: true, report }));
  state.restoreLog('large', dir);
  assert.ok(state.agents.get('large').log.length <= 65536);
  assert.match(state.agents.get('large').log, /REPORT_END/);
  assert.equal(state.agents.get('large').clipped, true);
});

test('coordinator agent screen has split panes, keyboard selection, log follow and narrow layouts', async () => {
  const [{ AgentActivityState, AgentScreen }, tui] = await loadUI();
  const state = new AgentActivityState(), theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  state.record(agentRecord('first', { title: 'Inspect 中文.ts' }), true);
  state.record(agentRecord('second', { state: 'succeeded', settled: true }));
  for (let i = 0; i < 60; i++) state.event('first', { type: 'message_end', message: assistant(`line-${i} 中文 👩‍💻`) });
  let rows = 30, closes = 0;
  const screen = new AgentScreen(state, theme, () => {}, () => rows, () => closes++);
  assert.match(screen.render(120).join('\n'), /Agents.*│ Logs/);
  assert.match(screen.render(120).join('\n'), /running · Inspect/);
  assert.match(screen.render(120).join('\n'), /succeeded · second/);
  screen.handleInput('\x1b[B'); // select first
  assert.match(screen.render(120).join('\n'), /Inspect 中文/);
  assert.match(screen.render(120).join('\n'), /line-59/);
  screen.handleInput('\t'); screen.handleInput('\x1b[H');
  const top = screen.render(120).join('\n');
  assert.match(top, /line-0 /); assert.doesNotMatch(top, /line-59/);
  state.event('first', { type: 'message_end', message: assistant('new event') });
  assert.doesNotMatch(screen.render(120).join('\n'), /new event/);
  screen.handleInput('\x1b[F'); assert.match(screen.render(120).join('\n'), /new event/);
  for (const width of [1, 20, 42, 79, 80, 120, 160]) for (rows of [1, 10, 20, 45]) {
    const lines = screen.render(width);
    assert.ok(lines.length <= Math.max(1, Math.floor(rows * .95)));
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width), `${width}x${rows}`);
  }
  screen.handleInput('\x1b[200~q\x1b[201~'); assert.equal(closes, 0);
  screen.handleInput('\x1b'); assert.equal(closes, 1);
});

test('single /hyperion command navigates A to agents and B back without losing selection or drafts', async t => {
  const [{ AgentScreen }, , extensionModule] = await loadUI();
  const dir = scratch(t), { planPath } = savedPlan(dir), snapshot = await core.loadPlanSnapshot(planPath);
  const entries = [{ type: 'custom', customType: 'hyperion-plan.draft', data: {
    path: planPath, plan_id: snapshot.plan.plan_id, base_revision: snapshot.plan.revision,
    base_digest: snapshot.source_digest, base_plan: snapshot.plan,
    operations: [{ type: 'update_step', step_id: 'a', fields: { title: 'Draft first step' } }],
  } }], before = fs.readFileSync(planPath, 'utf8'), screens = [];
  let command;
  const pi = { on() { return () => {}; }, registerTool() {}, registerMessageRenderer() {},
    registerCommand(name, value) { assert.equal(name, 'hyperion'); command = value; },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    sendUserMessage() { assert.fail('Navigation must not start coordinator work'); } };
  extensionModule.default(pi);
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  await command.handler(planPath, { cwd: dir, mode: 'tui', isIdle: () => false,
    sessionManager: { getSessionId: () => 'coordinator', getSessionDir: () => dir, getBranch: () => entries, getEntries: () => entries },
    ui: { notify() {}, custom: async factory => {
      let result;
      const screen = factory({ terminal: { rows: 42 }, requestRender() {} }, theme, {}, action => { result = action; });
      const rendered = screen.render(120).join('\n'); screens.push(rendered);
      if (screens.length === 1) { screen.handleInput(' '); screen.handleInput('A'); }
      else if (screen instanceof AgentScreen) { assert.match(rendered, /\[B\] Back/); screen.handleInput('B'); }
      else {
        assert.match(rendered, /\[x\].*Draft first step/);
        assert.match(rendered, /UNSAVED EDITS/);
        screen.handleInput('\x1b');
      }
      return result;
    } } });
  assert.equal(screens.length, 3);
  assert.match(screens[0], /HYPERION\s+\/\s+PLAN/); assert.match(screens[1], /HYPERION\s+\/\s+AGENTS/);
  assert.equal(fs.readFileSync(planPath, 'utf8'), before);
  assert.equal((await core.loadPlanSnapshot(planPath)).plan.execution, undefined);
  assert.equal(entries.filter(e => e.customType === 'hyperion-plan.draft').length, 1);
});

test('agent view opens while coordinator is busy and closes on session navigation without launching work', async () => {
  const [{ registerAgentView }] = await loadUI();
  const commands = new Map(), shortcuts = new Map(), handlers = new Map(); let launches = 0, renders = 0, component, complete;
  const pi = { registerCommand: (name, c) => commands.set(name, c), registerShortcut: (key, s) => shortcuts.set(key, s),
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); }, registerTool() { launches++; } };
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  const ctx = { mode: 'tui', isIdle: () => false,
    sessionManager: { getSessionId: () => 'coordinator', getSessionDir: () => '/tmp', getEntries: () => [] },
    ui: { notify() {}, setStatus() {}, custom(factory) { return new Promise(resolve => {
      component = factory({ terminal: { rows: 35 }, requestRender: () => renders++ }, theme, {}, () => resolve());
      complete = resolve;
    }); } } };
  const observer = registerAgentView(pi);
  observer.record(ctx, agentRecord('live'));
  assert.equal(commands.size, 0); assert.equal(shortcuts.size, 0);
  const opening = observer.open(ctx);
  assert.ok(component); component.render(120);
  observer.event(ctx, 'live', { type: 'message_update', message: assistant('Streaming now') });
  assert.match(component.render(120).join('\n'), /Streaming now/);
  assert.ok(renders > 0);
  assert.equal(launches, 0);
  handlers.get('session_before_switch')(); await opening;
  const before = renders; observer.event(ctx, 'live', { type: 'message_end', message: assistant('later') });
  assert.equal(renders, before, 'closed screen has no event subscriber');
  const notifications = [];
  await observer.open({ mode: 'json', ui: { notify: text => notifications.push(text) } });
  assert.match(notifications[0], /interactive TUI/);
});
}

// The terminal driver can be imported without Playwright or starting a browser.
// Fault injection exercises its cleanup only; no process or fixture files exist.
{
const workflow = require('./pi/terminal-workflow.cjs');
test('terminal workflow deadlines bound a stalled async check and preserve check errors/results', async () => {
  await assert.rejects(workflow.until(() => new Promise(() => {}), 'stalled check', 20), /Timed out: stalled check/);
  await workflow.until(() => true, 'ready');
  const error = new Error('check failed');
  await assert.rejects(workflow.until(() => { throw error; }, 'failed check'), e => e === error);
  assert.equal(await workflow.bounded(() => 42, 'result'), 42);
});

function workflowFault(fault) {
  const { EventEmitter } = require('node:events'), vm = require('node:vm');
  const observed = { signals: [], logClosed: 0, pageClosed: 0, diagnostics: [] };
  const server = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter() });
  const original = new Error(`simulated ${fault}`);
  const page = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    goto: async () => { throw original; }, evaluate: async () => [],
    screenshot: () => fault === 'stalled diagnostics' ? new Promise(() => {}) : Promise.resolve(),
    close() {
      observed.pageClosed++;
      if (fault === 'page close') throw new Error('close failed');
      return fault === 'stalled page close' ? new Promise(() => {}) : Promise.resolve();
    } };
  const browser = { async newPage() {
    if (fault === 'page creation') throw original;
    server.stdout.emit('data', 'Listening on port: 1234'); return page;
  } };
  const stubFs = { mkdirSync() {}, writeFileSync() {}, openSync: () => 1, writeSync() {},
    closeSync() { observed.logClosed++; } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'pi/terminal-workflow.cjs'), 'utf8'), {
    module, __dirname: path.join(__dirname, 'pi'),
    // Shorten driver deadlines, not the production values or the real timer test.
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimeout,
    console: { log() {}, error(...args) { observed.diagnostics.push(args); } },
    process: { env: {}, execPath: process.execPath, kill(pid, signal) {
      assert.equal(pid, -server.pid); observed.signals.push(signal);
      if (fault !== 'forced kill' || signal === 'SIGKILL') server.signalCode = signal;
    } },
    require(name) {
      if (name === 'node:fs') return stubFs;
      if (name === 'node:child_process') return { spawn() { if (fault === 'spawn') throw original; return server; } };
      if (name === '../../dist/index.cjs') return { initialize: p => p, saveMarkdown() {} };
      return require(name);
    },
  });
  return { observed, original, server, run: () => module.exports.scenario(browser, 'regular', 'dark', 1400, '/virtual-workflow') };
}
for (const fault of ['spawn', 'page creation', 'page close', 'stalled page close', 'stalled diagnostics', 'forced kill']) {
  test(`terminal workflow ${fault} failure closes logs and processes without masking the original error`, async () => {
    const f = workflowFault(fault);
    await assert.rejects(f.run(), e => e === f.original);
    assert.equal(f.observed.logClosed, 1);
    assert.deepEqual(f.observed.signals, fault === 'spawn' ? [] : fault === 'forced kill' ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM']);
    assert.equal(f.observed.pageClosed, ['spawn', 'page creation'].includes(fault) ? 0 : 1);
    assert.equal(f.server.stdout.listenerCount('data'), 0); assert.equal(f.server.stderr.listenerCount('data'), 0);
    if (['page close', 'stalled page close'].includes(fault)) assert.equal(f.observed.diagnostics.length, 1);
  });
}
}
