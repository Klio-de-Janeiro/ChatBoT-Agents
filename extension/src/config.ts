import { isObject, PROVIDERS, type Provider } from './protocol';
export type Selectors = {
  composer: string[];
  send: string[];
  user: string[];
  assistant: string[];
  text: string[];
  generating: string[];
  complete: string[];
  signedIn: string[];
  login: string[];
  captcha: string[];
  quota: string[];
  error: string[];
};
export type ProviderConfig = { selectors: Selectors; stable_ms: number; poll_ms: number };
export type Settings = { enabled: Provider[]; providers: Record<Provider, ProviderConfig> };
// Conservative candidates. Site releases may require selector updates; no wildcard assistant fallback.
const LEGACY_SETTINGS: Settings = {
  enabled: [],
  providers: {
    deepseek: {
      stable_ms: 1200,
      poll_ms: 150,
      selectors: {
        composer: ['textarea#chat-input', 'textarea[placeholder*="DeepSeek"]'],
        send: [
          'button[data-testid="send-button"]',
          'button[aria-label="Send message"]',
          '[role="button"][aria-label="Send"]',
        ],
        user: ['[data-message-role="user"]', '[data-role="user"]'],
        assistant: ['[data-message-role="assistant"]', '[data-role="assistant"]'],
        text: ['.ds-markdown', '[data-message-content]'],
        generating: [
          'button[aria-label="Stop generating"]',
          '[data-testid="stop-button"]',
          '[data-state="streaming"]',
        ],
        complete: [
          '[data-testid="copy-message-button"]',
          'button[aria-label="Copy"]',
          '[data-state="complete"]',
        ],
        signedIn: ['a[href="/settings"]', '[data-testid="user-menu"]', '[aria-label="User menu"]'],
        login: ['form[action*="login"]', 'input[type="password"]', '[data-testid="login-button"]'],
        captcha: ['iframe[src*="captcha"]', 'iframe[src*="challenge"]', '[class*="captcha"]'],
        quota: ['[data-testid="quota-error"]'],
        error: ['[role="alert"]'],
      },
    },
    qwen: {
      stable_ms: 1200,
      poll_ms: 150,
      selectors: {
        composer: [
          'textarea#chat-input',
          '#chat-input[contenteditable="true"]',
          'textarea#prompt-textarea',
        ],
        send: [
          'button#send-message-button',
          'button[aria-label="Send message"]',
          'button[data-testid="send-button"]',
        ],
        user: ['[data-message-role="user"]', '.user-message'],
        assistant: ['[data-message-role="assistant"]', '.assistant-message'],
        text: ['.markdown-prose', '.qwen-markdown', '[data-message-content]'],
        generating: [
          'button#stop-response-button',
          'button[aria-label="Stop generating"]',
          '[data-state="streaming"]',
        ],
        complete: [
          'button[aria-label="Copy"]',
          '[data-testid="copy-message-button"]',
          '[data-state="complete"]',
        ],
        signedIn: [
          '[data-testid="user-menu"]',
          '[aria-label="User menu"]',
          '#sidebar-user-menu-button',
        ],
        login: ['input[type="password"]', '[data-testid="login-button"]', 'form[action*="login"]'],
        captcha: ['iframe[src*="captcha"]', 'iframe[src*="challenge"]', '[class*="captcha"]'],
        quota: ['[data-testid="quota-error"]'],
        error: ['[role="alert"]'],
      },
    },
  },
};
// Confirmed against the signed-in web interfaces, 2026-11-17.
export const DEFAULT_SETTINGS: Settings = structuredClone(LEGACY_SETTINGS);
const liveSelectors: Record<Provider, Partial<Selectors>> = {
  deepseek: {
    send: ['div[role="button"].ds-button--primary.ds-button--circle:not(.ds-button--disabled)'],
    user: ['.ds-message.d29f3d7d'],
    assistant: ['.ds-message:not(.d29f3d7d)'],
    text: ['.ds-assistant-message-main-content', '.fbb737a4'],
    generating: ['.ds-button--circle svg[data-icon="spin"]'],
    complete: [
      '.ds-message:has(.ds-assistant-message-main-content):has(+ .ds-flex [role="button"])',
    ],
    signedIn: ['a[href^="/a/chat/s/"]'],
  },
  qwen: {
    composer: ['textarea.message-input-textarea'],
    send: ['button.send-button:not(.disabled)'],
    user: ['.qwen-chat-message-user'],
    assistant: ['.qwen-chat-message-assistant'],
    text: ['.user-message-content', '.response-message-content .qwen-markdown'],
    complete: ['.qwen-chat-package-comp-new-action-control-container-copy'],
    signedIn: ['button.user-menu-btn'],
    error: ['.qwen-chat-message-dual-message'],
  },
};
for (const provider of PROVIDERS) {
  for (const field of Object.keys(liveSelectors[provider]) as (keyof Selectors)[]) {
    DEFAULT_SETTINGS.providers[provider].selectors[field].push(...liveSelectors[provider][field]!);
  }
}

export function migrateLegacySelectors(settings: Settings): Settings {
  const updated = structuredClone(settings);
  for (const provider of PROVIDERS) {
    for (const field of Object.keys(liveSelectors[provider]) as (keyof Selectors)[]) {
      if (
        JSON.stringify(settings.providers[provider].selectors[field]) ===
        JSON.stringify(LEGACY_SETTINGS.providers[provider].selectors[field])
      ) {
        updated.providers[provider].selectors[field] = [
          ...DEFAULT_SETTINGS.providers[provider].selectors[field],
        ];
      }
    }
  }
  return updated;
}

const selectorFields = Object.keys(DEFAULT_SETTINGS.providers.deepseek.selectors);
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function integerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
function validSelectorList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 20 &&
    value.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= 500)
  );
}
function validateProvider(provider: Provider, value: unknown): void {
  if (!isObject(value) || !isObject(value.selectors))
    throw new Error(`Missing provider config: ${provider}`);
  if (!integerInRange(value.stable_ms, 100, 10000) || !integerInRange(value.poll_ms, 25, 2000))
    throw new Error(`Invalid timing: ${provider}`);
  for (const field of selectorFields) {
    if (!validSelectorList(value.selectors[field]))
      throw new Error(`Invalid selectors: ${provider}.${field}`);
  }
  if (
    !onlyKeys(value, ['selectors', 'stable_ms', 'poll_ms']) ||
    !onlyKeys(value.selectors, selectorFields)
  )
    throw new Error(`Unexpected config key: ${provider}`);
}
export function parseSettings(value: unknown): Settings {
  if (!isObject(value) || !Array.isArray(value.enabled) || !isObject(value.providers))
    throw new Error('Invalid provider settings');
  if (!value.enabled.every((provider) => PROVIDERS.includes(provider)))
    throw new Error('Invalid enabled provider');
  if (!onlyKeys(value, ['enabled', 'providers']) || !onlyKeys(value.providers, PROVIDERS))
    throw new Error('Origins and extra config keys cannot be changed');
  for (const provider of PROVIDERS) validateProvider(provider, value.providers[provider]);
  return value as Settings;
}
