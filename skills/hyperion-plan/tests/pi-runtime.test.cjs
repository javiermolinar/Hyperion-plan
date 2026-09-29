const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const core = require('../dist/index.cjs');

const root = path.resolve(__dirname, '..');
const sdkURL = pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
const provider = path.join(__dirname, 'pi/scripted-provider.ts');
const model = { provider: 'hyperion-test', id: 'scripted', name: 'Scripted integration fixture', api: 'openai-completions',
  baseUrl: 'http://invalid.test', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };

test('real Pi runtime exposes the packaged tool to the provider before/after reload and session restore', { timeout: 30000 }, async t => {
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(sdkURL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-runtime-'));
  let passed = false;
  t.after(() => {
    if (passed) fs.rmSync(dir, { recursive: true, force: true });
    else t.diagnostic(`Runtime failure artifacts retained at ${dir}`);
  });
  const agentDir = path.join(dir, 'agent'); fs.mkdirSync(agentDir);
  const trace = path.join(dir, 'trace.jsonl');
  const previousTrace = process.env.HYPERION_TEST_TRACE;
  process.env.HYPERION_TEST_TRACE = trace;
  t.after(() => { if (previousTrace === undefined) delete process.env.HYPERION_TEST_TRACE; else process.env.HYPERION_TEST_TRACE = previousTrace; });
  const plan = core.initialize({ title: 'Runtime regression', steps: [{ id: 'one', title: 'Inspect sample', status: 'pending' }] });
  core.saveMarkdown(path.join(dir, 'plan.md'), plan);
  // Exercise project package discovery, not just a direct import of the factory.
  fs.mkdirSync(path.join(dir, '.pi'));
  fs.writeFileSync(path.join(dir, '.pi/settings.json'), JSON.stringify({ packages: [root] }));
  const settings = SettingsManager.create(dir, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: settings,
    additionalExtensionPaths: [provider], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  let manager = SessionManager.create(dir, path.join(dir, 'sessions'));
  let session;
  t.after(() => session?.dispose());
  const events = [], frames = [];
  const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: text => text };
  const start = async () => {
    ({ session } = await createAgentSession({ cwd: dir, agentDir, model, thinkingLevel: 'off',
      sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: 'builtin' }));
    session.subscribe(event => {
      events.push(event.type);
      fs.appendFileSync(path.join(dir, 'runtime-events.jsonl'), JSON.stringify({ type: event.type }) + '\n');
    });
    await session.bindExtensions({ mode: 'tui', uiContext: {
      notify() {}, setStatus() {}, setWidget() {},
      custom: async factory => {
        assert.equal(session.isIdle, true, 'tool-open overlay must wait for settlement');
        const screen = factory({ requestRender() {}, terminal: { rows: 40 } }, theme, {}, () => {});
        frames.push(screen.render(120).join('\n'));
        return { type: 'close' };
      },
    } });
  };
  await start();
  const phases = ['cold', 'reload', 'restore', 'tool-added', 'compacted-restore'];
  for (const phase of phases) {
    if (phase === 'reload') await session.reload();
    if (phase === 'restore' || phase === 'compacted-restore') {
      if (phase === 'compacted-restore') {
        // Exercise actual SessionManager compaction storage/restoration, not LLM summarization quality.
        manager.appendCompaction('Test compaction summary; inspect the bound canonical plan.', null, 1000);
      }
      const file = manager.getSessionFile();
      session.dispose();
      manager = SessionManager.open(file);
      await loader.reload();
      await start();
    }
    if (phase === 'tool-added') {
      fs.writeFileSync(path.join(dir, '.pi/settings.json'), JSON.stringify({ packages: [] }));
      await session.reload();
      assert.ok(!session.getActiveToolNames().includes('hyperion_plan'));
      fs.writeFileSync(path.join(dir, '.pi/settings.json'), JSON.stringify({ packages: [root] }));
      await session.reload();
    }
    assert.ok(session.getActiveToolNames().includes('hyperion_plan'), phase);
    assert.ok(session.modelRuntime.getRegisteredProviderIds().includes('hyperion-test'), `${phase}: scripted provider registered`);
    await session.prompt('Show the plan');
    // Settlement detaches overlay presentation; let its asynchronous disk read finish.
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(session.getLastAssistantText(), 'Plan request accepted. Ending the turn for the native screen.', phase);
    assert.equal(frames.length, phases.indexOf(phase) + 1, phase);
    assert.match(frames.at(-1), /Runtime regression/);
    assert.doesNotMatch(frames.at(-1), /VIEW ONLY/);
    assert.ok(manager.getBranch().some(entry => entry.type === 'custom' && entry.customType === 'hyperion-plan.binding'));
  }
  const requests = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.event === 'request');
  assert.equal(requests.length, 10);
  assert.ok(requests.every(x => x.system.includes("Hyperion is this session's planning interface")));
  assert.ok(requests.every(x => x.tools.includes('hyperion_plan')));
  assert.equal((await core.loadPlanSnapshot(path.join(dir, 'plan.md'))).plan.execution, undefined);
  assert.ok(events.includes('agent_settled'));
  passed = true;
});
