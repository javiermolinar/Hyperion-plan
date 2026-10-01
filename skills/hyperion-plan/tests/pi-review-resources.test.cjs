const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-resources-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'resources.mjs');
  await require('esbuild').build({ entryPoints: [path.resolve(__dirname, '../src/pi/review-resources.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  const { resolveReviewResources } = await import(pathToFileURL(output));
  const home = path.join(root, 'home'), source = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(source);
  const put = (file, text = 'fixture', mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, mode ? { mode } : undefined); return file; };
  const assets = version => {
    const dir = path.join(home, '.codex/plugins/cache/openai-bundled/visualize', version, 'skills/visualize/assets');
    for (const file of ['visualize.html', 'visualize.css']) put(path.join(dir, file));
    return dir;
  };
  const options = { home, env: {}, platform: 'linux' };
  return { root, home, source, put, assets, options, resolve: (configured = {}, required = ['PLAYWRIGHT_MODULE', 'CHROMIUM_EXECUTABLE', 'VISUALIZE_ASSETS']) =>
    resolveReviewResources(source, ['package.json'], configured, required, options) };
}

test('stale saved Visualize path discovers an installed replacement without configuration writes', async t => {
  const f = await fixture(t), newest = f.assets('1.0.45'); f.assets('1.0.9');
  const stale = newest.replace('1.0.45', '1.0.39');
  const config = { VISUALIZE_ASSETS: stale };
  assert.equal(f.resolve(config).VISUALIZE_ASSETS, newest);
  assert.deepEqual(config, { VISUALIZE_ASSETS: stale });
  assert.equal(fs.existsSync(path.join(f.home, '.pi')), false);
  assert.deepEqual(fs.readdirSync(f.source), []);
});

test('valid saved paths and explicit environment overrides take precedence over discovery', async t => {
  const f = await fixture(t), pinned = f.assets('1.0.9'); f.assets('1.0.45');
  assert.equal(f.resolve({ VISUALIZE_ASSETS: pinned }).VISUALIZE_ASSETS, pinned);
  f.options.env.VISUALIZE_ASSETS = '/explicit-but-missing';
  assert.equal(f.resolve({ VISUALIZE_ASSETS: pinned }).VISUALIZE_ASSETS, '/explicit-but-missing');
});

test('finds project Playwright and cached Chromium without executing either', async t => {
  const f = await fixture(t);
  const playwright = path.join(f.source, 'node_modules/playwright-core');
  f.put(path.join(playwright, 'package.json'), '{"name":"playwright-core"}');
  const chromium = f.put(path.join(f.home, '.cache/rod/browser/chromium-1321438/Chromium.app/Contents/MacOS/Chromium'), 'throw if executed', 0o755);
  const found = f.resolve();
  assert.equal(found.PLAYWRIGHT_MODULE, playwright);
  assert.equal(found.CHROMIUM_EXECUTABLE, chromium);
});

test('finds installed Pi-local Playwright and Linux Playwright browser cache', async t => {
  const f = await fixture(t);
  const playwright = path.join(f.home, '.pi/browser-tools/node_modules/playwright-core');
  f.put(path.join(playwright, 'package.json'), '{"name":"playwright-core"}');
  const chromium = f.put(path.join(f.home, '.cache/ms-playwright/chromium-123/chrome-linux/chrome'), 'not executed', 0o755);
  assert.equal(f.resolve().PLAYWRIGHT_MODULE, playwright);
  assert.equal(f.resolve().CHROMIUM_EXECUTABLE, chromium);
});

test('ignores invalid candidates and never falls back to an arbitrary HOME crawl', async t => {
  const f = await fixture(t);
  f.put(path.join(f.home, '.pi/wrong/node_modules/playwright-core/package.json'), '{"name":"unrelated"}');
  f.put(path.join(f.home, '.cache/rod/browser/chromium-42/Chromium.app/Contents/MacOS/Chromium'), 'not executable', 0o644);
  f.put(path.join(f.home, 'private/unrelated/skills/visualize/assets/visualize.html'));
  assert.deepEqual(f.resolve(), {});
});

test('discovery inspects only resource kinds required by this review', async t => {
  const f = await fixture(t); f.assets('1.0.45');
  assert.deepEqual(f.resolve({}, []), {});
  assert.deepEqual(f.resolve({}, ['PLAYWRIGHT_MODULE']), {});
});

test('stale custom Visualize installation resolves sibling versions', async t => {
  const f = await fixture(t);
  const root = path.join(f.root, 'custom/visualize');
  const current = path.join(root, '2.0.0/skills/visualize/assets');
  for (const name of ['visualize.html', 'visualize.css']) f.put(path.join(current, name));
  assert.equal(f.resolve({ VISUALIZE_ASSETS: path.join(root, '1.0.0/skills/visualize/assets') }).VISUALIZE_ASSETS, current);
});
