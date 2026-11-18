import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPlatform } from '../src/browser';
import { DEFAULT_SETTINGS } from '../src/config';
import type { Job } from '../src/protocol';

const job: Job = {
  type: 'job',
  request_id: crypto.randomUUID(),
  provider: 'deepseek',
  prompt: 'Open sentinel',
  conversation_key: 'fresh-window',
  timeout_ms: 1000,
  operation: 'ask',
};
function browserMock(probePatch: Record<string, unknown> = {}, hasSource = true) {
  const local: Record<string, unknown> = {},
    session: Record<string, unknown> = {};
  const calls: {
    created: number;
    sourceProbes: number;
    newProbes: number;
    createOptions?: chrome.windows.CreateData;
  } = { created: 0, sourceProbes: 0, newProbes: 0 };
  const area = (values: Record<string, unknown>) => ({
    async get(key: string) {
      return { [key]: values[key] };
    },
    async set(value: Record<string, unknown>) {
      Object.assign(values, value);
    },
  });
  (globalThis as any).chrome = {
    storage: { local: area(local), session: area(session) },
    tabs: {
      async query() {
        return hasSource
          ? [{ id: 1, incognito: false, url: 'https://chat.deepseek.com/a/chat/s/user-owned' }]
          : [];
      },
      async get() {
        return { id: 2, incognito: false, url: 'https://chat.deepseek.com/' };
      },
      async sendMessage(id: number) {
        if (id === 1) {
          calls.sourceProbes++;
          throw new Error('Stale source content script');
        }
        calls.newProbes++;
        return {
          ready: true,
          signedIn: true,
          url: 'https://chat.deepseek.com/',
          document_token: 'fresh-document',
          message_count: 0,
          draft: false,
          ...probePatch,
        };
      },
    },
    windows: {
      async create(options: chrome.windows.CreateData) {
        calls.createOptions = options;
        calls.created++;
        return { id: 2, tabs: [{ id: 2 }] };
      },
    },
  };
  return calls;
}
test('fresh owned page authenticates despite stale user-tab script; source tab untouched', async () => {
  const calls = browserMock();
  const prepared = await new BrowserPlatform().prepare(
    job,
    structuredClone(DEFAULT_SETTINGS),
    'fresh',
  );
  assert.equal(prepared.tabId, 2);
  assert.equal(calls.created, 1);
  assert.equal(calls.sourceProbes, 0);
  assert.equal(calls.newProbes, 1);
  assert.deepEqual(calls.createOptions, {
    url: 'https://chat.deepseek.com/',
    type: 'normal',
    focused: true,
  });
});
test('missing provider tab never creates a work window', async () => {
  const calls = browserMock({}, false);
  await assert.rejects(
    () => new BrowserPlatform().prepare(job, structuredClone(DEFAULT_SETTINGS), 'missing'),
    /MISSING_PROVIDER_TAB/,
  );
  assert.equal(calls.created, 0);
});
test('login in the fresh owned page blocks open and ask before running content', async () => {
  const calls = browserMock({
    ready: false,
    signedIn: false,
    error: 'LOGIN_REQUIRED: Sign in manually',
  });
  await assert.rejects(
    () => new BrowserPlatform().prepare(job, structuredClone(DEFAULT_SETTINGS), 'login'),
    /NEW_CHAT_BLOCKED.*LOGIN_REQUIRED/,
  );
  assert.equal(calls.created, 1);
  assert.equal(calls.sourceProbes, 0);
  assert.equal(calls.newProbes, 1);
});

test('saved chat opens without a source tab and rejects redirection', async () => {
  const chat_url = 'https://chat.deepseek.com/a/chat/s/existing-chat';
  const followUp = { ...job, chat_url };
  const settings = structuredClone(DEFAULT_SETTINGS);
  const calls = browserMock({ url: chat_url, message_count: 2 }, false);
  const prepared = await new BrowserPlatform().prepare(followUp, settings, 'resume');
  assert.equal(prepared.url, chat_url);
  assert.equal(calls.createOptions?.url, chat_url);

  browserMock({ url: 'https://chat.deepseek.com/', message_count: 2 }, false);
  await assert.rejects(
    () => new BrowserPlatform().prepare(followUp, settings, 'redirected'),
    /CHAT_URL_CHANGED/,
  );
});
