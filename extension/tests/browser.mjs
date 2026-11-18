import assert from 'node:assert/strict';
import { readFile, mkdir, cp, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import https from 'node:https';
import selfsigned from 'selfsigned';

const work = path.resolve('work');
await mkdir(work, { recursive: true });
const fixture = await readFile('tests/fixtures/chat.html', 'utf8');
const harness = await mkdtemp(path.join(work, 'extension-harness-'));
await cp('dist', harness, { recursive: true });
const profile = await mkdtemp(path.join(work, 'test-profile-'));
// Test-only replacement for the OS native port. Production dist contains no hooks.
await writeFile(
  path.join(harness, 'native-harness.js'),
  `
globalThis.__native={out:[],listeners:[],disconnects:[],post(message){for(const listener of this.listeners)listener(message)}};
chrome.runtime.connectNative=(name)=>{if(name!=='com.multichat.agent')throw new Error('Wrong host');return {
postMessage(message){__native.out.push(message)},onMessage:{addListener(fn){__native.listeners.push(fn)}},
onDisconnect:{addListener(fn){__native.disconnects.push(fn)}}}};
importScripts('background.js');
`,
);
const manifest = JSON.parse(await readFile(path.join(harness, 'manifest.json'), 'utf8'));
manifest.background.service_worker = 'native-harness.js';
await writeFile(path.join(harness, 'manifest.json'), JSON.stringify(manifest));
await build({
  entryPoints: ['src/dom.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'TestAdapter',
  outfile: path.join(work, 'adapter.js'),
  target: 'chrome120',
});
await build({
  entryPoints: ['src/config.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'TestConfig',
  outfile: path.join(work, 'config.js'),
  target: 'chrome120',
});

const certificate = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
  days: 1,
  keySize: 2048,
});
const server = https.createServer(
  { key: certificate.private, cert: certificate.cert },
  (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixture);
  },
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const launch = () =>
  chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${harness}`,
      `--load-extension=${harness}`,
      '--no-proxy-server',
      '--ignore-certificate-errors',
      `--host-resolver-rules=MAP chat.deepseek.com 127.0.0.1:${port},MAP chat.qwen.ai 127.0.0.1:${port}`,
    ],
  });
let context = await launch();
let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`PASS browser: ${name}`);
}
const origins = { deepseek: 'https://chat.deepseek.com', qwen: 'https://chat.qwen.ai' };
const job = (provider = 'deepseek', patch = {}) => ({
  type: 'job',
  request_id: crypto.randomUUID(),
  provider,
  prompt: 'Unique prompt ' + crypto.randomUUID(),
  conversation_key: 'material:' + crypto.randomUUID() + ':author',
  timeout_ms: 10000,
  ...patch,
});
try {
  let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.waitForFunction?.(() => globalThis.__native?.out.length);
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#config').filter({ hasText: '' }).waitFor();
  await options.waitForFunction(() => document.querySelector('#config').value.includes('composer'));
  await options.locator('#deepseek').check();
  await options.locator('#qwen').check();
  const config = JSON.parse(await options.locator('#config').inputValue());
  for (const c of Object.values(config)) {
    c.stable_ms = 100;
    c.poll_ms = 25;
  }
  await options.locator('#config').fill(JSON.stringify(config));
  await options.locator('#save').click();
  await options.getByRole('status').filter({ hasText: 'Сохранено' }).waitFor();
  const signed = {};
  for (const [provider, origin] of Object.entries(origins)) {
    signed[provider] = await context.newPage();
    await signed[provider].goto(origin + '/c/user-owned');
  }
  async function dispatch(j) {
    await worker.evaluate((j) => globalThis.__native.post(j), j);
  }
  async function response(j) {
    const until = Date.now() + j.timeout_ms + 6000;
    while (Date.now() < until) {
      const r = await worker.evaluate(
        (id) => globalThis.__native.out.find((m) => m.type === 'result' && m.request_id === id),
        j.request_id,
      );
      if (r) return r;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(
      'Missing native result ' +
        j.request_id +
        '; ' +
        JSON.stringify(await worker.evaluate(() => globalThis.__native.out)),
    );
  }
  async function mode(provider, value) {
    await signed[provider].evaluate((value) => localStorage.setItem('mock-mode', value), value);
  }
  await check(
    'actual MV3 content/worker bridge, two providers concurrent, owned chats untouched',
    async () => {
      const deepseek = job(),
        qwen = job('qwen');
      await Promise.all([dispatch(deepseek), dispatch(qwen)]);
      const [a, b] = await Promise.all([response(deepseek), response(qwen)]);
      assert.equal(a.status, 'completed', JSON.stringify(a));
      assert.equal(b.status, 'completed', JSON.stringify(b));
      assert.equal(
        a.text,
        'Final answer for: ' + deepseek.prompt + '\n\n```python\nprint(42)\n```',
      );
      assert.match(a.conversation_url, /\/c\/mock-/);
      assert.equal(await signed.deepseek.evaluate(() => fixture.clicks), 0);
      assert.equal(await signed.qwen.evaluate(() => fixture.clicks), 0);
      const generated = [];
      for (const page of context.pages())
        if (/\/c\/mock-/.test(page.url()))
          generated.push(
            await page.evaluate(() => ({ started: fixture.started, finished: fixture.finished })),
          );
      assert.equal(generated.length, 2);
      const workTabs = await worker.evaluate(async () =>
        (await chrome.tabs.query({})).filter((tab) => tab.url?.includes('/c/mock-')),
      );
      assert.equal(new Set(workTabs.map((tab) => tab.windowId)).size, 2);
      assert.ok(
        workTabs.every((tab) => tab.active),
        'each provider must have an active work tab',
      );
      assert.ok(
        Math.max(...generated.map((x) => x.started)) <
          Math.min(...generated.map((x) => x.finished)),
        'provider intervals must overlap',
      );
    },
  );
  await check(
    'same conversation is serialized, reused, and duplicate wire jobs do not click twice',
    async () => {
      const first = job('qwen');
      const second = job('qwen', { conversation_key: first.conversation_key });
      await Promise.all([dispatch(first), dispatch(second), dispatch(first)]);
      const [a, b] = await Promise.all([response(first), response(second)]);
      assert.equal(a.status, 'completed', JSON.stringify(a));
      assert.equal(b.status, 'completed', JSON.stringify(b));
      const page = context.pages().find((p) => p.url() === b.conversation_url);
      assert.ok(page);
      assert.equal(await page.evaluate(() => fixture.clicks), 2);
      await dispatch(first);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await page.evaluate(() => fixture.clicks), 2);
    },
  );
  await check('partial paused stream times out and quarantines conversation', async () => {
    await mode('deepseek', 'paused');
    const j = job('deepseek', { timeout_ms: 1200 });
    await dispatch(j);
    const r = await response(j);
    assert.equal(r.status, 'timeout', JSON.stringify(r));
    assert.match(r.text, /^Partial/);
    const next = job('deepseek', { conversation_key: j.conversation_key });
    await dispatch(next);
    assert.match((await response(next)).error, /QUARANTINED/);
    await mode('deepseek', 'stream');
  });
  for (const [value, code] of [
    ['wrong-user', 'PROMPT_CORRELATION'],
    ['extra-turn', 'TAB_INTERFERENCE'],
    ['replace-answer', 'ANSWER_CHANGED'],
    ['captcha', 'CAPTCHA'],
    ['quota', 'QUOTA'],
  ]) {
    await check(`correlated adapter rejects ${value}`, async () => {
      await mode('deepseek', value);
      const j = job();
      await dispatch(j);
      const r = await response(j);
      assert.notEqual(r.status, 'completed', JSON.stringify(r));
      assert.match(r.error, new RegExp(code));
      assert.equal(r.text, '');
      await mode('deepseek', 'stream');
    });
  }
  await check('manual navigation of dedicated tab is rejected without altering it', async () => {
    const j = job();
    await dispatch(j);
    const r = await response(j);
    assert.equal(r.status, 'completed');
    const page = context.pages().find((p) => p.url() === r.conversation_url);
    await page.goto(origins.deepseek + '/c/manual');
    const next = job('deepseek', { conversation_key: j.conversation_key });
    await dispatch(next);
    assert.match((await response(next)).error, /TAB_NAVIGATED/);
    assert.equal(await page.evaluate(() => fixture.clicks), 0);
  });
  await check('missing provider tabs produce diagnostic and do not create a new tab', async () => {
    for (const page of context.pages()) if (page.url().startsWith(origins.qwen)) await page.close();
    const before = context.pages().length;
    const j = job('qwen');
    await dispatch(j);
    assert.match((await response(j)).error, /MISSING_PROVIDER_TAB/);
    assert.equal(context.pages().length, before);
  });
  await check('content adapter never returns an old completed assistant message', async () => {
    const page = await context.newPage();
    await page.goto(origins.deepseek + '/c/old-answer');
    await page.evaluate(() => localStorage.setItem('mock-mode', 'no-answer'));
    await page.reload();
    await page.addScriptTag({ path: path.join(work, 'adapter.js') });
    await page.addScriptTag({ path: path.join(work, 'config.js') });
    const r = await page.evaluate(
      async (j) => {
        const c = TestConfig.DEFAULT_SETTINGS.providers.deepseek;
        c.stable_ms = 100;
        c.poll_ms = 25;
        return new TestAdapter.DomAdapter(document, c).run(j, async () => {});
      },
      job('deepseek', { timeout_ms: 1000 }),
    );
    assert.equal(r.status, 'timeout');
    assert.equal(r.text, '');
    await mode('deepseek', 'stream');
    await page.close();
  });
  await check('login and CAPTCHA detected before any send; drafts preserved', async () => {
    for (const [value, code] of [
      ['login', 'LOGIN_REQUIRED'],
      ['captcha-before', 'CAPTCHA'],
      ['draft', 'USER_DRAFT'],
    ]) {
      await mode('deepseek', value);
      const page = await context.newPage();
      await page.goto(origins.deepseek + '/');
      await page.addScriptTag({ path: path.join(work, 'adapter.js') });
      await page.addScriptTag({ path: path.join(work, 'config.js') });
      const r = await page.evaluate(
        (j) =>
          new TestAdapter.DomAdapter(document, TestConfig.DEFAULT_SETTINGS.providers.deepseek).run(
            j,
            async () => {},
          ),
        job(),
      );
      assert.match(r.error, new RegExp(code));
      assert.equal(await page.evaluate(() => fixture.clicks), 0);
      if (value === 'draft')
        assert.equal(await page.locator('textarea').inputValue(), 'User unsent draft');
      await page.close();
    }
    await mode('deepseek', 'stream');
  });
  await check(
    'actual browser restart recovers sent request as unknown without resubmission',
    async () => {
      await mode('deepseek', 'paused');
      const j = job('deepseek', { timeout_ms: 20000 });
      await dispatch(j);
      await options.waitForFunction(
        async (id) =>
          (await chrome.storage.local.get(`request:${id}`))[`request:${id}`]?.phase === 'sent',
        j.request_id,
      );
      let clicked = false;
      const until = Date.now() + 5000;
      while (!clicked && Date.now() < until) {
        for (const page of context.pages())
          if (page.url().startsWith(origins.deepseek)) {
            clicked = await page.evaluate(
              (prompt) =>
                window.fixture?.clicks === 1 &&
                [...document.querySelectorAll('[data-message-role="user"]')].some(
                  (e) => e.innerText === prompt,
                ),
              j.prompt,
            );
            if (clicked) break;
          }
        if (!clicked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(clicked, 'prompt was actually clicked before restart');
      await context.close();
      context = await launch();
      const revivedOptions = await context.newPage();
      await revivedOptions.goto(`chrome-extension://${extensionId}/options.html`);
      worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', { timeout: 10000 }));
      await revivedOptions.waitForFunction(() =>
        document.querySelector('#config').value.includes('composer'),
      );
      const r = await response(j);
      assert.equal(r.status, 'unknown', JSON.stringify(r));
      assert.match(r.error, /WORKER_RESTART/);
      const before = context.pages().length;
      await dispatch(j);
      await response(j);
      assert.equal(context.pages().length, before);
      const next = job('deepseek', { conversation_key: j.conversation_key });
      await dispatch(next);
      assert.match((await response(next)).error, /QUARANTINED/);
    },
  );
  console.log(
    `Browser integration: ${checks} checks passed (Chromium ${context.browser()?.version() ?? 'persistent'}, real MV3; native port mocked; provider origins mapped to local HTTPS server).`,
  );
} catch (error) {
  for (const page of context.pages()) {
    console.error(
      'DEBUG PAGE',
      page.url(),
      await page
        .evaluate(() => ({
          ready: document.readyState,
          text: document.body?.innerText.slice(0, 150),
          rects: document.querySelector('textarea')?.getClientRects().length,
        }))
        .catch(() => ({})),
    );
  }
  throw error;
} finally {
  await context.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
