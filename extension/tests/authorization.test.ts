import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPlatform } from '../src/browser';

test('submission authorization binds extension, tab, frame, origin, request and document', async () => {
  (globalThis as any).chrome = { runtime: { id: 'extension-id' } };
  const p = new BrowserPlatform();
  let sent = 0;
  const record = {
    tabId: 7,
    provider: 'qwen' as const,
    nonce: 'nonce',
    documentToken: 'document',
    authorized: false,
    authorize: async () => {
      sent++;
    },
  };
  const message = { request_id: 'request', nonce: 'nonce', document_token: 'document' };
  const sender = {
    id: 'extension-id',
    frameId: 0,
    url: 'https://chat.qwen.ai/',
    tab: { id: 7, url: 'https://chat.qwen.ai/', incognito: false },
  } as chrome.runtime.MessageSender;
  p.pending.set('request', record);
  for (const patch of [
    { id: 'other' },
    { frameId: 1 },
    { url: 'https://evil.test' },
    { origin: 'https://evil.test' },
    { tab: { id: 8, url: 'https://chat.qwen.ai/' } },
    { tab: { id: 7, url: 'https://evil.test' } },
  ])
    assert.equal(
      (await p.authorize(message, { ...sender, ...patch } as chrome.runtime.MessageSender))
        .authorized,
      false,
    );
  for (const patch of [{ nonce: 'other' }, { document_token: 'old' }, { request_id: 'other' }])
    assert.equal((await p.authorize({ ...message, ...patch }, sender)).authorized, false);
  assert.equal(sent, 0);
  assert.equal((await p.authorize(message, sender)).authorized, true);
  assert.equal(sent, 1);
  assert.equal((await p.authorize(message, sender)).authorized, false);
  assert.equal(sent, 1);
});
