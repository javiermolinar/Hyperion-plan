// Real Pi CLI, ttyd/xterm and browser input. Only a scripted provider runs.
// All writes/approval are confined to disposable fixture plans, never user sessions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const core = require('../../dist/index.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-workflow-'));
console.log(`Workflow artifacts: ${output}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(60); }
  throw new Error(`Timed out: ${label}`);
}
async function scenario(browser, mode, initialTheme, width) {
  const dir = path.join(output, mode), workspace = path.join(dir, 'workspace'), home = path.join(dir, 'home');
  fs.mkdirSync(path.join(workspace, '.pi'), { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(workspace, '.pi/settings.json'), JSON.stringify({ packages: [root] }));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ quietStartup: true, theme: initialTheme,
    tuiMode: mode, cacheWarming: 'off', enableInstallTelemetry: false, enableAnalytics: false,
    compaction: { enabled: false }, retry: { enabled: false }, showHardwareCursor: true }));
  fs.writeFileSync(path.join(workspace, 'fixture-marker'), 'hyperion-terminal-workflow');
  const planPath = path.join(workspace, 'plan.md');
  core.saveMarkdown(planPath, core.initialize({ title: 'Terminal workflow fixture', steps: [
    { id: 'approved', title: 'Write approved file', description: 'Run only after explicit selection.', reasoning_effort: 'low',
      blocked_by: 'Fixture acceptance-only limitation; execution is available.' },
    { id: 'unselected', title: 'Leave unselected file untouched', reasoning_effort: 'low' },
  ] }));
  const snapshot = () => core.loadMarkdown(planPath)[0];
  const trace = path.join(dir, 'events.jsonl');
  const events = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const log = fs.openSync(path.join(dir, 'ttyd.log'), 'w');
  const terminalTheme = name => name === 'light' ? { background: '#ffffff', foreground: '#202020' }
    : { background: '#202020', foreground: '#eeeeee' };
  const server = spawn('ttyd', ['-i', '127.0.0.1', '-p', '0', '-W', '-o', '-t', 'fontSize=14',
    '-t', 'rendererType=dom', '-t', 'disableResizeOverlay=true', '-t', `theme=${JSON.stringify(terminalTheme(initialTheme))}`,
    '-w', workspace, process.execPath, path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    '--provider', 'hyperion-test', '--model', 'scripted', '--thinking', 'off', '--offline', '--no-session', '--approve',
    '--no-builtin-tools', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes',
    '-e', path.join(__dirname, 'scripted-provider.ts')], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
      PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1', HYPERION_TEST_TRACE: trace, HYPERION_WORKFLOW_ROOT: workspace },
  });
  let diagnostic = '', port, serverError;
  server.on('error', error => { serverError = error; });
  const saveLog = data => { fs.writeSync(log, data); diagnostic += data; port = /Listening on port: (\d+)/.exec(diagnostic)?.[1]; };
  server.stdout.on('data', saveLog); server.stderr.on('data', saveLog);
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const screen = () => page.evaluate(() => {
    const t = window.term, b = t?.buffer.active;
    return b ? Array.from({ length: t.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) || '') : [];
  });
  const text = async () => (await screen()).join('\n');
  const wait = s => until(async () => (await text()).includes(s), s);
  // Regular-mode terminal scrollback may retain old overlay header fragments after
  // resize. Match the live action row, not a historical title in scrollback.
  const closed = () => until(async () => !(await text()).includes('[q] Close'), 'overlay closed');
  const paste = value => page.evaluate(value => { window.term.focus(); window.term.paste(value); }, value);
  const key = value => page.keyboard.press(value);
  const command = async value => { await paste(value); await delay(150); await key('Enter'); };
  const shot = async name => {
    await delay(300); // Let xterm paint after the terminal buffer updates.
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    fs.writeFileSync(path.join(dir, `${name}.txt`), await text());
  };
  const click = async label => {
    const lines = await screen(), y = lines.findIndex(line => line.includes(label));
    assert.ok(y >= 0, `Visible mouse target: ${label}\n${lines.join('\n')}`);
    const col = lines[y].indexOf(label) + 1;
    const size = await page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
    const box = await page.locator('.xterm-screen').boundingBox();
    await page.mouse.click(box.x + (col + .5) * box.width / size.cols, box.y + (y + .5) * box.height / size.rows);
  };
  const action = async (letter, label) => mode === 'fullscreen' ? click(label) : key(letter);
  const open = async () => { await command('/hyperion-plan'); await wait('[q] Close'); };
  try {
    await until(() => { if (serverError) throw serverError; return port; }, 'ttyd startup');
    await page.goto(`http://127.0.0.1:${port}`);
    await until(() => events().some(e => e.event === 'session_start'), 'Pi startup');
    await page.waitForFunction(() => !!window.term);
    await command('Show the plan');
    await wait('CANONICAL PLAN');
    assert.equal(snapshot().execution, undefined);
    await shot('opened');

    // Natural-language input receives Unicode and command letters; no JSON or
    // Save/confirmation round trip is needed before the agent applies the note.
    await action('m', '[m] Note'); await wait('Note for approved');
    const note = '日本語 e\u0301 😀 — r s f are text, not plan commands';
    const input = await page.context().newCDPSession(page);
    try {
      await page.evaluate(() => window.term.focus());
      await input.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
      assert.equal(snapshot().execution, undefined);
      await input.send('Input.insertText', { text: '日本語' });
    } finally { await input.detach(); }
    await paste(note.slice('日本語'.length));
    await wait('are text, not plan commands'); await shot('editor');
    assert.equal(snapshot().execution, undefined);
    await key('Enter'); await wait('Fixture note saved');
    await until(() => snapshot().steps[0].comments.length === 1, 'agent-applied note');
    assert.equal(snapshot().steps[0].comments[0].text, note);
    assert.equal(snapshot().execution, undefined);
    await open();
    await action('n', '[n] Add'); await wait('What should be added');
    await paste('Check recovery without duplicate dispatch'); await key('Enter');
    await wait('Fixture addition saved');
    assert.equal(snapshot().steps.find(s => s.id === 'added').status, 'pending');
    assert.equal(snapshot().execution, undefined);
    await shot('agent-added-step');
    await open();

    // Cancel an input, then send an actual question. Both leave authority untouched.
    await action('a', '[a] Ask'); await wait('Ask about approved');
    await paste('Cancelled question'); await key('Escape'); await wait('CANONICAL PLAN');
    assert.equal(events().filter(e => e.event === 'question').length, 0);
    await action('a', '[a] Ask'); await wait('Ask about approved');
    await paste('Why 日本語? r s f'); await key('Enter');
    await wait('Fixture question received');
    assert.equal(snapshot().execution, undefined);
    assert.ok(events().some(e => e.event === 'question' && e.text.includes('Why 日本語? r s f')));
    await open();

    // Resize the actual PTY/browser with the overlay open. Preserve focus and draft state.
    await page.setViewportSize({ width: 540, height: 750 });
    await page.waitForFunction(() => window.term.cols < 100);
    // xterm can retain a historical viewport after resize when long intent
    // messages fill scrollback. Observe the live terminal, not that history.
    await page.evaluate(() => window.term.scrollToBottom());
    await wait('[Tab] Details'); await shot('narrow');
    if (mode === 'fullscreen') { await click('[Tab] Details'); await wait('[Tab] Steps'); await click('[Tab] Steps'); }
    else { await key('Tab'); await wait('[Tab] Steps'); await key('Tab'); }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForFunction(() => window.term.cols >= 100);
    await page.evaluate(() => window.term.scrollToBottom());
    await wait('CANONICAL DETAILS'); await shot('wide');
    await key('Escape'); await closed();
    const nextTheme = initialTheme === 'dark' ? 'light' : 'dark';
    await page.evaluate(theme => { window.term.options.theme = theme; }, terminalTheme(nextTheme));
    await command(`/fixture-theme ${nextTheme}`);
    await until(() => events().some(e => e.event === 'theme'), 'theme change');
    await open(); await shot('theme-changed');

    // Selection and closing do not grant approval. Reopening must not restore selection.
    await action('Space', '[ ] approved'); await wait('1 selected');
    assert.equal(snapshot().execution, undefined);
    await key('Escape'); await closed();
    await open(); await wait('No steps selected');
    assert.equal(snapshot().execution, undefined);
    await action('Space', '[ ] approved'); await wait('1 selected');
    await action('g', '[g] Refresh'); await wait('1 selected');
    await action('r', '[r] Run');
    await until(() => snapshot().steps[0].status === 'completed', 'one Run through agent reconciliation and checkpoints');
    await wait('Fixture Run verified'); await shot('inline-completion');
    const completed = snapshot();
    assert.deepEqual(completed.execution.selected_step_ids, ['approved']);
    assert.equal(completed.steps[1].status, 'pending');
    assert.equal(fs.readFileSync(path.join(workspace, 'approved.txt'), 'utf8'), 'approved');
    assert.equal(fs.existsSync(path.join(workspace, 'unselected.txt')), false);
    assert.equal(events().filter(e => e.event === 'intent_reconciled').length, 1);
    assert.deepEqual(events().filter(e => e.event === 'checkpoint').map(e => e.phase), ['start', 'complete']);
    assert.equal(snapshot().steps.find(s => s.id === 'added').status, 'pending');
    await open(); await wait('1/3 complete'); await wait('No steps selected'); await shot('reopened-completion');

    await action('f', '[f] Finish'); await wait('FINISHED');
    assert.equal(snapshot().lifecycle, 'finished'); assert.equal(snapshot().execution, undefined);
    await action('f', '[f] Reopen'); await wait('CANONICAL PLAN');
    assert.equal(snapshot().lifecycle, 'active'); assert.equal(snapshot().execution, undefined);
    assert.equal(snapshot().steps[0].status, 'completed');
    await shot('reopened-lifecycle');
    assert.ok(!events().some(e => e.event === 'failure'), JSON.stringify(events()));
    assert.ok(events().some(e => e.event === 'tool_result' && e.details?.screen === 'queued'));
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ mode, initialTheme, plan: snapshot(),
      checks: ['plan-only Chromium IME composition and Unicode paste', 'input cancellation', 'natural-language Note/Add without Save or confirmation', 'Ask without approval',
        'PTY resize', 'theme switch', 'selection isolation and refresh retention', 'single Run through agent reconciliation', 'start/complete checkpoints',
        'unselected untouched', 'completion reopen', 'finish/reopen without approval'],
      limitations: ['Scripted provider, not arbitrary model routing', 'Chromium IME protocol/focus, not OS IME candidate-window positioning', 'ttyd Unicode 11 does not reliably render ZWJ emoji; terminal fixture uses single-code-point emoji'] }, null, 2));
    console.log(`PASS ${mode}: real terminal workflow${mode === 'fullscreen' ? ' with mouse controls' : ' with keyboard controls'}`);
  } catch (error) {
    await shot('failure').catch(() => {});
    throw error;
  } finally {
    await page.close();
    if (server.exitCode === null) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await until(() => server.exitCode !== null || server.signalCode !== null, 'ttyd cleanup', 5000);
    }
    fs.closeSync(log);
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    await scenario(browser, 'regular', 'dark', 1400);
    await scenario(browser, 'fullscreen', 'light', 780);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
