import {
  Diagnostic,
  isObject,
  parseJob,
  result,
  validId,
  validResult,
  type Job,
  type Result,
  type Provider,
  canonicalModes,
} from './protocol';
import type { Settings } from './config';
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  all<T>(prefix: string): Promise<Record<string, T>>;
}
export type Conversation = {
  tabId: number;
  token: string;
  url: string;
  blocked?: boolean;
  view?: true;
  prepared?: true;
};
export interface Platform {
  settings(): Promise<Settings>;
  prepare(job: Job, settings: Settings, key: string): Promise<Conversation>;
  run(
    job: Job,
    settings: Settings,
    conversation: Conversation,
    authorize: () => Promise<void>,
  ): Promise<Result>;
}
export type RecordState = {
  fingerprint: string;
  phase: 'reserved' | 'sent' | 'final';
  conversation: string;
  provider: Provider;
  result?: Result;
};
export class Serial {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
export async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function legacyFingerprint(job: Job): Promise<string> {
  return digest([job.provider, job.prompt, job.conversation_key, job.timeout_ms]);
}
export function requestFingerprint(job: Job): Promise<string> {
  return digest([
    job.provider,
    job.prompt,
    job.conversation_key,
    job.timeout_ms,
    job.operation ?? 'ask',
    canonicalModes(job.modes),
    ...(job.chat_url ? [job.chat_url] : []),
  ]);
}
export class Engine {
  private reservation = new Serial();
  private queue = new Serial();
  private tabs = new Serial();
  private quarantined = new Set<string>();
  constructor(
    public store: Store,
    public platform: Platform,
    public emit: (r: Result) => void,
    public diagnostic: (m: string) => void = () => {},
  ) {}
  async recover(): Promise<void> {
    for (const [key, r] of Object.entries(await this.store.all<RecordState>('request:'))) {
      if (r.phase === 'final') continue;
      const request_id = key.slice('request:'.length);
      const conversation = await this.store.get<Conversation>(`conversation:${r.conversation}`);
      const response = result(
        { request_id },
        'unknown',
        'WORKER_RESTART: Delivery may have occurred; do not retry',
        '',
        conversation?.url ?? '',
      );
      await this.store.set(`blocked:${r.conversation}`, true);
      await this.store.set(key, { ...r, phase: 'final', result: response });
    }
  }
  async replay(): Promise<void> {
    for (const r of Object.values(await this.store.all<RecordState>('request:')))
      if (r.result) this.emit(r.result);
  }
  async accept(raw: unknown): Promise<void> {
    let job: Job;
    try {
      job = parseJob(raw);
    } catch {
      this.diagnostic('INVALID_JOB: Rejected native message');
      if (isObject(raw) && validId(raw.request_id))
        this.emit(
          result({ request_id: raw.request_id }, 'failed', 'INVALID_JOB: Invalid job payload'),
        );
      return;
    }
    // Canonical key order makes equivalent wire objects identical regardless of JSON property order.
    const fingerprint = await requestFingerprint(job);
    // v0.1 records used the four-field digest. Only legacy ask/default semantics
    // can match those tombstones; new operation/mode requests must never reuse them.
    const legacy =
      job.operation === 'ask' && !job.chat_url && !Object.keys(job.modes ?? {}).length
        ? await legacyFingerprint(job)
        : undefined;
    const key = await digest([
      job.provider,
      job.chat_url ? ['saved', job.chat_url] : job.conversation_key,
    ]);
    let claimed = false;
    try {
      await this.reservation.run(job.request_id, async () => {
        const old = await this.store.get<RecordState>(`request:${job.request_id}`);
        if (old) {
          if (old.fingerprint !== fingerprint && old.fingerprint !== legacy)
            this.emit(
              result(job, 'failed', 'REQUEST_ID_CONFLICT: Reused request ID with different input'),
            );
          else if (old.result) this.emit(old.result);
          return;
        }
        await this.store.set(`request:${job.request_id}`, {
          fingerprint,
          phase: 'reserved',
          conversation: key,
          provider: job.provider,
        } satisfies RecordState);
        claimed = true;
      });
    } catch {
      this.emit(result(job, 'failed', 'STORAGE_FAILURE: Reservation failed; nothing sent'));
      return;
    }
    if (!claimed) return;
    const expires = Date.now() + job.timeout_ms;
    await this.queue.run(key, async () => {
      let sent = false,
        conversation: Conversation | undefined,
        response: Result;
      try {
        if (Date.now() >= expires)
          throw new Diagnostic('QUEUE_TIMEOUT', 'Deadline expired in queue', 'timeout');
        if (this.quarantined.has(key) || (await this.store.get(`blocked:${key}`)))
          throw new Diagnostic(
            'CONVERSATION_QUARANTINED',
            'Prior request is ambiguous; use a new material/role conversation after manual review',
          );
        const settings = await this.platform.settings();
        if (!settings.enabled.includes(job.provider))
          throw new Diagnostic('DOMAIN_DISABLED', 'Enable this provider in extension settings');
        conversation = await this.platform.prepare(
          { ...job, timeout_ms: expires - Date.now() },
          settings,
          key,
        );
        response = await this.tabs.run(String(conversation.tabId), async () => {
          if (Date.now() >= expires)
            throw new Diagnostic('QUEUE_TIMEOUT', 'Deadline expired before submission', 'timeout');
          return this.platform.run(
            { ...job, timeout_ms: expires - Date.now() },
            settings,
            conversation!,
            async () => {
              await this.store.set(`request:${job.request_id}`, {
                fingerprint,
                phase: 'sent',
                conversation: key,
                provider: job.provider,
              } satisfies RecordState);
              sent = true;
            },
          );
        });
        if (!validResult(response, job))
          throw new Diagnostic(
            'INVALID_PAGE_RESULT',
            'Invalid or untrusted page result',
            'unknown',
          );
      } catch (error) {
        const d =
          error instanceof Diagnostic
            ? error
            : new Diagnostic(
                'BRIDGE_ERROR',
                'Bridge operation failed',
                sent ? 'unknown' : 'failed',
              );
        response = result(job, d.status, d.message, '', conversation?.url ?? '');
      }
      try {
        // Any noncompleted result after the submission barrier makes this conversation unsafe to reuse.
        if (sent && response.status !== 'completed') {
          this.quarantined.add(key);
          await this.store.set(`blocked:${key}`, true);
        }
        if (response.status === 'completed' && conversation && !conversation.view) {
          await this.store.set(`conversation:${key}`, {
            ...conversation,
            url: response.conversation_url,
          });
        }
        await this.store.set(`request:${job.request_id}`, {
          fingerprint,
          phase: 'final',
          conversation: key,
          provider: job.provider,
          result: response,
        } satisfies RecordState);
        this.emit(response);
      } catch {
        this.quarantined.add(key);
        this.diagnostic(
          'STORAGE_FAILURE: Final result could not be persisted; request remains reserved/sent',
        );
        this.emit(
          result(
            job,
            'unknown',
            'STORAGE_FAILURE: Final state uncertain; do not retry',
            '',
            conversation?.url ?? '',
          ),
        );
      }
    });
  }
}
