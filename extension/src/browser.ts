import {
  DEFAULT_SETTINGS,
  migrateLegacySelectors,
  parseSettings,
  type Settings,
  type ProviderConfig,
} from './config';
import { Diagnostic, isObject, originProvider, ORIGINS, type Job, type Result } from './protocol';
import { type Store, type Platform, type Conversation } from './engine';

export const store: Store = {
  async get<T>(key: string) {
    return (await chrome.storage.local.get(key))[key] as T | undefined;
  },
  async set(key: string, value: unknown) {
    await chrome.storage.local.set({ [key]: value });
  },
  async all<T>(prefix: string) {
    return Object.fromEntries(
      Object.entries(await chrome.storage.local.get(null)).filter(([key]) =>
        key.startsWith(prefix),
      ),
    ) as Record<string, T>;
  },
};
type Probe = {
  ready: boolean;
  signedIn: boolean;
  url: string;
  document_token: string;
  message_count: number;
  draft: boolean;
  error?: string;
};
type Pending = {
  tabId: number;
  provider: Job['provider'];
  documentToken: string;
  nonce: string;
  authorize: () => Promise<void>;
  authorized: boolean;
};
export class BrowserPlatform implements Platform {
  pending = new Map<string, Pending>();
  async settings(): Promise<Settings> {
    const saved = parseSettings((await store.get('settings')) ?? structuredClone(DEFAULT_SETTINGS));
    const updated = migrateLegacySelectors(saved);
    if (JSON.stringify(saved) !== JSON.stringify(updated)) await store.set('settings', updated);
    return updated;
  }
  async probe(tabId: number, config: ProviderConfig): Promise<Probe> {
    const p: unknown = await chrome.tabs.sendMessage(
      tabId,
      { type: 'probe', config },
      { frameId: 0 },
    );
    if (
      !isObject(p) ||
      typeof p.ready !== 'boolean' ||
      typeof p.signedIn !== 'boolean' ||
      typeof p.document_token !== 'string' ||
      typeof p.url !== 'string' ||
      !Number.isInteger(p.message_count) ||
      typeof p.draft !== 'boolean'
    )
      throw new Diagnostic('DOM_UNSUPPORTED', 'Provider content script unavailable or unsupported');
    return p as Probe;
  }
  async prepare(job: Job, settings: Settings, key: string): Promise<Conversation> {
    const config = settings.providers[job.provider];
    const existing = await store.get<Conversation>(`conversation:${key}`);
    if (existing) {
      const ownership = (await chrome.storage.session.get(`tab:${existing.tabId}`))[
        `tab:${existing.tabId}`
      ];
      if (ownership !== existing.token)
        throw new Diagnostic(
          'CONVERSATION_LOST',
          'Tab ownership expired after browser restart; inspect manually',
        );
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(existing.tabId);
      } catch {
        throw new Diagnostic('MISSING_TAB', 'Dedicated conversation tab was closed');
      }
      if (tab.incognito || tab.url !== existing.url || originProvider(tab.url) !== job.provider)
        throw new Diagnostic('TAB_NAVIGATED', 'Dedicated tab was navigated; inspect manually');
      const probe = await this.probe(existing.tabId, config);
      if (!probe.ready || !probe.signedIn)
        throw new Diagnostic(
          'PROVIDER_NOT_READY',
          probe.error ?? 'Missing authenticated DOM evidence',
        );
      return existing;
    }
    const tabs = await chrome.tabs.query({ url: `${ORIGINS[job.provider]}/*` });
    if (!tabs.some((t) => !t.incognito))
      throw new Diagnostic(
        'MISSING_PROVIDER_TAB',
        'Open and sign in to the provider in this Chrome profile first',
      );
    let signedIn: chrome.tabs.Tab | undefined;
    const errors: string[] = [];
    for (const tab of tabs) {
      if (tab.id === undefined || tab.incognito || originProvider(tab.url) !== job.provider)
        continue;
      try {
        const p = await this.probe(tab.id, config);
        if (p.ready && p.signedIn) {
          signedIn = tab;
          break;
        }
        if (p.error) errors.push(p.error);
      } catch {
        errors.push(
          'DOM_UNSUPPORTED: Reload the signed-in provider tab after installing the extension and check selectors',
        );
      }
    }
    if (!signedIn)
      throw new Diagnostic(
        'LOGIN_OR_DOM_REQUIRED',
        errors[0] ??
          'No tab has positive signed-in DOM evidence; check login and provider selectors',
      );
    const created = await chrome.tabs.create({
      url: `${ORIGINS[job.provider]}/`,
      active: false,
      windowId: signedIn.windowId,
    });
    if (created.id === undefined)
      throw new Diagnostic('TAB_CREATE_FAILED', 'Chrome did not create a dedicated tab', 'failed');
    const id = created.id,
      token = crypto.randomUUID();
    // Ownership is ephemeral across browser restarts, and durable across worker restarts.
    await chrome.storage.session.set({ [`tab:${id}`]: token });
    const until = Date.now() + Math.min(job.timeout_ms, 20_000);
    let last = 'DOM_UNSUPPORTED: New tab did not become ready';
    while (Date.now() < until) {
      const tab = await chrome.tabs.get(id);
      if (tab.url && originProvider(tab.url) !== job.provider)
        throw new Diagnostic(
          'TAB_REDIRECTED',
          'New tab redirected outside the allowlisted provider origin',
        );
      try {
        const probe = await this.probe(id, config);
        if (probe.ready && probe.signedIn) {
          if (new URL(probe.url).pathname !== '/')
            throw new Diagnostic(
              'NEW_CHAT_NOT_EMPTY',
              'Provider restored a conversation URL; no prompt sent',
            );
          if (probe.message_count || probe.draft)
            throw new Diagnostic(
              'NEW_CHAT_NOT_EMPTY',
              'Provider opened an existing chat or draft; no prompt sent',
            );
          const conversation = { tabId: id, token, url: probe.url };
          await store.set(`conversation:${key}`, conversation);
          return conversation;
        }
        if (probe.error) last = probe.error;
        if (probe.error && /^(CAPTCHA|LOGIN_REQUIRED|QUOTA|PROVIDER_ERROR):/.test(probe.error))
          throw new Diagnostic('NEW_CHAT_BLOCKED', probe.error);
      } catch (e) {
        if (e instanceof Diagnostic && ['NEW_CHAT_NOT_EMPTY', 'NEW_CHAT_BLOCKED'].includes(e.code))
          throw e;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Diagnostic('NEW_CHAT_NOT_READY', last);
  }
  async authorize(
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<{ authorized: boolean }> {
    if (!isObject(message) || typeof message.request_id !== 'string') return { authorized: false };
    const pending = this.pending.get(message.request_id);
    if (
      !pending ||
      pending.authorized ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.tab?.id !== pending.tabId ||
      sender.tab.incognito ||
      originProvider(sender.url) !== pending.provider ||
      originProvider(sender.tab.url) !== pending.provider ||
      (sender.origin !== undefined && sender.origin !== ORIGINS[pending.provider]) ||
      message.nonce !== pending.nonce ||
      message.document_token !== pending.documentToken
    )
      return { authorized: false };
    pending.authorized = true;
    try {
      await pending.authorize();
      return { authorized: true };
    } catch {
      return { authorized: false };
    }
  }
  async run(
    job: Job,
    settings: Settings,
    conversation: Conversation,
    authorize: () => Promise<void>,
  ): Promise<Result> {
    const config = settings.providers[job.provider],
      probe = await this.probe(conversation.tabId, config);
    if (probe.url !== conversation.url)
      throw new Diagnostic('TAB_NAVIGATED', 'Conversation URL changed before submission');
    const nonce = crypto.randomUUID();
    this.pending.set(job.request_id, {
      tabId: conversation.tabId,
      provider: job.provider,
      documentToken: probe.document_token,
      nonce,
      authorize,
      authorized: false,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(
          conversation.tabId,
          { type: 'run', job, config, document_token: probe.document_token, nonce },
          { frameId: 0 },
        ) as Promise<Result>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Diagnostic(
                  'CONTENT_TIMEOUT',
                  'Content script did not return before deadline',
                  'timeout',
                ),
              ),
            job.timeout_ms + 1000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(job.request_id);
    }
  }
}
