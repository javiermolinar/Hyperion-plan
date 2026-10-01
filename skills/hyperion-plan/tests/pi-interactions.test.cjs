const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const core = require('../dist/index.cjs');
let modules;
async function load() {
  if (!modules) modules = (async () => {
    const req = createRequire(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'));
    const { createJiti } = await import(pathToFileURL(req.resolve('jiti')).href);
    const tuiPath = req.resolve('@earendil-works/pi-tui');
    const jiti = createJiti(__filename, { alias: { '@earendil-works/pi-tui': tuiPath } });
    return [await jiti.import(path.resolve(__dirname, '../src/pi/ui.ts')), await import(pathToFileURL(tuiPath).href)];
  })();
  return modules;
}
async function fixture() {
  const [{ PlanScreen, PlanScreenState }, tui] = await load();
  const plan = core.initialize({ title: '日本語 e\u0301 👩‍💻', steps: [
    { id: 'a', title: 'Inspect 日本語 👩‍💻', description: 'Detail '.repeat(120) },
    { id: 'b', title: 'Leave untouched' },
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

for (const width of [42, 60, 80, 99, 100, 160]) test(`all plan controls remain visible and mouse-addressable at ${width} columns`, async () => {
  const f = await fixture();
  f.state.stage({ type: 'update_step', step_id: 'a', fields: { title: 'Staged edit' } });
  let lines = plain(f.screen.render(width));
  for (const label of ['[r] Run', '[v] Check plan', '[a] Ask', '[e] Edit', '[n] Add', '[m] Note', '[d] Split', '[x] Remove', '[s] Save', '[z] Discard', '[f] Finish', '[g] Refresh', '[q] Close']) position(lines, label);
  click(f.screen, position(lines, '[s] Save'));
  assert.deepEqual(f.actions, [{ type: 'save' }]);
  assert.equal(f.state.plan.execution, undefined);
  if (width < 100) {
    click(f.screen, position(lines, '[Tab] Details'));
    assert.equal(f.state.view, 'details');
    lines = plain(f.screen.render(width));
    click(f.screen, position(lines, '[Tab] Steps'));
    assert.equal(f.state.view, 'steps');
  }
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
  const run = position(lines, '[r] Run');
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

test('resize, Unicode and theme invalidation preserve drafts, focus and authorization', async () => {
  const f = await fixture();
  f.state.stage({ type: 'update_step', step_id: 'b', fields: { title: '中文 e\u0301 👩‍💻' } });
  f.state.setFocused('b');
  f.state.toggleSelection('b');
  const before = f.screen.render(120).join('\n');
  f.theme('light'); f.screen.invalidate();
  assert.notEqual(f.screen.render(120).join('\n'), before);
  for (const width of [1, 20, 41, 42, 60, 99, 100, 160]) for (const height of [1, 10, 20, 24, 42, 70]) {
    f.height(height);
    const lines = f.screen.render(width);
    assert.ok(lines.length <= Math.floor(height * .95), `${width}x${height}: ${lines.length}`);
    for (const line of lines) assert.ok(f.tui.visibleWidth(line) <= width);
  }
  assert.equal(f.state.focusedStepId, 'b');
  assert.deepEqual(f.state.selectedStepIds, ['b']);
  assert.equal(f.state.draftOperations.length, 1);
  assert.equal(f.state.plan.execution, undefined);
});

test('pasted command letters and focus sequences do not invoke actions', async () => {
  const f = await fixture();
  f.state.toggleSelection('a');
  for (const input of ['\x1b[200~r\x1b[201~', 'rsf', '\x1b[I', '\x1b[O', '日本語']) f.screen.handleInput(input);
  assert.deepEqual(f.actions, []);
  assert.equal(f.state.plan.execution, undefined);
});
