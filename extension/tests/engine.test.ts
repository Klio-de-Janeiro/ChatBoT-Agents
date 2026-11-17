import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, digest, type Store, type Platform, type RecordState } from '../src/engine';
import { DEFAULT_SETTINGS } from '../src/config';
import { Diagnostic, result, type Job, type Result } from '../src/protocol';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
class Memory implements Store {
  values = new Map<string, unknown>();
  fail?: (key: string, value: unknown) => boolean;
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async set(key: string, value: unknown) {
    if (this.fail?.(key, value)) throw new Error('disk full');
    this.values.set(key, structuredClone(value));
  }
  async all<T>(prefix: string) {
    return Object.fromEntries([...this.values].filter(([k]) => k.startsWith(prefix))) as Record<
      string,
      T
    >;
  }
}
const makeJob = (patch: Partial<Job> = {}): Job => ({
  type: 'job',
  request_id: crypto.randomUUID(),
  provider: 'deepseek',
  prompt: 'prompt',
  conversation_key: 'm:deepseek:author',
  timeout_ms: 3000,
  ...patch,
});
function harness() {
  const store = new Memory(),
    results: Result[] = [];
  let calls = 0,
    active = 0,
    maxActive = 0;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.enabled = ['deepseek', 'qwen'];
  const platform: Platform = {
    async settings() {
      return settings;
    },
    async prepare(job) {
      return {
        tabId: job.provider === 'deepseek' ? 1 : 2,
        token: 'token',
        url: `https://chat.${job.provider === 'qwen' ? 'qwen.ai' : 'deepseek.com'}/`,
      };
    },
    async run(job, _settings, conversation, authorize) {
      await authorize();
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      assert.equal((await store.get<RecordState>(`request:${job.request_id}`))!.phase, 'sent');
      await delay(20);
      active--;
      return result(job, 'completed', undefined, `answer ${calls}`, conversation.url);
    },
  };
  const engine = new Engine(store, platform, (r) => results.push(r));
  return {
    store,
    platform,
    engine,
    results,
    settings,
    get calls() {
      return calls;
    },
    get maxActive() {
      return maxActive;
    },
  };
}
test('duplicate ID including simultaneous delivery submits once; result replay is idempotent', async () => {
  const h = harness(),
    j = makeJob();
  await Promise.all([h.engine.accept(j), h.engine.accept(j)]);
  assert.equal(h.calls, 1);
  await h.engine.accept(j);
  assert.equal(h.calls, 1);
  assert.equal(h.results.length, 2);
  assert.equal(h.results[1]!.status, 'completed');
  await h.engine.accept({ ...j, prompt: 'different' });
  assert.match(h.results.at(-1)!.error!, /REQUEST_ID_CONFLICT/);
  assert.equal(h.calls, 1);
  await h.engine.replay();
  assert.equal(h.results.at(-1)!.status, 'completed');
});
test('per-tab serialization and concurrent providers', async () => {
  const serial = harness();
  await Promise.all([
    serial.engine.accept(makeJob()),
    serial.engine.accept(makeJob({ conversation_key: 'second-role' })),
  ]);
  assert.equal(serial.maxActive, 1);
  const parallel = harness();
  await Promise.all([
    parallel.engine.accept(makeJob()),
    parallel.engine.accept(makeJob({ provider: 'qwen' })),
  ]);
  assert.equal(parallel.maxActive, 2);
});
test('worker recovery converts both reserved and sent to unknown and never resends', async () => {
  for (const phase of ['reserved', 'sent'] as const) {
    const h = harness(),
      j = makeJob(),
      key = await digest([j.provider, j.conversation_key]);
    await h.store.set(`request:${j.request_id}`, {
      fingerprint: await digest([j.provider, j.prompt, j.conversation_key, j.timeout_ms]),
      phase,
      conversation: key,
      provider: j.provider,
    });
    await h.engine.recover();
    await h.engine.accept(j);
    assert.equal(h.calls, 0);
    assert.equal(h.results[0]!.status, 'unknown');
    await h.engine.accept(makeJob());
    assert.match(h.results.at(-1)!.error!, /QUARANTINED/);
  }
});
test('storage barriers prevent submission and ambiguous conversations are quarantined', async () => {
  const h = harness();
  h.store.fail = (_key, value) => (value as RecordState)?.phase === 'sent';
  await h.engine.accept(makeJob());
  assert.equal(h.calls, 0);
  assert.equal(h.results.at(-1)!.status, 'failed');
  const ambiguous = harness();
  ambiguous.platform.run = async (job, _s, c, authorize) => {
    await authorize();
    return result(job, 'timeout', 'DOM_TIMEOUT', '', c.url);
  };
  await ambiguous.engine.accept(makeJob());
  await ambiguous.engine.accept(makeJob());
  assert.match(ambiguous.results.at(-1)!.error!, /QUARANTINED/);
});
test('final persistence failure also quarantines in the running worker', async () => {
  const h = harness();
  h.store.fail = (_k, v) => (v as RecordState)?.phase === 'final';
  await h.engine.accept(makeJob());
  assert.equal(h.calls, 1);
  assert.equal(h.results[0]!.status, 'unknown');
  h.store.fail = undefined;
  await h.engine.accept(makeJob());
  assert.equal(h.calls, 1);
  assert.match(h.results.at(-1)!.error!, /QUARANTINED/);
});
test('disabled providers and invalid jobs do not reach browser', async () => {
  const h = harness();
  h.settings.enabled = [];
  await h.engine.accept(makeJob());
  assert.equal(h.calls, 0);
  assert.match(h.results[0]!.error!, /DOMAIN_DISABLED/);
  await h.engine.accept({ ...makeJob(), provider: 'evil' });
  assert.match(h.results.at(-1)!.error!, /INVALID_JOB/);
});
test('content failures after persisted sent never permit a new turn', async () => {
  const h = harness();
  h.platform.run = async (_j, _s, _c, authorize) => {
    await authorize();
    throw new Diagnostic('TAB_GONE', 'closed', 'unknown');
  };
  await h.engine.accept(makeJob());
  await h.engine.accept(makeJob());
  assert.equal(h.results[0]!.status, 'unknown');
  assert.match(h.results[1]!.error!, /QUARANTINED/);
});
