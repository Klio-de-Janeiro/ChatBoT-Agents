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
globalThis.__native={out:[],errors:[],listeners:[],disconnects:[],post(message){for(const listener of this.listeners)listener(message)}};
for(const [group,name] of [['windows','create'],['windows','get'],['tabs','query'],['tabs','get']]){
  const original=chrome[group][name].bind(chrome[group]);
  chrome[group][name]=async(...args)=>{try{return await original(...args)}catch(error){__native.errors.push([group+'.'+name,error.message]);throw error}};
}
chrome.runtime.connectNative=(name)=>{if(name!=='com.multichat.agent')throw new Error('Wrong host');return {
postMessage(message){__native.out.push(message)},onMessage:{addListener(fn){__native.listeners.push(fn)}},
onDisconnect:{addListener(fn){__native.disconnects.push(fn)}}}};
importScripts('background.js');
`,
);
const manifest = JSON.parse(await readFile(path.join(harness, 'manifest.json'), 'utf8'));
manifest.background.service_worker = 'native-harness.js';
// Simulate an already loaded page after an extension upgrade.
manifest.content_scripts[0].exclude_matches = ['https://chat.qwen.ai/c/stale-fixture'];
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
      '--screen-info={0,0 800x600}',
      '--window-size=800,600',
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
      // Plain text stays the compatibility contract (innerText of the mock DOM).
      assert.match(a.text, new RegExp('^Answer for ' + deepseek.prompt));
      assert.match(a.text, /E=mc² keeps working\./);
      assert.match(a.text, /\nprint\(42\)$/);
      // ...and the provider-native capture travels next to it.
      assert.match(a.markdown, new RegExp('^### Answer for \\*' + deepseek.prompt + '\\*$', 'm'));
      assert.match(a.markdown, /Energy: \$E = mc\^2\$ keeps working\./);
      assert.match(a.markdown, /\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
      assert.match(a.markdown, /```python\nprint\(42\)\n```/);
      assert.equal(a.content.version, 1);
      assert.deepEqual(
        a.content.blocks.map((block) => block.type),
        ['heading', 'paragraph', 'table', 'code'],
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
  await check(
    'open and ask share a tab, and draft replacement requires explicit consent',
    async () => {
      for (const provider of ['deepseek', 'qwen']) {
        const before = new Set(context.pages());
        const opened = job(provider, { operation: 'open', modes: { think: true, search: true } });
        await dispatch(opened);
        const r = await response(opened);
        assert.equal(r.status, 'completed', JSON.stringify(r));
        assert.equal(r.text, '');
        const page = signed[provider];
        assert.equal(context.pages().length, before.size);
        assert.equal(page.url(), r.conversation_url);
        const initial = await page.evaluate(() => ({
          fixture,
          modeFixture,
          composer: document.querySelector('textarea').value,
        }));
        assert.equal(initial.fixture.clicks, 0);
        assert.equal(initial.modeFixture.inputEvents, 0);
        assert.equal(initial.composer, '');
        assert.deepEqual(
          initial.modeFixture.order,
          provider === 'qwen' ? ['search', 'reasoning'] : ['search', 'think'],
        );
        const repeat = job(provider, {
          operation: 'open',
          conversation_key: opened.conversation_key,
          modes: { search: true, think: true },
        });
        await dispatch(repeat);
        assert.equal((await response(repeat)).status, 'completed');
        await dispatch(opened);
        assert.equal((await response(opened)).status, 'completed');
        assert.deepEqual(await page.evaluate(() => modeFixture.events), initial.modeFixture.events);
        const unsupported = job(provider, {
          conversation_key: opened.conversation_key,
          modes: { model: 'unregistered' },
        });
        await dispatch(unsupported);
        const rejected = await response(unsupported);
        assert.equal(rejected.status, 'needs_user_action');
        assert.match(rejected.error, /MODE_UNSUPPORTED/);
        assert.equal(await page.evaluate(() => modeFixture.inputEvents), 0);
        assert.equal(await page.evaluate(() => fixture.clicks), 0);
        const textarea = page.locator('textarea');
        await textarea.fill('Draft from an earlier test');
        const blocked = job(provider);
        await dispatch(blocked);
        assert.match((await response(blocked)).error, /USER_DRAFT/);
        assert.equal(await textarea.inputValue(), 'Draft from an earlier test');
        const ask = job(provider, {
          modes: { think: false, search: false, 'replace-draft': true },
        });
        await dispatch(ask);
        const answer = await response(ask);
        assert.equal(answer.status, 'completed', JSON.stringify(answer));
        const answerPage = context.pages().find((p) => p.url() === answer.conversation_url);
        assert.equal(answerPage, page);
        assert.equal(context.pages().length, before.size);
        const sent = await answerPage.evaluate(() => fixture.sentModes);
        if (provider === 'deepseek') assert.equal(sent.think, 'false');
        else {
          assert.equal(sent.reasoning, 'Fast');
          assert.equal(sent.tool, undefined);
        }
        assert.equal(await answerPage.evaluate(() => fixture.clicks), 1);
      }
    },
  );
  await check(
    'already loaded tab reconnects after extension update without losing its draft',
    async () => {
      const page = await context.newPage();
      const url = origins.qwen + '/c/stale-fixture';
      await page.goto(url);
      const textarea = page.locator('textarea');
      await textarea.fill('Draft to preserve');
      const before = context.pages().length;
      const opened = job('qwen', { operation: 'open', chat_url: url });
      await dispatch(opened);
      assert.equal((await response(opened)).status, 'completed');
      const blocked = job('qwen');
      await dispatch(blocked);
      assert.match((await response(blocked)).error, /USER_DRAFT/);
      assert.equal(await textarea.inputValue(), 'Draft to preserve');
      assert.equal(page.url(), url);
      assert.equal(context.pages().length, before);
      const allowed = job('qwen', { modes: { 'replace-draft': true } });
      await dispatch(allowed);
      const answer = await response(allowed);
      assert.equal(answer.status, 'completed', JSON.stringify(answer));
      assert.equal(page.url(), answer.conversation_url);
      assert.equal(context.pages().length, before);
      assert.equal(await page.evaluate(() => fixture.clicks), 1);
      await page.close();
    },
  );
  await check('open and ask leave the selected Chrome tab unchanged', async () => {
    await options.bringToFront();
    const selected = () =>
      worker.evaluate(async () => {
        const page = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        return page && { id: page.id, url: page.url };
      });
    const before = await selected();
    assert.equal(before.url, options.url());
    const opened = job('qwen', { operation: 'open' });
    await dispatch(opened);
    assert.equal((await response(opened)).status, 'completed');
    assert.deepEqual(await selected(), before);
    const ask = job('qwen');
    await dispatch(ask);
    const answer = await response(ask);
    assert.equal(answer.status, 'completed', JSON.stringify(answer));
    assert.deepEqual(await selected(), before);
  });
  await check('open uses the same tab for a saved chat and preserves drafts', async () => {
    const page = await context.newPage();
    await page.goto(origins.deepseek + '/');
    const original = page.url();
    const target = origins.deepseek + '/a/chat/s/old-chat';
    const count = context.pages().length;
    const composer = page.locator('textarea');
    await composer.fill('Unsent draft');
    const blocked = job('deepseek', { operation: 'open', chat_url: target });
    await dispatch(blocked);
    assert.match((await response(blocked)).error, /USER_DRAFT/);
    assert.equal(page.url(), original);
    assert.equal(await composer.inputValue(), 'Unsent draft');

    await composer.fill('');
    const viewing = job('deepseek', { operation: 'open', chat_url: target });
    await dispatch(viewing);
    const shown = await response(viewing);
    assert.equal(shown.status, 'completed', JSON.stringify(shown));
    assert.equal(shown.conversation_url, target);
    assert.equal(page.url(), target);
    assert.equal(context.pages().length, count);
    assert.equal(await page.evaluate(() => fixture.clicks), 0);
    await page.close();
  });
  await check('new ask clears an automatically restored chat before sending', async () => {
    await mode('deepseek', 'restored');
    try {
      const ask = job('deepseek');
      await dispatch(ask);
      const answer = await response(ask);
      assert.equal(answer.status, 'completed', JSON.stringify(answer));
      const page = context.pages().find((p) => p.url() === answer.conversation_url);
      assert.ok(page);
      assert.equal(await page.evaluate(() => fixture.clicks), 1);
      assert.equal(await page.locator('[data-message-role="user"]').count(), 1);
    } finally {
      await mode('deepseek', 'stream');
    }
  });
  await check('saved follow-up ignores a stale preparation for a different chat', async () => {
    await mode('deepseek', 'saved-followup');
    const page = await context.newPage();
    const original = origins.deepseek + '/a/chat/s/other-chat';
    const target = origins.deepseek + '/a/chat/s/follow-up-chat';
    try {
      await page.goto(original);
      const viewed = job('deepseek', { operation: 'open', chat_url: original });
      await dispatch(viewed);
      assert.equal((await response(viewed)).status, 'completed');
      await page.evaluate(() => history.replaceState(null, '', '?ref=restored'));
      const ask = job('deepseek', { chat_url: target });
      await dispatch(ask);
      const answer = await response(ask);
      assert.equal(answer.status, 'completed', JSON.stringify(answer));
      assert.equal(answer.conversation_url, target);
      assert.match(answer.text, new RegExp(ask.prompt));
      assert.equal(await page.evaluate(() => fixture.clicks), 0);
      assert.equal(page.url(), original + '?ref=restored');
    } finally {
      await page.close();
      await mode('deepseek', 'stream');
    }
  });
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
  for (const worker of context.serviceWorkers())
    console.error(
      'DEBUG CHROME API',
      await worker.evaluate(() => globalThis.__native?.errors).catch(() => []),
    );
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
