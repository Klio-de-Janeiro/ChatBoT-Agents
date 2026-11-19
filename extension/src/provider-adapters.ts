import type { ProviderConfig } from './config';
import type { Provider } from './protocol';

const labeledNewChat = [
  '[aria-label="New chat" i]',
  '[title="New chat" i]',
  '[aria-label="Новый чат" i]',
  '[title="Новый чат" i]',
  '[data-testid="new-chat-button"]',
];

export const newChatControls: Record<Provider, readonly string[]> = {
  deepseek: labeledNewChat,
  qwen: labeledNewChat,
  kimi: [...labeledNewChat, '[data-testid="new-chat"]'],
  perplexity: [
    ...labeledNewChat,
    '[aria-label="New Thread" i]',
    '[title="New Thread" i]',
    '[aria-label="Новый тред" i]',
  ],
};

const shared = {
  captcha: ['iframe[src*="captcha"]', 'iframe[src*="challenge"]'],
  quota: ['[data-testid="quota-error"]'],
  error: ['[role="alert"]'],
};

export const browserAdapters = {
  kimi: {
    stable_ms: 1200,
    poll_ms: 150,
    selectors: {
      ...shared,
      composer: ['.chat-input-editor[contenteditable="true"]'],
      send: ['.send-button-container:not(.disabled):has(.send-icon)'],
      user: ['.segment-user'],
      assistant: ['.segment-assistant'],
      text: ['.user-content__text', '.markdown'],
      generating: [
        '.send-button-container:has(.stop-icon)',
        '.send-button-container.is-generating',
      ],
      complete: ['.segment-assistant-actions'],
      signedIn: ['[data-testid="sidebar-user-menu-trigger"]'],
      login: ['input[type="password"]', '[data-testid="login-button"]'],
    },
  },
  perplexity: {
    stable_ms: 1200,
    poll_ms: 150,
    selectors: {
      ...shared,
      composer: ['.composer-editable[contenteditable="true"]'],
      send: [
        'button[aria-label="Submit"]',
        'button[aria-label="Send"]',
        'button[aria-label="Отправить"]',
      ],
      user: ['[class~="group/user-bubble"]'],
      assistant: ['[data-workflow-final-text]'],
      text: ['[class~="whitespace-pre-wrap"]', '.prose'],
      generating: [
        'button[aria-label="Stop"]',
        'button[aria-label="Stop generating"]',
        'button[aria-label="Остановить"]',
      ],
      complete: [
        '[data-workflow-text-footer] button[aria-label="Copy"]',
        '[data-workflow-text-footer] button[aria-label="Копировать"]',
      ],
      signedIn: [
        'a[href="/library"]',
        'a[href^="/library/"]',
        'nav a[href^="/session/"]',
        'aside a[href^="/session/"]',
        'nav a[href^="/search/"][aria-current="page"]',
        'aside a[href^="/search/"][aria-current="page"]',
        'button[aria-label="Поиск по сессиям"]',
        'button[aria-label="Search sessions"]',
      ],
      login: [
        'input[type="password"]',
        'button[aria-label="Sign in"]',
        'button[aria-label="Войти"]',
      ],
    },
  },
} satisfies Record<string, ProviderConfig>;
