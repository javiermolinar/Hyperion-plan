const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const core = require('../dist/index.cjs');
const theme = { fg: (_role, text) => text };
let loaded;
function modules() {
  return loaded ??= (async () => {
    const requirePi = createRequire(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'));
    const tuiPath = requirePi.resolve('@earendil-works/pi-tui');
    const { createJiti } = await import(pathToFileURL(requirePi.resolve('jiti')).href);
    const jiti = createJiti(pathToFileURL(__filename).href, { alias: { '@earendil-works/pi-tui': tuiPath } });
    return [await jiti.import(path.resolve(__dirname, '../src/pi/footer.ts')), await import(pathToFileURL(tuiPath).href),
      await jiti.import(path.resolve(__dirname, '../src/pi/ui.ts'))];
  })();
}
function plan() { return core.initialize({ title: 'Improve plan tracking', steps: [
  { id: '01', title: 'Inspect UI', status: 'completed' },
  { id: '02', title: 'Implement footer', status: 'in_progress' },
  { id: '03', title: 'Verify rendering', status: 'pending', depends_on: ['02'] },
] }); }

test('footer shows plan, current step, step-based progress and live agents without timing placeholders', async () => {
  const [{ PlanFooter }] = await modules();
  const footer = new PlanFooter(); footer.plan = plan();
  footer.agents = { active: 2, unknown: 1 };
  const text = footer.render(160, theme).join('\n');
  assert.match(text, /Improve plan tracking/); assert.match(text, /\[███░{7}\] 1\/3/);
  assert.match(text, /Current 02 Implement footer/);
  assert.doesNotMatch(text, /ETA|◷|Elapsed/); assert.match(text, /2 agents/);
  assert.match(text, /1 unknown/); assert.match(text, /1 blocker/); assert.match(text, /unknown settlement/);
});

test('footer is width-safe and strips control sequences from untrusted plan content', async () => {
  const [{ PlanFooter }, { visibleWidth }] = await modules();
  const footer = new PlanFooter(); footer.plan = plan();
  footer.plan.title = '\x1b]8;;https://evil.example\x07計画 🧑‍💻 é ' + 'Long name '.repeat(20) + '\x1b]8;;\x07';
  footer.plan.steps[1].title = '\x1b[31mWide 界\x1b[0m\r\nInjected';
  footer.plan.steps[1].blocked_by = 'Need production access'; footer.agents = { active: 3, unknown: 1 };
  for (const width of [0, 1, 12, 32, 48, 80, 120, 180]) {
    const lines = footer.render(width, theme);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width);
      assert.doesNotMatch(line.replace(/\x1b\[0m/g, ''), /[\x1b\r\n]/);
    }
    if (width >= 32) { assert.match(lines.join('\n'), /3 agents/); assert.match(lines.join('\n'), /2 blockers/); }
  }
});

test('status strip fits one wide row, two standard rows, and preserves progress at narrow widths', async () => {
  const [{ PlanFooter }, { visibleWidth }] = await modules(); const footer = new PlanFooter(); footer.plan = plan();
  assert.equal(footer.render(120, theme).length, 1);
  assert.equal(footer.render(80, theme).length, 2);
  for (const width of [32, 48, 80, 120]) {
    const lines = footer.render(width, theme);
    assert.match(lines.join('\n'), /1\/3/);
    assert.match(lines.join('\n'), /\[[█░]+\] 1\/3/);
    assert.doesNotMatch(lines.join('\n'), /ETA|◷/);
    assert.match(lines.join('\n'), /0 agents/);
    assert.match(lines.join('\n'), /No blockers/);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
});

test('progress bar handles empty, pending, partial and completed plans without counting in-progress steps', async () => {
  const [{ PlanFooter }] = await modules(); const footer = new PlanFooter();
  for (const [completed, total] of [[0, 0], [0, 5], [1, 5], [3, 5], [5, 5], [29, 30]]) {
    footer.plan = core.initialize({ title: 'Progress', steps: Array.from({ length: total }, (_, i) => ({
      id: `s${i}`, title: `Step ${i}`, status: i < completed ? 'completed' : i === completed ? 'in_progress' : 'pending',
    })) });
    const text = footer.render(160, theme).join('\n');
    const filled = total ? Math.floor(completed / total * 10) : 0;
    assert.ok(text.includes(`[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${completed}/${total}`), text);
    assert.doesNotMatch(text, /NaN|Infinity|ETA|◷/);
  }
});

test('status strip recalculates semantic colors for light/dark themes without caching old styles', async () => {
  const [{ PlanFooter }, { visibleWidth }] = await modules(); const footer = new PlanFooter(); footer.plan = plan();
  const colors = [], themed = color => ({ fg(role, text) { colors.push(role); return `\x1b[${color}m${text}\x1b[0m`; } });
  const dark = footer.render(120, themed(34)).join('\n');
  const light = footer.render(120, themed(35)).join('\n');
  assert.notEqual(dark, light);
  assert.equal(dark.replace(/\x1b\[[0-9;]*m/g, ''), light.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(visibleWidth(dark) <= 120); assert.ok(visibleWidth(light) <= 120);
  for (const role of ['accent', 'text', 'muted', 'dim', 'success']) assert.ok(colors.includes(role));
});

test('tool receipts use an unboxed single-line summary and retain expanded details and failures', async () => {
  const [, , { planToolPresentation: presentation }] = await modules();
  const themed = { ...theme, fg: (role, text) => text, bg() { assert.fail('No tool background box'); } };
  assert.equal(presentation.renderShell, 'self');
  const context = { isPartial: false, expanded: false, isError: false };
  assert.deepEqual(presentation.renderCall({ action: 'open', path: '/tmp/demo.md' }, themed, context).render(120), []);
  const result = { content: [{ type: 'text', text: '{"screen":"queued"}' }], details: {
    action: 'open', screen: 'queued', revision: 2, summary: { title: 'Demo' },
  } };
  const summary = presentation.renderResult(result, { expanded: false, isPartial: false }, themed, context).render(120);
  assert.equal(summary.length, 1); assert.match(summary[0], /Hyperion.*open.*Demo.*r2.*overlay queued/);
  assert.match(presentation.renderResult(result, { expanded: true }, themed, context).render(120).join('\n'), /"screen":"queued"/);
  const failure = { content: [{ type: 'text', text: 'Revision conflict. Read the current plan.' }], details: {} };
  assert.match(presentation.renderResult(failure, { expanded: false }, themed, { ...context, isError: true }).render(120).join('\n'), /Revision conflict/);
  const call = presentation.renderCall({ action: 'edit' }, themed, { ...context, isPartial: true }).render(120);
  assert.match(call.join('\n'), /Hyperion.*edit/);
});

test('blockers include reasons, dependency stalls, blocked reviews and handovers, but not completed blockers', async () => {
  const [{ PlanFooter }] = await modules(); const footer = new PlanFooter(); footer.plan = plan();
  footer.plan.steps[0].blocked_by = 'Historical blocker';
  footer.plan.steps[1].blocked_by = 'Need timed access';
  let text = footer.render(120, theme).join('\n');
  assert.match(text, /1 blocker/); assert.match(text, /! 02: Need timed access/); assert.doesNotMatch(text, /Historical/);
  footer.plan.steps[1].status = 'pending'; delete footer.plan.steps[1].blocked_by;
  footer.plan.execution = { request_id: 'run', state: 'approved', selected_step_ids: ['03'] };
  text = footer.render(120, theme).join('\n'); assert.match(text, /waiting for 02/);
  footer.plan.plan_reviews = [{ state: 'blocked', note: 'Reviewer unavailable' }];
  footer.plan.handovers = [{ state: 'blocked', note: 'Destination unavailable' }];
  assert.match(footer.render(120, theme).join('\n'), /3 blockers/);
});

test('paused, cancelled, empty, finished and unavailable plans never imply active execution', async () => {
  const [{ PlanFooter }] = await modules(); const footer = new PlanFooter(); footer.plan = plan();
  for (const state of ['paused', 'cancelled']) {
    footer.plan.execution = { state, request_id: 'run', selected_step_ids: ['02'] };
    assert.match(footer.render(100, theme).join('\n'), new RegExp(state, 'i'));
    assert.doesNotMatch(footer.render(100, theme).join('\n'), /Current/);
  }
  footer.plan.steps = []; delete footer.plan.execution;
  assert.match(footer.render(100, theme).join('\n'), /No steps yet/);
  footer.plan.lifecycle = 'finished'; assert.deepEqual(footer.render(100, theme), []);
  footer.agents = { active: 0, unknown: 1 }; assert.match(footer.render(100, theme).join('\n'), /1 unknown/);
  footer.error = 'Cannot read plan'; assert.match(footer.render(100, theme).join('\n'), /Plan unavailable/);
});

async function harness(t, mode = 'tui') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-footer-'));
  const file = path.join(dir, 'plan.md'); const saved = plan(); core.saveMarkdown(file, saved);
  let session = 'one'; const entries = [], handlers = new Map(), widgets = new Map(); let updates = 0;
  const pi = {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return () => {}; },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
    sendMessage() { assert.fail('No progress transcript messages'); }, sendUserMessage() { assert.fail('No turns'); },
  };
  const ctx = { cwd: dir, mode, sessionManager: { getSessionId: () => session, getBranch: () => entries }, ui: {
    setFooter() { assert.fail('Must preserve the native footer'); },
    setWidget(key, factory, options) {
      widgets.get(key)?.dispose?.();
      if (factory) {
        assert.deepEqual(options, { placement: 'aboveEditor' });
        widgets.set(key, factory({ requestRender() { updates++; } }, theme));
      } else widgets.delete(key);
    },
  } };
  (await import('../dist/hyperion-plan-pi.js')).default(pi);
  const emit = async name => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
  t.after(async () => { await emit('session_shutdown'); fs.rmSync(dir, { recursive: true, force: true }); });
  entries.push({ type: 'custom', customType: 'hyperion-plan.binding', data: { path: file, plan_id: saved.plan_id } });
  return { file, saved, entries, ctx, emit, widgets, text: () => widgets.get('hyperion-plan')?.render(120).join('\n') ?? '',
    session: id => { session = id; }, updates: () => updates };
}

test('restored binding paints immediately, progress follows canonical completion and shutdown clears', async t => {
  const h = await harness(t); const before = fs.readFileSync(h.file), entries = structuredClone(h.entries);
  await h.emit('session_start'); assert.match(h.text(), /Improve plan tracking/);
  assert.match(h.text(), /\[███░{7}\] 1\/3/);
  await h.emit('tool_result'); await h.emit('session_start');
  assert.deepEqual(h.entries, entries); assert.deepEqual(fs.readFileSync(h.file), before);
  h.saved.steps[1].status = 'completed'; core.saveMarkdown(h.file, h.saved);
  await h.emit('turn_end'); assert.match(h.text(), /\[█{6}░{4}\] 2\/3/);
  assert.deepEqual(h.entries, entries);
  await h.emit('session_shutdown'); assert.equal(h.widgets.size, 0);
});

test('replacement and missing bound files clear stale data rather than adopting another plan', async t => {
  const h = await harness(t); await h.emit('session_start');
  fs.rmSync(h.file); fs.rmSync(core.markdownStatePath(h.file));
  const replaced = plan(); replaced.title = 'Replacement plan'; core.saveMarkdown(h.file, replaced);
  await h.emit('tool_result'); assert.match(h.text(), /Plan unavailable/);
  assert.doesNotMatch(h.text(), /Improve plan tracking|Replacement plan/);
  fs.rmSync(h.file); await h.emit('tool_result'); assert.match(h.text(), /Plan unavailable/);
});

test('session and branch changes clear old footer state; restored assignments are unknown, not running', async t => {
  const h = await harness(t); await h.emit('session_start');
  h.entries.push({ type: 'custom', customType: 'hyperion.agent', data: { id: 'old', state: 'running', settled: false,
    native_id: 'worker', transcript_path: '/not-read', started_at: 1000 } });
  await h.emit('session_start'); await h.emit('session_tree'); assert.match(h.text(), /0 agents.*1 unknown/);
  h.entries.length = 0; h.session('two'); await h.emit('session_start'); assert.equal(h.text(), '');
});

test('agent footer counts update on launch/settlement and keep live observation across branch navigation', async () => {
  const [, , { registerAgentView }] = await modules();
  const handlers = new Map(), counts = [], entries = [];
  const pi = { on(name, fn) { handlers.set(name, fn); return () => {}; } };
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => 'coordinator', getBranch: () => entries } };
  const view = registerAgentView(pi, (_ctx, next) => counts.push(next));
  handlers.get('session_start')({}, ctx);
  const record = id => ({ id, state: 'running', settled: false, native_id: id, transcript_path: '/not-read' });
  view.record(ctx, record('one')); view.record(ctx, record('two'));
  assert.deepEqual(counts.at(-1), { active: 2, unknown: 0 });
  handlers.get('session_tree')({}, ctx);
  assert.deepEqual(counts.at(-1), { active: 2, unknown: 0 });
  view.record(ctx, { ...record('one'), state: 'succeeded', settled: true });
  assert.deepEqual(counts.at(-1), { active: 1, unknown: 0 });
  view.record(ctx, { ...record('two'), state: 'unknown' });
  assert.deepEqual(counts.at(-1), { active: 0, unknown: 1 });
});

test('legacy clock entries are retained but ignored; status tracking needs no timers or new entries', async t => {
  const h = await harness(t);
  h.entries.push({ type: 'custom', customType: 'hyperion-plan.observed-clock', data: {
    key: `${h.file}\0${h.saved.plan_id}\0unselected`, started_at: 1000,
  } });
  const before = structuredClone(h.entries);
  t.mock.method(global, 'setInterval', () => assert.fail('Step progress must not poll or start a clock'));
  await h.emit('session_start'); await h.emit('tool_result'); await h.emit('turn_end');
  assert.match(h.text(), /\[███░{7}\] 1\/3/);
  assert.doesNotMatch(h.text(), /ETA|◷|Elapsed/);
  assert.deepEqual(h.entries, before);
});

for (const mode of ['json', 'print', 'rpc']) test(`no footer, tracking writes or progress messages in ${mode} mode`, async t => {
  const h = await harness(t, mode); await h.emit('session_start'); await h.emit('tool_result'); await h.emit('turn_end');
  assert.equal(h.widgets.size, 0); assert.equal(h.entries.length, 1);
});
