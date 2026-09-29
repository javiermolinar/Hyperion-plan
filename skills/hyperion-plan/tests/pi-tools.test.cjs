const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../dist/index.cjs");

async function harness(t, mode = "tui") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyperion-pi-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, "plan.md");
  const plan = core.initialize({ title: "Tool plan", steps: [
    { id: "a", title: "First", status: "pending", reasoning_effort: "medium" },
    { id: "b", title: "Second", status: "pending", depends_on: ["a"] },
  ] });
  core.saveMarkdown(planPath, plan);
  const entries = [], notifications = [], events = new Map(), handlers = new Map(), screens = [], messages = [];
  let tool, idle = false, session = "tool-session", counter = 0;
  const pi = {
    registerCommand(_name, value) { this.command = value; },
    registerTool(value) { tool = value; },
    registerMessageRenderer() {},
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      const list = handlers.get(name); list.push(handler);
      events.set(name, async (...args) => { for (const fn of [...list]) await fn(...args); });
      return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
    },
    sendMessage(message, options) {
      assert.deepEqual(options, { triggerTurn: false });
      messages.push(message);
      entries.push({ type: 'custom_message', ...message });
    },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage() { assert.fail("Plan management must not submit implementation work"); },
  };
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  const ctx = {
    cwd: dir, mode, isIdle: () => idle,
    sessionManager: { getSessionId: () => session, getBranch: () => entries },
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      input: () => assert.fail("Prompt tools must not ask for paths through a dialog"),
      confirm: () => assert.fail("Prompt tools must not create implicitly"),
      custom: async factory => {
        const screen = factory({ requestRender() {}, terminal: { rows: 42 } }, theme, {}, () => {});
        screens.push(screen.render(120).join("\n"));
        return { type: "close" };
      },
    },
  };
  (await import("../dist/hyperion-plan-pi.js")).default(pi);
  return {
    dir, planPath, plan, entries, notifications, events, screens, messages, ctx, tool, command: pi.command,
    setIdle: value => { idle = value; },
    call: (params, signal, id = `call-${++counter}`) => tool.execute(id, params, signal, undefined, ctx),
    read: () => core.loadPlanSnapshot(planPath),
    setSession: value => { session = value; },
    settle: async () => {
      idle = true;
      await events.get("agent_settled")({}, ctx);
      // The UI is intentionally detached from the settlement event promise.
      await new Promise(resolve => setTimeout(resolve, 20));
    },
  };
}
function mutation(snapshot, fields = {}) {
  return { action: "edit", path: snapshot.path, plan_id: snapshot.plan.plan_id,
    base_revision: snapshot.plan.revision, operations: JSON.stringify([
      { type: "update_step", step_id: "a", fields: { title: "Renamed" } },
    ]), ...fields };
}

test("registers a discoverable sequential tool; show is read-only and supports focused steps", async t => {
  const h = await harness(t);
  assert.equal(h.tool.name, "hyperion_plan");
  assert.equal(h.tool.executionMode, "sequential");
  const files = [h.planPath, core.markdownStatePath(h.planPath)];
  const before = files.map(file => fs.readFileSync(file));
  const shown = await h.call({ action: "show", path: "plan.md" });
  assert.equal(shown.details.plan_id, h.plan.plan_id);
  assert.equal(shown.details.path, h.planPath);
  const focused = await h.call({ action: "show", path: "plan.md", step_id: "a" });
  assert.equal(focused.details.step.id, "a");
  assert.equal(focused.details.plan, undefined);
  await assert.rejects(h.call({ action: "show", path: "plan.md", step_id: "absent" }), /absent/);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
  assert.deepEqual(h.entries, []);
});

test("open binds the selected plan and opens an editable screen only after settlement", async t => {
  const h = await harness(t);
  const opened = await h.call({ action: "open", path: "plan.md" });
  assert.equal(opened.details.screen, "queued");
  assert.equal(h.screens.length, 0);
  assert.equal(h.entries.at(-1).data.path, h.planPath);
  assert.equal((await h.call({ action: "show" })).details.plan_id, h.plan.plan_id);
  assert.equal((await h.read()).plan.execution, undefined);
  await h.settle();
  assert.equal(h.screens.length, 1);
  assert.doesNotMatch(h.screens[0], /VIEW ONLY|Pi busy/);
  assert.equal((await h.read()).plan.execution, undefined);
  await h.settle();
  assert.equal(h.screens.length, 1);
});

test("an empty workspace and missing explicit paths fail without creating files", async t => {
  const h = await harness(t);
  fs.rmSync(h.planPath); fs.rmSync(core.markdownStatePath(h.planPath));
  await assert.rejects(h.call({ action: "open" }), /No compatible active Hyperion plan/);
  await assert.rejects(h.call({ action: "open", path: "missing.md" }), /ENOENT/);
  await assert.rejects(h.call({ action: "open", path: "  " }), /blank/);
  assert.equal(fs.existsSync(path.join(h.dir, "missing.md")), false);
  assert.deepEqual(h.entries, []);
});

test("non-TUI open reports the limitation; show and edits remain usable", async t => {
  for (const mode of ["rpc", "json", "print"]) {
    const h = await harness(t, mode);
    assert.equal((await h.call({ action: "open", path: "plan.md" })).details.screen, "unavailable");
    const saved = await h.call(mutation(await h.read(), { path: undefined }));
    assert.equal(saved.details.plan.steps[0].title, "Renamed");
    await h.settle();
    assert.equal(h.screens.length, 0);
  }
});

test("edits use exact revision checks, durable retry receipts and no execution approval", async t => {
  const h = await harness(t);
  const request = mutation(await h.read(), { request_id: "stable-edit" });
  const result = await h.call(request);
  assert.equal(result.details.changed, true);
  assert.equal(result.details.plan.steps[0].title, "Renamed");
  assert.equal(result.details.plan.execution, undefined);
  assert.match(fs.readFileSync(core.notesPath(h.planPath), "utf8"), /Renamed/);
  const retried = await h.call(request);
  assert.equal(retried.details.changed, false);
  assert.equal(retried.details.revision, result.details.revision);
  await assert.rejects(h.call({ ...request, request_id: "stale-edit" }), /Stale plan/);
  await assert.rejects(h.call({ ...request, operations: JSON.stringify([{ type: "remove_step", step_id: "b" }]) }), /reused/);
  await assert.rejects(h.call({ action: "edit", path: h.planPath, operations: request.operations }), /plan_id and base_revision/);
});

test("core rejects invalid edits and preserves prerequisites and ownership", async t => {
  const h = await harness(t);
  let snapshot = await h.read();
  const before = fs.readFileSync(h.planPath);
  for (const operations of ["bad JSON", "{}", "[]", '[{"type":"remove_step","step_id":"a"}]',
    '[{"type":"update_step","step_id":"a","fields":{"status":"completed"}}]']) {
    await assert.rejects(h.call(mutation(snapshot, { operations })));
    assert.deepEqual(fs.readFileSync(h.planPath), before);
  }
  snapshot.plan.execution_owner = "someone-else";
  core.saveMarkdown(h.planPath, snapshot.plan);
  await assert.rejects(h.call(mutation(await h.read())), /belongs to task someone-else/);
  assert.equal((await h.read()).plan.steps[0].title, "First");
});

test("scope edits preserve partial progress while revoking changed approval", async t => {
  const h = await harness(t);
  let plan = h.plan;
  [plan] = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision,
    request_id: "prior-run", intent: "implement", operations: [], selected_step_ids: ["a", "b"] });
  [plan] = core.checkpoint(plan, plan.revision, "a", "in_progress", "Observed partial work");
  core.saveMarkdown(h.planPath, plan);
  const result = await h.call(mutation(await h.read()));
  assert.equal(result.details.plan.steps[0].status, "in_progress");
  assert.equal(result.details.plan.steps[0].progress_note, "Observed partial work");
  assert.deepEqual(result.details.plan.execution.selected_step_ids, ["b"]);
});

test("finish and reopen preserve work and never restore implementation approval", async t => {
  const h = await harness(t);
  const finished = await h.call(mutation(await h.read(), { action: "finish", operations: undefined }));
  assert.equal(finished.details.plan.lifecycle, "finished");
  assert.equal(finished.details.plan.steps.length, 2);
  await assert.rejects(h.call(mutation(await h.read())), /finished/);
  const opened = await h.call(mutation(await h.read(), { action: "reopen", operations: undefined }));
  assert.equal(opened.details.plan.lifecycle, "active");
  assert.ok(!opened.details.plan.execution?.selected_step_ids?.length);
  assert.equal(h.screens.length, 0);
});

test("create requires an explicit new Markdown path, adds no tasks and binds it", async t => {
  const h = await harness(t);
  await assert.rejects(h.call({ action: "create", path: "new.md" }), /title/);
  await assert.rejects(h.call({ action: "create", path: "new.json", title: "New" }), /\.md/);
  await assert.rejects(h.call({ action: "create", path: "plan.md", title: "Overwrite" }), /already exists/);
  const created = await h.call({ action: "create", path: "new.md", title: "New" });
  assert.deepEqual(created.details.plan.steps, []);
  assert.equal(created.details.plan.execution, undefined);
  assert.equal((await h.call({ action: "show" })).details.path, path.join(h.dir, "new.md"));
  await assert.rejects(h.call({ action: "create", title: "No explicit path" }), /explicit/);
});

test("abort, session changes and shutdown discard queued openings", async t => {
  for (const action of ["abort", "session_start", "session_tree", "session_shutdown", "identity"]) {
    const h = await harness(t), controller = new AbortController();
    await h.call({ action: "open", path: "plan.md" }, controller.signal);
    if (action === "abort") controller.abort();
    else if (action === "identity") h.setSession("another-session");
    else await h.events.get(action)({}, h.ctx);
    await h.settle();
    assert.equal(h.screens.length, 0, action);
  }
  const h = await harness(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(h.call(mutation(await h.read()), controller.signal), /abort/i);
  assert.equal((await h.read()).plan.steps[0].title, "First");
});

test("replaced bound paths cannot silently open or mutate a different plan", async t => {
  const h = await harness(t);
  await h.call({ action: "open", path: "plan.md" });
  fs.rmSync(h.planPath);
  fs.rmSync(core.markdownStatePath(h.planPath));
  const replacement = core.initialize({ title: "Replacement", steps: [] });
  core.saveMarkdown(h.planPath, replacement);
  await assert.rejects(h.call({ action: "show" }), /different plan/);
  await assert.rejects(h.call({ action: "finish", plan_id: replacement.plan_id, base_revision: replacement.revision }), /different plan/);
  await h.settle();
  assert.equal(h.screens.length, 0);
  assert.ok(h.notifications.some(item => /Specify the path explicitly/.test(item.message)));
});

test("canonical tool edits preserve unsent UI drafts and surface stale conflicts", async t => {
  const h = await harness(t), snapshot = await h.read();
  h.entries.push({ type: "custom", customType: "hyperion-plan.draft", data: {
    path: h.planPath, plan_id: h.plan.plan_id, base_revision: h.plan.revision,
    base_digest: snapshot.source_digest, base_plan: h.plan,
    operations: [{ type: "update_step", step_id: "a", fields: { title: "Unsent UI draft" } }],
  } });
  await h.call(mutation(snapshot));
  await h.call({ action: "open", path: "plan.md" });
  await h.settle();
  assert.match(h.screens[0], /STALE DRAFT/);
  assert.match(h.screens[0], /Unsent UI draft/);
  assert.equal((await h.read()).plan.steps[0].title, "Renamed");
});

test('inline progress observes canonical changes without focus, duplicates, or execution authority', async t => {
  const h = await harness(t, 'json');
  await h.call({ action: 'open', path: 'plan.md' });
  const observe = () => h.events.get('tool_result')({}, h.ctx);
  await observe();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].content, /0\/2 complete/);
  assert.match(h.messages[0].content, /No implementation approved/);
  await observe();
  await h.events.get('session_start')({}, h.ctx);
  await observe();
  assert.equal(h.messages.length, 1, 'restoration must not repeat the same snapshot');
  let plan = (await h.read()).plan;
  [plan] = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision,
    request_id: 'test-approval', intent: 'implement', operations: [], selected_step_ids: ['a'] });
  [plan] = core.checkpoint(plan, plan.revision, 'a', 'in_progress', 'Test work started');
  core.saveMarkdown(h.planPath, plan);
  const before = fs.readFileSync(h.planPath);
  await observe();
  assert.match(h.messages.at(-1).content, /In progress: First/);
  assert.deepEqual(fs.readFileSync(h.planPath), before);
  [plan] = core.checkpoint(plan, plan.revision, 'a', 'completed', 'Test completion evidence');
  core.saveMarkdown(h.planPath, plan);
  await h.events.get('turn_end')({}, h.ctx);
  assert.match(h.messages.at(-1).content, /1\/2 complete/);
  assert.match(h.messages.at(-1).content, /Next candidate: Second/);
  const count = h.messages.length;
  await h.call(mutation(await h.read(), { action: 'finish', operations: undefined }));
  await observe();
  assert.equal(h.messages.length, count, 'finished plan stays quiet');
  assert.equal(h.screens.length, 0);
});

test('overlay opened while busy becomes editable after settlement and retains local selection', async t => {
  const h = await harness(t);
  let screen, close;
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  h.ctx.ui.custom = factory => new Promise(resolve => {
    close = resolve;
    screen = factory({ requestRender() {}, terminal: { rows: 42 } }, theme, {}, resolve);
  });
  const opened = h.command.handler(h.planPath, h.ctx);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(screen.render(120).join('\n'), /VIEW ONLY/);
  await h.settle();
  assert.doesNotMatch(screen.render(120).join('\n'), /VIEW ONLY/);
  screen.handleInput(' ');
  assert.match(screen.render(120).join('\n'), /1 selected/);
  assert.equal((await h.read()).plan.execution, undefined);
  h.setIdle(false);
  await h.events.get('agent_start')({}, h.ctx);
  assert.match(screen.render(120).join('\n'), /VIEW ONLY/);
  close({ type: 'close' });
  await opened;
});

test("tool rejects execution actions and irrelevant mutation fields", async t => {
  const h = await harness(t);
  for (const params of [
    { action: "implement", path: "plan.md" },
    { action: "open", path: "plan.md", operations: "[]" },
    { action: "show", path: "plan.md", base_revision: 1 },
    { action: "finish", path: "plan.md", step_id: "a" },
  ]) await assert.rejects(h.call(params));
  assert.equal((await h.read()).plan.execution, undefined);
});
