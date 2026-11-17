export const PROVIDERS = ['deepseek', 'qwen'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const ORIGINS: Record<Provider, string> = {
  deepseek: 'https://chat.deepseek.com',
  qwen: 'https://chat.qwen.ai',
};
export const MAX_PROMPT_BYTES = 900 * 1024;
export const MAX_JOB_BYTES = 1024 * 1024;
export const MAX_RESULT_BYTES = 8 * 1024 * 1024;
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export type Job = {
  type: 'job';
  request_id: string;
  provider: Provider;
  prompt: string;
  conversation_key: string;
  timeout_ms: number;
};
export const STATUSES = ['completed', 'failed', 'timeout', 'needs_user_action', 'unknown'] as const;
export type Status = (typeof STATUSES)[number];
export type Result = {
  type: 'result';
  request_id: string;
  status: Status;
  text: string;
  conversation_url: string;
  error?: string;
};
export const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
export const validId = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const jobFields = ['type', 'request_id', 'provider', 'prompt', 'conversation_key', 'timeout_ms'];
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
    !validTimeout(value.timeout_ms) ||
    utf8Bytes(JSON.stringify(value)) > MAX_JOB_BYTES
  ) {
    throw new Error('INVALID_JOB: Invalid wire job or limits');
  }
  return value as Job;
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
export function result(
  job: Pick<Job, 'request_id'>,
  status: Status,
  error?: string,
  text = '',
  url = '',
): Result {
  return {
    type: 'result',
    request_id: job.request_id,
    status,
    text,
    conversation_url: url,
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
    (value.status === 'completed' && !value.text.trim()) ||
    typeof value.conversation_url !== 'string' ||
    originProvider(value.conversation_url) !== job.provider
  )
    return false;
  const validError =
    value.error === undefined || (typeof value.error === 'string' && value.error.length <= 1000);
  return validError && utf8Bytes(JSON.stringify(value)) <= MAX_RESULT_BYTES;
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
