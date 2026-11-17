import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJob, originProvider, validResult, result, MAX_PROMPT_BYTES } from '../src/protocol';
import { parseSettings, DEFAULT_SETTINGS } from '../src/config';
const job = {
  type: 'job' as const,
  request_id: '11111111-1111-4111-8111-111111111111',
  provider: 'qwen' as const,
  prompt: 'hello',
  conversation_key: 'material:qwen:author',
  timeout_ms: 1000,
};
test('wire accepts canonical job and rejects malformed/unbounded jobs', () => {
  assert.deepEqual(parseJob(job), job);
  for (const patch of [
    { request_id: '../foo' },
    { prompt: '' },
    { prompt: 'a'.repeat(MAX_PROMPT_BYTES + 1) },
    { prompt: 'я'.repeat(MAX_PROMPT_BYTES / 2 + 1) },
    { provider: 'other' },
    { timeout_ms: 0 },
    { timeout_ms: 3_600_001 },
    { timeout_ms: Infinity },
    { conversation_key: 'x\n' },
    { extra: 'code' },
  ])
    assert.throws(() => parseJob({ ...job, ...patch }));
  assert.equal(parseJob({ ...job, timeout_ms: 1 }).timeout_ms, 1);
  assert.equal(parseJob({ ...job, timeout_ms: 3_600_000 }).timeout_ms, 3_600_000);
  assert.equal(
    parseJob({ ...job, prompt: 'a'.repeat(MAX_PROMPT_BYTES) }).prompt.length,
    MAX_PROMPT_BYTES,
  );
  assert.throws(() => parseJob({ ...job, prompt: '\n'.repeat(MAX_PROMPT_BYTES - 1) + 'a' }));
  for (const value of [null, [], 42, 'job']) assert.throws(() => parseJob(value));
});
test('origin allowlist is exact HTTPS and rejects deceptive URLs', () => {
  assert.equal(originProvider('https://chat.qwen.ai/c/123'), 'qwen');
  for (const url of [
    'http://chat.qwen.ai',
    'https://chat.qwen.ai.evil.test',
    'https://evil.test/chat.qwen.ai',
    'https://chat.qwen.ai:8443',
    'https://name@chat.qwen.ai',
    'https://qwen.ai',
    'file:///chat.qwen.ai',
    undefined,
  ])
    assert.equal(originProvider(url), undefined);
});
test('result correlation and response bounds are validated', () => {
  const r = result(job, 'completed', undefined, 'answer', 'https://chat.qwen.ai/c/1');
  assert.equal(validResult(r, job), true);
  for (const patch of [
    { request_id: crypto.randomUUID() },
    { text: '' },
    { status: 'ok' },
    { conversation_url: 'https://evil.test' },
    { error: 3 },
  ])
    assert.equal(validResult({ ...r, ...patch }, job), false);
});
test('settings have explicit opt-in and cannot redefine origins or code', () => {
  assert.deepEqual(parseSettings(DEFAULT_SETTINGS).enabled, []);
  assert.throws(() => parseSettings({ ...DEFAULT_SETTINGS, origin: 'https://evil.test' }));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.providers.qwen.poll_ms = 1;
  assert.throws(() => parseSettings(settings));
});
