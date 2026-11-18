import {
  DEFAULT_SETTINGS,
  migrateLegacySelectors,
  parseSettings,
  type Settings,
  type ProviderConfig,
} from './config';
import {
  catalog,
  Diagnostic,
  isObject,
  originProvider,
  savedChatUrl,
  ORIGINS,
  result,
  REPLACE_DRAFT,
  type Job,
  type Result,
} from './protocol';
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
  busy?: boolean;
  visible?: boolean;
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
  private async probeExisting(job: Job, tabId: number, config: ProviderConfig): Promise<Probe> {
    try {
      return await this.probe(tabId, config);
    } catch {
      // Chrome does not inject a new extension build into already loaded pages.
      // Reconnect the allowed document without reloading it or touching its draft.
      const tab = await chrome.tabs.get(tabId);
      if (tab.incognito || tab.pendingUrl || originProvider(tab.url) !== job.provider)
        throw new Diagnostic('TAB_NAVIGATED', 'The provider tab changed while connecting');
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          files: ['content.js'],
        });
        return await this.probe(tabId, config);
      } catch {
        throw new Diagnostic(
          'CONTENT_SCRIPT_UNAVAILABLE',
          'Allow the extension to access this provider tab',
        );
      }
    }
  }

  async prepare(job: Job, settings: Settings, key: string): Promise<Conversation> {
    if (job.operation === 'open') {
      const view = await this.existingView(job);
      if (view) return view;
    }
    const config = settings.providers[job.provider];
    let existing = await store.get<Conversation>(`conversation:${key}`);
    if (existing && job.chat_url) {
      const tab = await chrome.tabs.get(existing.tabId).catch(() => undefined);
      const ownership = await chrome.storage.session.get(`tab:${existing.tabId}`);
      if (!tab || ownership[`tab:${existing.tabId}`] !== existing.token) existing = undefined;
    }
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
      if (
        job.chat_url &&
        (savedChatUrl(job.provider, probe.url) !== job.chat_url || !probe.message_count)
      )
        throw new Diagnostic('CHAT_HISTORY_MISSING', 'The saved chat has no recognizable history');
      if (!probe.ready || !probe.signedIn)
        throw new Diagnostic(
          'PROVIDER_NOT_READY',
          probe.error ?? 'Missing authenticated DOM evidence',
        );
      return existing;
    }
    if (job.operation !== 'open') {
      const prepared = await this.preparedTab(job);
      if (prepared) return prepared;
    }
    const tabs = job.chat_url ? [] : await chrome.tabs.query({ url: `${ORIGINS[job.provider]}/*` });
    if (
      job.operation !== 'open' &&
      !job.chat_url &&
      !tabs.some(
        (tab) => tab.id !== undefined && !tab.incognito && originProvider(tab.url) === job.provider,
      )
    )
      throw new Diagnostic(
        'MISSING_PROVIDER_TAB',
        'Open and sign in to the provider in this Chrome profile first',
      );
    // A source provider tab is the user's explicit profile context. Its content
    // script may have become stale after an extension reload. Authenticate only
    // in the fresh owned page below; never refresh or alter the user's chat.
    // Each conversation has an active tab in an owned window. Real providers may
    // defer rendering and event handling in inactive tabs; separate windows also
    // preserve parallelism without changing the user's existing active tabs.
    const workspace = await chrome.windows.create({
      url: job.chat_url ?? ORIGINS[job.provider] + catalog[job.provider].start,
      type: 'normal',
      focused: true,
    });
    const created = workspace?.tabs?.[0];
    if (!created || created.id === undefined || workspace?.id === undefined)
      throw new Diagnostic('TAB_CREATE_FAILED', 'Chrome did not create a dedicated tab', 'failed');
    await chrome.storage.session.set({ [`work-window:${workspace.id}`]: true });
    const id = created.id,
      token = crypto.randomUUID();
    // Ownership is ephemeral across browser restarts, and durable across worker restarts.
    await chrome.storage.session.set({ [`tab:${id}`]: token });
    const probe = await this.waitForConversation(job, config, id);
    const conversation = { tabId: id, token, url: probe.url };
    await store.set(`conversation:${key}`, conversation);
    return conversation;
  }

  private async waitForConversation(job: Job, config: ProviderConfig, id: number): Promise<Probe> {
    const until = Date.now() + Math.min(job.timeout_ms, 20_000);
    let last = 'DOM_UNSUPPORTED: New tab did not become ready';
    while (Date.now() < until) {
      const tab = await chrome.tabs.get(id);
      if (tab.url && tab.url !== 'about:blank' && originProvider(tab.url) !== job.provider)
        throw new Diagnostic(
          'TAB_REDIRECTED',
          'New tab redirected outside the allowlisted provider origin',
        );
      try {
        const probe = await this.probe(id, config);
        if (probe.ready && probe.signedIn) {
          if (job.chat_url) {
            if (savedChatUrl(job.provider, probe.url) !== job.chat_url)
              throw new Diagnostic('CHAT_URL_CHANGED', 'The saved chat redirected elsewhere');
            if (!probe.message_count) {
              last = 'CHAT_HISTORY_MISSING: The saved chat has no recognizable messages';
              await new Promise((resolve) => setTimeout(resolve, 150));
              continue;
            }
          } else if (
            !catalog[job.provider].home.includes(
              new URL(probe.url).pathname.replace(/\/$/, '') || '/',
            )
          )
            throw new Diagnostic(
              'NEW_CHAT_NOT_EMPTY',
              'Provider restored a conversation URL; no prompt sent',
            );
          if (!job.chat_url && probe.message_count)
            throw new Diagnostic(
              'NEW_CHAT_NOT_EMPTY',
              'Provider opened an existing chat; no prompt sent',
            );
          return probe;
        }
        if (probe.error) last = probe.error;
        if (probe.error && /^(CAPTCHA|LOGIN_REQUIRED|QUOTA|PROVIDER_ERROR):/.test(probe.error))
          throw new Diagnostic('NEW_CHAT_BLOCKED', probe.error);
      } catch (e) {
        if (
          e instanceof Diagnostic &&
          ['NEW_CHAT_NOT_EMPTY', 'NEW_CHAT_BLOCKED', 'CHAT_URL_CHANGED'].includes(e.code)
        )
          throw e;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Diagnostic('NEW_CHAT_NOT_READY', last);
  }
  private async rememberOpen(job: Job, conversation: Conversation): Promise<void> {
    await chrome.storage.session.set({
      [`prepared:${job.provider}`]: { tabId: conversation.tabId, url: conversation.url },
    });
  }

  private async preparedTab(job: Job): Promise<Conversation | undefined> {
    const key = `prepared:${job.provider}`;
    const saved = (await chrome.storage.session.get(key))[key] as
      Pick<Conversation, 'tabId' | 'url'> | undefined;
    if (!saved) return;
    const tab = await chrome.tabs.get(saved.tabId).catch(() => undefined);
    if (!tab || tab.incognito || originProvider(tab.url) !== job.provider) return;
    if (tab.url !== saved.url || tab.pendingUrl)
      throw new Diagnostic('TAB_NAVIGATED', 'The prepared tab changed. Run open again.');
    return { ...saved, prepared: true, token: crypto.randomUUID() };
  }

  private async usePreparedTab(
    job: Job,
    conversation: Conversation,
    config: ProviderConfig,
  ): Promise<void> {
    const key = `prepared:${job.provider}`;
    const saved = (await chrome.storage.session.get(key))[key] as
      Pick<Conversation, 'tabId' | 'url'> | undefined;
    const tab = await chrome.tabs.get(conversation.tabId);
    if (
      saved?.tabId !== conversation.tabId ||
      tab.url !== conversation.url ||
      tab.incognito ||
      tab.pendingUrl
    )
      throw new Diagnostic('TAB_NAVIGATED', 'The prepared tab changed. Run open again.');
    const until = Date.now() + Math.min(8_000, job.timeout_ms);
    let probe = await this.probeExisting(job, conversation.tabId, config);
    while (
      (!probe.ready || !probe.signedIn) &&
      probe.url === tab.url &&
      Date.now() < until &&
      !/^(LOGIN_REQUIRED|CAPTCHA|QUOTA|PROVIDER_ERROR):/.test(probe.error ?? '')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      probe = await this.probe(conversation.tabId, config);
    }
    if (!probe.ready || !probe.signedIn || probe.url !== tab.url)
      throw new Diagnostic(
        'PROVIDER_NOT_READY',
        probe?.error ?? 'Refresh or sign in to the prepared tab, then run open again',
      );
    if (probe.busy) throw new Diagnostic('TAB_BUSY', 'The prepared tab is generating a reply');
    if (probe.draft && job.modes?.[REPLACE_DRAFT] !== true)
      throw new Diagnostic(
        'USER_DRAFT',
        'The prepared tab contains an unsent draft; use --replace-draft to discard it',
      );
    const site = catalog[job.provider];
    const currentPath = new URL(probe.url).pathname.replace(/\/$/, '') || '/';
    const needsNavigation = job.chat_url
      ? savedChatUrl(job.provider, probe.url) !== job.chat_url
      : !site.home.includes(currentPath) || probe.message_count > 0;
    if (job.chat_url && !needsNavigation && !probe.message_count)
      throw new Diagnostic('CHAT_HISTORY_MISSING', 'The saved chat has no recognizable history');
    if (needsNavigation) {
      await chrome.tabs.update(conversation.tabId, {
        url: job.chat_url ?? site.origin + site.start,
        active: true,
      });
      conversation.url = (await this.waitForConversation(job, config, conversation.tabId)).url;
    }
    // Transfer only the chosen tab. Moving it between windows keeps the same tab ID.
    await chrome.storage.session.set({
      [`tab:${conversation.tabId}`]: conversation.token,
      [key]: { tabId: conversation.tabId, url: conversation.url },
    });
    delete conversation.prepared;
  }

  private async existingView(job: Job): Promise<Conversation | undefined> {
    const tabs = (await chrome.tabs.query({ url: `${ORIGINS[job.provider]}/*` }))
      .filter(
        (tab) =>
          !tab.incognito &&
          !tab.pendingUrl &&
          tab.id !== undefined &&
          originProvider(tab.url) === job.provider,
      )
      .sort(
        (a, b) =>
          Number(!!b.active) - Number(!!a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
      );
    const exact =
      job.chat_url && tabs.find((tab) => savedChatUrl(job.provider, tab.url!) === job.chat_url);
    if (!tabs.length) return;
    let tab = exact || undefined;
    if (!tab) {
      const keys = tabs.map((candidate) => `tab:${candidate.id}`);
      const ownership = await chrome.storage.session.get(keys);
      tab = tabs.find((candidate) => !ownership[`tab:${candidate.id}`]) ?? tabs[0]!;
    }
    return { tabId: tab.id!, url: tab.url!, token: '', view: true };
  }

  private async activateView(
    job: Job,
    conversation: Conversation,
    config: ProviderConfig,
  ): Promise<string> {
    const { tabId, url } = conversation;
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito || tab.pendingUrl || tab.url !== url)
      throw new Diagnostic('TAB_NAVIGATED', 'The existing tab changed; run open again');

    const navigate = job.chat_url && savedChatUrl(job.provider, url) !== job.chat_url;
    if (navigate) {
      const workKey = `tab:${tabId}`;
      if ((await chrome.storage.session.get(workKey))[workKey])
        throw new Diagnostic(
          'TAB_BUSY',
          'Open another tab of this provider to preserve its work session',
        );
      const probe = await this.probeExisting(job, tabId, config);
      if (!probe?.ready || probe.url !== url)
        throw new Diagnostic(
          'PROVIDER_NOT_READY',
          'Reload the provider tab manually before opening a different chat',
        );
      if (probe.draft) throw new Diagnostic('USER_DRAFT', 'The existing tab has an unsent draft');
      if (probe.busy) throw new Diagnostic('TAB_BUSY', 'The existing tab is generating a reply');
      const current = await chrome.tabs.get(tabId);
      if (current.url !== url || current.pendingUrl)
        throw new Diagnostic('TAB_NAVIGATED', 'The existing tab changed; run open again');
    }

    await chrome.tabs.update(
      tabId,
      navigate ? { url: job.chat_url, active: true } : { active: true },
    );
    const window = await chrome.windows.get(tab.windowId);
    if (window.state === 'minimized')
      await chrome.windows.update(tab.windowId, { state: 'normal' });
    await chrome.windows.update(tab.windowId, { focused: true });
    if (!navigate) return url;

    const until = Date.now() + Math.min(job.timeout_ms, 20_000);
    while (Date.now() < until) {
      const loaded = await chrome.tabs.get(tabId);
      if (loaded.status === 'complete' && !loaded.pendingUrl) {
        if (loaded.url && savedChatUrl(job.provider, loaded.url) === job.chat_url)
          return loaded.url;
        throw new Diagnostic('CHAT_URL_CHANGED', 'The saved chat redirected elsewhere');
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Diagnostic('NEW_CHAT_NOT_READY', 'The saved chat did not finish loading');
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
    const config = settings.providers[job.provider];
    if (conversation.view && job.operation === 'open') {
      conversation.url = await this.activateView(job, conversation, config);
      if (!Object.keys(job.modes ?? {}).length) {
        await this.rememberOpen(job, conversation);
        return result(job, 'completed', undefined, '', conversation.url);
      }
    }
    const prepared = conversation.prepared === true;
    if (prepared) await this.usePreparedTab(job, conversation, config);
    const tab = await chrome.tabs.get(conversation.tabId);
    const tabKey = `tab:${conversation.tabId}`;
    const ownership = (await chrome.storage.session.get(tabKey))[tabKey];
    if (ownership !== conversation.token && !(conversation.view && job.operation === 'open'))
      throw new Diagnostic(
        'WORKSPACE_REQUIRED',
        'The tab is no longer assigned to this conversation',
      );
    const window = await chrome.windows.get(tab.windowId);
    if (window.state === 'minimized')
      throw new Diagnostic(
        'WORKSPACE_MINIMIZED',
        'Restore the work window before running a new job',
      );
    if (!tab.active) await chrome.tabs.update(conversation.tabId, { active: true });
    if (job.operation !== 'open' && !window.focused)
      await chrome.windows.update(tab.windowId, { focused: true });
    const probeTab = () => this.probeExisting(job, conversation.tabId, config);
    let probe = await probeTab();
    if (job.operation !== 'open') {
      const until = Date.now() + Math.min(2_000, job.timeout_ms);
      while (probe.visible === false && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        probe = await probeTab();
      }
      if (probe.visible === false)
        throw new Diagnostic(
          'WORKSPACE_HIDDEN',
          'Bring the provider tab to the foreground before asking',
        );
    }
    if (probe.url !== conversation.url)
      throw new Diagnostic('TAB_NAVIGATED', 'Conversation URL changed before submission');
    const nonce = crypto.randomUUID();
    this.pending.set(job.request_id, {
      tabId: conversation.tabId,
      provider: job.provider,
      documentToken: probe.document_token,
      nonce,
      authorize: async () => {
        if (prepared) {
          const key = `prepared:${job.provider}`;
          const saved = (await chrome.storage.session.get(key))[key] as
            Pick<Conversation, 'tabId' | 'url'> | undefined;
          if (saved?.tabId === conversation.tabId)
            await chrome.storage.session.set({ [key]: null });
        }
        await authorize();
      },
      authorized: false,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
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
      if (job.operation === 'open' && response.status === 'completed') {
        conversation.url = response.conversation_url;
        await this.rememberOpen(job, conversation);
      }
      return response;
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(job.request_id);
    }
  }
}
