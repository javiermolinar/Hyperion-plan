const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cases = ['codex-token', 'rotating-source-key', 'missing-source-auth'];

// A separate, credential-free process keeps SDK environment discovery and network
// guards out of the other tests. No agent session or model request is launched.
if (process.argv[2] === '--offline-proxy-fixture') {
  runFixture(process.argv[3], process.argv[4]).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { test } = require('node:test');
  for (const name of cases) test(`model proxy resolves source authentication: ${name}`, { timeout: 30000 }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-proxy-auth-'));
    fs.mkdirSync(path.join(dir, 'home'));
    const result = spawnSync(process.execPath, [__filename, '--offline-proxy-fixture', name, dir], {
      env: { HOME: path.join(dir, 'home'), PATH: process.env.PATH },
      encoding: 'utf8', timeout: 25000,
    });
    if (result.status === 0) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    else t.diagnostic(`Proxy regression artifacts: ${dir}`);
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { case: name, networkAttempts: 0 });
  });
}

async function runFixture(name, dir) {
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden'); };
  require('node:net').Socket.prototype.connect = function () { networkAttempts++; throw new Error('Network forbidden'); };
  const sdkPath = path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const aiRoot = path.join(root, 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist');
  // Test the actual source helper, not a reimplementation or an extra shipped API.
  const modulePath = path.join(dir, 'model-proxy.mjs');
  await require('esbuild').build({
    entryPoints: [path.join(root, 'src/pi/model-proxy.ts')], outfile: modulePath,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: 'const __dirname = new URL(".", import.meta.url).pathname;' },
    plugins: [{ name: 'installed-public-dependencies', setup(build) {
      build.onResolve({ filter: /^(@earendil-works\/pi-coding-agent|proper-lockfile)$/ }, args =>
        ({ path: args.path === '@earendil-works/pi-coding-agent' ? sdkPath : require.resolve(args.path), external: true }));
    } }],
  });
  const { ModelRuntime } = await import(pathToFileURL(sdkPath));
  const ai = await import(pathToFileURL(path.join(aiRoot, 'index.js')));
  const codex = await import(pathToFileURL(path.join(aiRoot, 'api/openai-codex-responses.js')));
  const { childModelProxy } = await import(pathToFileURL(modulePath));
  const isCodex = name === 'codex-token';
  const model = { provider: isCodex ? 'openai-codex' : 'offline-proxy-test',
    id: 'offline', name: 'Offline proxy regression', api: isCodex ? 'openai-codex-responses' : 'openai-completions',
    baseUrl: 'https://invalid.test', reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Synthetic, unsigned and never transmitted; this is token parsing, not a login.
  const token = `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-account' } })}.fake`;
  let expectedKey = isCodex ? token : 'offline-source-key-one';
  const source = await ModelRuntime.create({ authPath: path.join(dir, 'source-auth.json'), modelsPath: null,
    modelsStorePath: path.join(dir, 'source-models.json'), refreshOnCreate: false, allowModelNetwork: false });
  let sourceCalls = 0, forwardedCalls = 0, payloadCalls = 0;
  const controller = new AbortController();
  const options = { signal: controller.signal, reasoning: 'high', maxTokens: 123, sessionId: 'offline-session',
    transport: 'sse', headers: { 'x-offline-test': 'preserved' }, env: { OFFLINE_TEST_ENV: 'preserved' },
    onPayload() { payloadCalls++; throw new Error('Offline token extraction passed'); },
    onResponse() {}, onProviderStreamEvent() {},
  };
  source.registerProvider(model.provider, {
    api: model.api, models: [model], ...(name === 'missing-source-auth' ? {} : { apiKey: expectedKey }),
    streamSimple(selected, context, opts) {
      sourceCalls++;
      assert.equal(opts.apiKey, expectedKey, 'source credentials must win over child placeholder');
      if (isCodex) return codex.streamSimple(selected, context, opts);
      const stream = ai.createAssistantMessageEventStream();
      const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
        timestamp: Date.now(), content: [], stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0,
          cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const context = { messages: [{ role: 'user', content: 'Offline proxy regression', timestamp: 1 }] };
  if (isCodex) {
    // Prove the real Codex parser rejects the old placeholder before any request,
    // while the source fixture token reaches the pre-network payload hook.
    const rejected = await codex.streamSimple(model, context, { ...options, apiKey: 'in-process-registry-proxy' }).result();
    assert.equal(rejected.errorMessage, 'Failed to extract accountId from token');
    const direct = await source.streamSimple(model, context, options).result();
    assert.equal(direct.errorMessage, 'Offline token extraction passed');
  }
  const originalModel = structuredClone(model);
  const proxy = await childModelProxy({ model, modelRegistry: {
    streamSimple(selected, ctx, opts) {
      forwardedCalls++;
      assert.equal(Object.hasOwn(opts, 'apiKey'), false, 'do not forward any child API key override');
      assert.deepEqual(selected, originalModel);
      for (const key of ['signal', 'onPayload', 'onResponse', 'onProviderStreamEvent']) assert.equal(opts[key], options[key], key);
      for (const key of ['reasoning', 'maxTokens', 'sessionId', 'transport', 'headers', 'env']) assert.deepEqual(opts[key], options[key], key);
      return source.streamSimple(selected, ctx, opts);
    },
  } }, path.join(dir, 'plan.md'));
  assert.deepEqual(model, originalModel, 'source model metadata is unchanged');
  const result = await proxy.runtime.streamSimple(proxy.model, context, options).result();
  if (isCodex) {
    assert.equal(result.errorMessage, 'Offline token extraction passed');
    assert.equal(payloadCalls, 2);
    assert.equal(sourceCalls, 2);
  } else if (name === 'missing-source-auth') {
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, /Provider is not configured/);
    assert.equal(sourceCalls, 0, 'placeholder cannot mask absent source credentials');
  } else {
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    expectedKey = 'offline-source-key-two';
    await source.setRuntimeApiKey(model.provider, expectedKey);
    const again = await proxy.runtime.streamSimple(proxy.model, context, options).result();
    assert.equal(again.stopReason, 'stop', again.errorMessage);
    assert.equal(sourceCalls, 2, 'source credentials are resolved afresh for each call');
  }
  assert.equal(forwardedCalls, name === 'rotating-source-key' ? 2 : 1);
  assert.equal(networkAttempts, 0);
  console.log(JSON.stringify({ case: name, networkAttempts }));
}
