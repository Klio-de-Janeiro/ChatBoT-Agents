import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { build } from 'esbuild';

// Structural fixtures from observed signed-in DOM. No account data or transcripts.
await mkdir('work', { recursive: true });
await build({
  entryPoints: ['src/dom.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Adapter',
  outfile: 'work/live-adapter.js',
});
await build({
  entryPoints: ['src/config.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Config',
  outfile: 'work/live-config.js',
});
const browser = await chromium.launch({ headless: true });
try {
  for (const [provider, replaceButton] of [
    ['deepseek', false],
    ['qwen', false],
    ['qwen', true],
  ]) {
    const page = await browser.newPage();
    await page.setContent(`
      <a href="/a/chat/s/old">History</a><button class="user-menu-btn">Account</button>
      <main></main><textarea class="message-input-textarea" placeholder="Сообщение для DeepSeek"></textarea>
      <${provider === 'deepseek' ? 'div' : 'button'} class="send-button ds-button--primary ds-button--circle" role="button">Send</${provider === 'deepseek' ? 'div' : 'button'}>
    `);
    await page.addScriptTag({ path: 'work/live-adapter.js' });
    await page.addScriptTag({ path: 'work/live-config.js' });
    const result = await page.evaluate(
      async ({ provider, replaceButton }) => {
        const config = structuredClone(Config.DEFAULT_SETTINGS.providers[provider]);
        config.stable_ms = 100;
        config.poll_ms = 25;
        let clicks = 0;
        const wireButton = (button) => {
          button.onclick = () => {
            if (!button.isConnected) return;
            clicks++;
            const prompt = document.querySelector('textarea').value;
            document.querySelector('textarea').value = '';
            document.querySelector('main').innerHTML =
              provider === 'deepseek'
                ? `<div class="ds-message d29f3d7d"><div class="fbb737a4"></div></div>
               <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Final answer</div></div>
               <div class="ds-flex"><div role="button">Copy</div></div>`
                : `<div class="qwen-chat-message-user"><p class="user-message-content"></p></div>
               <div class="qwen-chat-message-assistant"><div class="response-message-content"><div class="qwen-markdown">Final answer</div></div>
               <button class="qwen-chat-package-comp-new-action-control-container-copy">Copy</button></div>`;
            document.querySelector(
              provider === 'deepseek' ? '.fbb737a4' : '.user-message-content',
            ).textContent = prompt;
          };
        };
        wireButton(document.querySelector('.send-button'));
        const job = {
          type: 'job',
          request_id: '11111111-1111-4111-8111-111111111111',
          provider,
          prompt: 'Fixture request',
          conversation_key: 'fixture',
          timeout_ms: 1200,
        };
        const response = await new Adapter.DomAdapter(document, config).run(job, async () => {
          if (replaceButton) {
            const old = document.querySelector('.send-button');
            const replacement = old.cloneNode(true);
            old.replaceWith(replacement);
            wireButton(replacement);
          }
        });
        return { response, clicks };
      },
      { provider, replaceButton },
    );
    assert.equal(
      result.response.status,
      'completed',
      JSON.stringify({ provider, replaceButton, ...result }),
    );
    assert.equal(result.clicks, 1);
    assert.equal(result.response.text, 'Final answer');
    console.log(`PASS live DOM fixture: ${provider}, replaceButton=${replaceButton}`);
    await page.close();
  }
} finally {
  await browser.close();
}
