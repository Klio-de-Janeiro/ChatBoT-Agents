import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

await mkdir('work', { recursive: true });
await build({
  entryPoints: ['src/dom.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Adapter',
  outfile: 'work/mode-adapter.js',
});
await build({
  entryPoints: ['src/config.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Config',
  outfile: 'work/mode-config.js',
});
const html = await readFile('tests/fixtures/chat.html', 'utf8');
const browser = await chromium.launch({ headless: true });
let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`PASS mode fixture: ${name}`);
}
async function page() {
  const page = await browser.newPage();
  await page.route('https://mode-fixture.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto('https://mode-fixture.test/');
  await page.addScriptTag({ path: 'work/mode-adapter.js' });
  await page.addScriptTag({ path: 'work/mode-config.js' });
  return page;
}
async function run(page, provider, modes, operation = 'open') {
  return page.evaluate(
    async ({ provider, modes, operation }) => {
      const config = structuredClone(Config.DEFAULT_SETTINGS.providers[provider]);
      config.poll_ms = 25;
      config.stable_ms = 100;
      config.modes.timeout_ms = 250;
      config.modes.settle_ms = 75;
      const adapter = new Adapter.DomAdapter(document, config);
      const response = await adapter.run(
        {
          type: 'job',
          request_id: crypto.randomUUID(),
          provider,
          prompt: 'DO NOT SEND this open sentinel',
          conversation_key: 'modes-fixture',
          timeout_ms: 1800,
          operation,
          modes,
        },
        async () => {
          window.barriers = (window.barriers || 0) + 1;
        },
      );
      return {
        response,
        fixture: window.fixture,
        modes: window.modeFixture,
        composer: document.querySelector('textarea').value,
        barriers: window.barriers || 0,
      };
    },
    { provider, modes, operation },
  );
}
try {
  await check(
    'open leaves composer, input events and submit barrier untouched; omitted modes untouched',
    async () => {
      const p = await page();
      await p.locator('textarea').fill('Existing draft');
      const before = await p.evaluate(() => modeFixture.inputEvents);
      const out = await run(p, 'deepseek', {});
      assert.equal(out.response.status, 'completed', JSON.stringify(out));
      assert.equal(out.response.text, '');
      assert.equal(out.composer, 'Existing draft');
      assert.equal(out.modes.inputEvents, before);
      assert.equal(out.fixture.clicks, 0);
      assert.equal(out.barriers, 0);
      assert.deepEqual(out.modes.order, []);
      await p.close();
    },
  );
  await check(
    'DeepSeek Enter toggles on and off once; repeated desired states do not toggle',
    async () => {
      const p = await page();
      for (const state of [true, true, false, false]) {
        const out = await run(p, 'deepseek', { think: state, search: state });
        assert.equal(out.response.status, 'completed', JSON.stringify(out));
        assert.equal(out.fixture.clicks, 0);
        assert.equal(out.modes.inputEvents, 0);
      }
      const events = await p.evaluate(() => modeFixture.events);
      assert.equal(events.think, 2);
      assert.equal(events.search, 2);
      await p.close();
    },
  );
  await check(
    'Qwen search is set before thinking; repeat is idempotent and auto/false choose exact states',
    async () => {
      const p = await page();
      let out = await run(p, 'qwen', { think: true, search: true });
      assert.equal(out.response.status, 'completed', JSON.stringify(out));
      assert.deepEqual(out.modes.order, ['search', 'reasoning']);
      out = await run(p, 'qwen', { search: true, think: true });
      assert.deepEqual(out.modes.order, ['search', 'reasoning']);
      out = await run(p, 'qwen', { reasoning: 'auto', search: false });
      assert.equal(out.response.status, 'completed', JSON.stringify(out));
      assert.equal(await p.locator('.qwen-chat-v2-dropdown-menu-select-label').innerText(), 'Auto');
      assert.equal(out.modes.events.close, 1);
      out = await run(p, 'qwen', { think: false });
      assert.equal(out.response.status, 'completed', JSON.stringify(out));
      assert.equal(await p.locator('.qwen-chat-v2-dropdown-menu-select-label').innerText(), 'Fast');
      assert.equal(out.fixture.clicks, 0);
      await p.close();
    },
  );
  await check('search off preserves an unrelated Qwen tool', async () => {
    const p = await page();
    await p.evaluate(() => setFixtureTool('Image generation'));
    const out = await run(p, 'qwen', { search: false });
    assert.equal(out.response.status, 'completed', JSON.stringify(out));
    assert.equal(await p.locator('.mode-select-current-mode').innerText(), 'Image generation');
    assert.equal(out.modes.events.close, 0);
    await p.close();
  });
  await check(
    'unsupported names/values and alias conflicts stop before any composer or mode mutation',
    async () => {
      for (const [provider, modes, code] of [
        ['deepseek', { model: 'anything' }, 'MODE_UNSUPPORTED'],
        ['deepseek', { think: 'true' }, 'MODE_VALUE_UNSUPPORTED'],
        ['qwen', { think: true, reasoning: 'thinking' }, 'MODE_CONFLICT'],
      ]) {
        const p = await page();
        const out = await run(p, provider, modes, 'ask');
        assert.equal(out.response.status, 'needs_user_action');
        assert.match(out.response.error, new RegExp(code));
        assert.equal(out.composer, '');
        assert.equal(out.modes.inputEvents, 0);
        assert.equal(out.fixture.clicks, 0);
        assert.deepEqual(out.modes.order, []);
        await p.close();
      }
    },
  );
  await check('ignored toggle fails once without blind retry or prompt submission', async () => {
    const p = await page();
    await p.evaluate(() => (modeFixture.failure = 'ignore-think'));
    const out = await run(p, 'deepseek', { think: true }, 'ask');
    assert.equal(out.response.status, 'needs_user_action');
    assert.match(out.response.error, /MODE_VERIFY_FAILED/);
    assert.equal(out.modes.events.think, 1);
    assert.equal(out.modes.inputEvents, 0);
    assert.equal(out.fixture.clicks, 0);
    await p.close();
  });
  await check(
    'partial change failure reports verified changes and leaves prompt unsent',
    async () => {
      const p = await page();
      await p.evaluate(() => (modeFixture.failure = 'ignore-reasoning'));
      const out = await run(p, 'qwen', { search: true, think: true }, 'ask');
      assert.equal(out.response.status, 'needs_user_action');
      assert.match(out.response.error, /qwen.think/);
      assert.match(out.response.error, /changes already verified: search=on/);
      assert.equal(out.modes.inputEvents, 0);
      assert.equal(out.fixture.clicks, 0);
      await p.close();
    },
  );
  await check('final verification catches a later control resetting an earlier state', async () => {
    const p = await page();
    await p.evaluate(() => (modeFixture.failure = 'reset-search'));
    const out = await run(p, 'qwen', { search: true, think: true }, 'ask');
    assert.equal(out.response.status, 'needs_user_action');
    assert.match(out.response.error, /MODE_VERIFY_FAILED.*qwen.search/);
    assert.equal(out.modes.inputEvents, 0);
    assert.equal(out.fixture.clicks, 0);
    await p.close();
  });
  await check(
    'missing/ambiguous controls and unreadable state fail before any change',
    async () => {
      for (const action of ['missing', 'ambiguous', 'state']) {
        const p = await page();
        await p.evaluate((action) => {
          const button = document.querySelector('.ds-toggle-button');
          if (action === 'missing') button.remove();
          if (action === 'ambiguous') button.after(button.cloneNode(true));
          if (action === 'state') button.removeAttribute('aria-pressed');
        }, action);
        const out = await run(p, 'deepseek', { search: true, think: true }, 'ask');
        assert.equal(out.response.status, 'needs_user_action');
        assert.match(
          out.response.error,
          /MODE_CONTROL_MISSING|MODE_CONTROL_AMBIGUOUS|MODE_STATE_UNREADABLE/,
        );
        assert.deepEqual(out.modes.order, []);
        assert.equal(out.modes.inputEvents, 0);
        await p.close();
      }
    },
  );
  await check(
    'collapsed authenticated sidebar counts as evidence; visible login still wins',
    async () => {
      const p = await page();
      await p.evaluate(() => {
        document.querySelector('nav').style.display = 'none';
        document.querySelector('nav').innerHTML = '<a href="/a/chat/s/old">History</a>';
      });
      assert.equal(
        await p.locator('nav a').evaluate((element) => element.getClientRects().length),
        0,
      );
      let probe = await p.evaluate(() =>
        new Adapter.DomAdapter(document, Config.DEFAULT_SETTINGS.providers.deepseek).probe(),
      );
      assert.equal(probe.signedIn, true);
      assert.equal(probe.ready, true);
      await p.evaluate(() =>
        document.body.insertAdjacentHTML('beforeend', '<input type="password">'),
      );
      probe = await p.evaluate(() =>
        new Adapter.DomAdapter(document, Config.DEFAULT_SETTINGS.providers.deepseek).probe(),
      );
      assert.equal(probe.signedIn, false);
      assert.match(probe.error, /LOGIN_REQUIRED/);
      await p.close();
    },
  );
  await check(
    'search off requires an observable Qwen control before claiming success',
    async () => {
      const p = await page();
      await p.locator('#tools-trigger').evaluate((element) => element.remove());
      const out = await run(p, 'qwen', { search: false }, 'ask');
      assert.equal(out.response.status, 'needs_user_action');
      assert.match(out.response.error, /MODE_CONTROL_MISSING/);
      assert.equal(out.modes.inputEvents, 0);
      assert.equal(out.fixture.clicks, 0);
      await p.close();
    },
  );
  console.log(
    `Mode DOM fixtures: ${checks} checks passed; local pages only, no real service requests.`,
  );
} finally {
  await browser.close();
}
