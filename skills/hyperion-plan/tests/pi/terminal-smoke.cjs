// Real interactive Pi + deterministic provider + headless terminal screenshots.
// No user session, cmux, credentials or external model calls are used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const core = require('../../dist/index.cjs');
const root = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-terminal-'));
const workspace = path.join(output, 'workspace'), agentDir = path.join(output, 'agent');
fs.mkdirSync(path.join(workspace, '.pi'), { recursive: true }); fs.mkdirSync(agentDir);
// Opt-in compatibility capture with an existing Powerline installation; no install or user settings.
const powerline = process.env.HYPERION_TEST_POWERLINE;
fs.writeFileSync(path.join(workspace, '.pi/settings.json'), JSON.stringify({ packages: [...(powerline ? [fs.realpathSync(powerline)] : []), root] }));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ quietStartup: true, cacheWarming: 'off',
  enableInstallTelemetry: false, enableAnalytics: false, theme: 'dark', tuiMode: 'regular',
  compaction: { enabled: false }, retry: { enabled: false } }));
core.saveMarkdown(path.join(workspace, 'plan.md'), core.initialize({ title: 'Runtime overlay regression', steps: [
  { id: 'one', title: 'Inspect sample', status: 'pending', reasoning_effort: 'low', description: 'A real Pi terminal, not a component mock.' },
  { id: 'two', title: 'Verify persistence', status: 'pending', depends_on: ['one'] },
] }));
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const cli = path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const command = `cd ${quote(workspace)} && ${quote(process.execPath)} ${quote(cli)} --provider hyperion-test --model scripted --thinking off --offline --no-session --approve --no-builtin-tools --no-skills --no-context-files --no-prompt-templates --no-themes -e ${quote(path.join(__dirname, 'fixture.ts'))}`;
const tape = `Set Shell "bash"
Set Width 1400
Set Height 800
Set FontSize 14
Set TypingSpeed 0s
Output terminal.ascii
Hide
Type ${JSON.stringify(command)}
Enter
Sleep 5s
${powerline ? 'Escape\nSleep 1s\n' : ''}Show
Set TypingSpeed 50ms
Ctrl+u
Type "/hyperion"
Sleep 500ms
Enter
Sleep 2s
Screenshot discovered.png
Escape
Sleep 1s
Type "/reload"
Sleep 500ms
Enter
Sleep 3s
${powerline ? 'Escape\nSleep 1s\nCtrl+u\n' : ''}Type "Show the plan"
Sleep 500ms
Enter
Sleep 4s
Screenshot overlay.png
Type "A"
Sleep 2s
Screenshot agents.png
Type "B"
Sleep 2s
Screenshot back.png
Escape
Sleep 1s
Screenshot inline.png
Type "/hyperion"
Sleep 500ms
Enter
Sleep 2s
Screenshot reopened.png
Escape
Sleep 500ms
Ctrl+d
Sleep 1s
`;
fs.writeFileSync(path.join(output, 'smoke.tape'), tape);
console.log(`Terminal artifacts: ${output}`);
// Reuse existing Rod browser installations without exposing user Pi settings/credentials.
// Symlink individual cached versions, not the cache root: a new download stays isolated.
const browserCache = path.join(os.homedir(), '.cache/rod/browser');
const isolatedCache = path.join(agentDir, '.cache/rod/browser');
fs.mkdirSync(isolatedCache, { recursive: true });
if (fs.existsSync(browserCache)) for (const name of fs.readdirSync(browserCache)) {
  if (/^chromium-\d+$/.test(name)) fs.symlinkSync(path.join(browserCache, name), path.join(isolatedCache, name));
}
const env = { PATH: process.env.PATH, HOME: agentDir, TMPDIR: os.tmpdir(), TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agentDir, HYPERION_TEST_TRACE: path.join(output, 'events.jsonl'),
};
const result = spawnSync('vhs', ['smoke.tape'], { cwd: output, env, encoding: 'utf8', timeout: 90000 });
fs.writeFileSync(path.join(output, 'vhs.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`);
assert.equal(result.status, 0, `VHS failed; inspect ${output}/vhs.log`);
const events = fs.readFileSync(path.join(output, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert.ok(events.filter(e => e.event === 'session_start').length >= 2, 'cold start and reload');
assert.ok(!events.some(e => e.event === 'failure'), JSON.stringify(events.filter(e => e.event === 'failure')));
assert.ok(events.some(e => e.event === 'request' && e.tools.includes('hyperion_plan')), 'tool reaches actual provider request');
assert.ok(events.some(e => e.event === 'tool_result' && e.details?.screen === 'queued'), 'open accepted');
assert.ok(events.some(e => e.event === 'settled' && e.idle), 'run settles');
const terminal = fs.readFileSync(path.join(output, 'terminal.ascii'), 'utf8');
assert.match(terminal, /HYPERION\s+\/\s+PLAN/, 'native overlay actually rendered');
assert.match(terminal, /Runtime overlay regression/);
for (const label of ['[Space] Select', '[Enter] Run', '[Esc] Close', '[A] Agents'])
  assert.ok(terminal.includes(label), `Four-action main menu: ${label}`);
assert.doesNotMatch(terminal, /\[(?:r|e|n|m|f|g|q|Tab)\] (?:Run|Edit|Add|Note|Finish|Refresh|Close|Details)/);
assert.match(terminal, /▣.*Runtime overlay regression/, 'plan status strip is visible without an overlay');
assert.match(terminal, /Next.*one Inspect sample/, 'footer shows the current candidate without implying execution');
assert.match(terminal, /\[░{10}\] 0\/2.*0 agents.*No blockers/, 'strip includes step-based progress, observed agent count and blockers');
assert.doesNotMatch(terminal, /ETA —|◷ —/, 'no unavailable timing placeholders');
assert.match(terminal, /Hyperion.*open.*overlay queued/, 'tool receipt is a compact unboxed summary');
assert.doesNotMatch(terminal, /HYPERION.*PROGRESS/, 'progress no longer adds conversation panes');
assert.match(terminal, /HYPERION\s+\/\s+AGENTS/, 'A opens the coordinator agent view');
assert.match(terminal, /\[B\] Back/, 'agent view exposes B to return to the plan');
assert.match(terminal, /No Hyperion assignments/, 'empty agent view does not fabricate activity');
assert.doesNotMatch(terminal, /VIEW ONLY.*Pi busy/, 'prompted overlay is editable after settlement');
assert.equal(core.loadMarkdown(path.join(workspace, 'plan.md'))[0].execution, undefined);
for (const name of ['discovered.png', 'overlay.png', 'inline.png', 'agents.png', 'back.png', 'reopened.png']) assert.ok(fs.statSync(path.join(output, name)).size > 1000);
console.log('PASS: real Pi cold discovery, reload, model tools, prompted editable overlay, A/B plan-agent navigation, bound reopen; no implementation approval.');
