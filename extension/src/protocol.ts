import catalog from '../../src/multi_chat_agent/provider_catalog.json';
export { catalog };
export type Provider = keyof typeof catalog;
export const PROVIDERS = Object.keys(catalog) as Provider[];
export const ORIGINS = Object.fromEntries(
  PROVIDERS.map((provider) => [provider, catalog[provider].origin]),
) as Record<Provider, string>;
export const MAX_PROMPT_BYTES = 900 * 1024;
export const MAX_JOB_BYTES = 1024 * 1024;
export const MAX_RESULT_BYTES = 8 * 1024 * 1024;
/** Provider-native Markdown copy bound; keeps the native frame within Chrome's limit. */
export const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export type Modes = Record<string, boolean | string>;
export const REPLACE_DRAFT = 'replace-draft';
export type Operation = 'ask' | 'open';
export type Job = {
  type: 'job';
  request_id: string;
  provider: Provider;
  prompt: string;
  conversation_key: string;
  chat_url?: string;
  timeout_ms: number;
  operation?: Operation;
  modes?: Modes;
};
export const STATUSES = ['completed', 'failed', 'timeout', 'needs_user_action', 'unknown'] as const;
export type Status = (typeof STATUSES)[number];
export type Result = {
  type: 'result';
  request_id: string;
  status: Status;
  text: string;
  /** Answer in the provider's own Markdown ("copy answer" on the site). */
  markdown?: string;
  /** Structured answer blocks; see answers.ts. Never required. */
  content?: unknown;
  conversation_url: string;
  error?: string;
};
export const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
/**
 * Structural check for `content` (see answers.ts). Renderers rely on it before
 * walking blocks, so malformed payloads never leave the content script.
 */
export function validAnswerContent(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (
    value.version !== undefined &&
    (!Number.isInteger(value.version) || (value.version as number) < 1)
  )
    return false;
  if (value.plain !== undefined && typeof value.plain !== 'string') return false;
  if (value.blocks === undefined) return true;
  if (!Array.isArray(value.blocks) || value.blocks.length > 100_000) return false;
  return value.blocks.every(
    (block) => isObject(block) && typeof block.type === 'string' && block.type.length <= 32,
  );
}
export const validId = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const jobFields = [
  'type',
  'request_id',
  'provider',
  'prompt',
  'conversation_key',
  'chat_url',
  'timeout_ms',
  'operation',
  'modes',
];
export const validModeName = (name: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(name);
export function validModes(value: unknown): value is Modes {
  if (!isObject(value) || Object.keys(value).length > 16) return false;
  return Object.entries(value).every(
    ([key, setting]) =>
      validModeName(key) &&
      (typeof setting === 'boolean' ||
        (typeof setting === 'string' && !!setting.trim() && setting.length <= 100)),
  );
}
export function canonicalModes(modes: Modes = {}): Modes {
  return Object.fromEntries(Object.entries(modes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
function validPrompt(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && utf8Bytes(value) <= MAX_PROMPT_BYTES;
}
function validConversationKey(value: unknown): value is string {
  return (
    typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\x00-\x1f]/.test(value)
  );
}
function validTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3_600_000;
}
export function parseJob(value: unknown): Job {
  const validShape = isObject(value) && Object.keys(value).every((key) => jobFields.includes(key));
  if (
    !validShape ||
    value.type !== 'job' ||
    !validId(value.request_id) ||
    !PROVIDERS.includes(value.provider as Provider) ||
    !validPrompt(value.prompt) ||
    !validConversationKey(value.conversation_key) ||
    (value.chat_url !== undefined &&
      (typeof value.chat_url !== 'string' ||
        savedChatUrl(value.provider as Provider, value.chat_url) !== value.chat_url)) ||
    !validTimeout(value.timeout_ms) ||
    (value.operation !== undefined && value.operation !== 'ask' && value.operation !== 'open') ||
    (value.modes !== undefined && !validModes(value.modes)) ||
    utf8Bytes(JSON.stringify(value)) > MAX_JOB_BYTES
  ) {
    throw new Error('INVALID_JOB: Invalid wire job or limits');
  }
  return {
    ...value,
    operation: value.operation ?? 'ask',
    modes: canonicalModes(value.modes as Modes | undefined),
  } as Job;
}
export function originProvider(url: string | undefined): Provider | undefined {
  try {
    const parsed = new URL(url!);
    return PROVIDERS.find(
      (provider) => parsed.origin === ORIGINS[provider] && !parsed.username && !parsed.password,
    );
  } catch {
    return undefined;
  }
}
export function savedChatUrl(provider: Provider, url: string): string | undefined {
  if (url.length > 512 || /[\s\\]/.test(url) || originProvider(url) !== provider) return;
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '');
  if (
    catalog[provider].resume_paths.some(
      (prefix) => path.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(path.slice(prefix.length)),
    )
  )
    return parsed.origin + path;
}
export function result(
  job: Pick<Job, 'request_id'>,
  status: Status,
  error?: string,
  text = '',
  url = '',
  capture?: { markdown?: string; content?: unknown },
): Result {
  return {
    type: 'result',
    request_id: job.request_id,
    status,
    text,
    conversation_url: url,
    ...(capture?.markdown ? { markdown: capture.markdown } : {}),
    ...(capture?.content ? { content: capture.content } : {}),
    ...(error ? { error } : {}),
  };
}
export function validResult(value: unknown, job: Job): value is Result {
  if (
    !isObject(value) ||
    value.type !== 'result' ||
    value.request_id !== job.request_id ||
    !STATUSES.includes(value.status as Status) ||
    typeof value.text !== 'string' ||
    (value.status === 'completed' && job.operation !== 'open' && !value.text.trim()) ||
    typeof value.conversation_url !== 'string' ||
    originProvider(value.conversation_url) !== job.provider ||
    (job.chat_url &&
      value.status === 'completed' &&
      savedChatUrl(job.provider, value.conversation_url) !== job.chat_url)
  )
    return false;
  const validError =
    value.error === undefined || (typeof value.error === 'string' && value.error.length <= 1000);
  const validMarkdown =
    value.markdown === undefined ||
    (typeof value.markdown === 'string' && utf8Bytes(value.markdown) <= MAX_MARKDOWN_BYTES);
  const validContent =
    value.content === undefined ||
    (validAnswerContent(value.content) &&
      utf8Bytes(JSON.stringify(value.content)) <= MAX_CONTENT_BYTES);
  return (
    validError &&
    validMarkdown &&
    validContent &&
    utf8Bytes(JSON.stringify(value)) <= MAX_RESULT_BYTES
  );
}
export class Diagnostic extends Error {
  constructor(
    public code: string,
    message: string,
    public status: Status = 'needs_user_action',
  ) {
    super(`${code}: ${message}`);
  }
}
