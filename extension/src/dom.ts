import {
  catalog,
  Diagnostic,
  MAX_RESULT_BYTES,
  utf8Bytes,
  result,
  REPLACE_DRAFT,
  savedChatUrl,
  type Job,
  type Result,
} from './protocol';
import type { ProviderConfig } from './config';
import { applyRequestedModes } from './modes';
import { richAnswer, type RichAnswer } from './answers';

export const normalize = (s: string) =>
  s
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
export type Probe = { ready: boolean; signedIn: boolean; error?: string; url: string };
export class DomAdapter {
  constructor(
    public doc: Document,
    public config: ProviderConfig,
  ) {
    for (const selectors of Object.values(config.selectors))
      for (const s of selectors) {
        try {
          doc.querySelector(s);
        } catch {
          throw new Diagnostic('INVALID_SELECTOR', 'Update provider selector configuration');
        }
      }
  }
  visible(e: Element): boolean {
    const style = this.doc.defaultView!.getComputedStyle(e);
    return (
      e.isConnected &&
      !e.closest('[hidden],[aria-hidden="true"]') &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      e.getClientRects().length > 0
    );
  }
  all(selectors: string[], root: ParentNode = this.doc): Element[] {
    return [...root.querySelectorAll(selectors.join(','))].filter((e) => this.visible(e));
  }
  first(selectors: string[], root: ParentNode = this.doc): Element | undefined {
    return this.all(selectors, root)[0];
  }
  text(e: Element): string {
    const body = this.first(this.config.selectors.text, e) ?? e;
    return normalize((body as HTMLElement).innerText ?? body.textContent ?? '');
  }
  diagnostic(): Diagnostic | undefined {
    const s = this.config.selectors;
    if (this.first(s.captcha))
      return new Diagnostic('CAPTCHA', 'Complete the provider challenge manually');
    if (this.first(s.login))
      return new Diagnostic('LOGIN_REQUIRED', 'Sign in manually in this Chrome profile');
    if (this.first(s.quota))
      return new Diagnostic('QUOTA', 'Provider quota/rate limit requires user action');
    const alerts = this.all(s.error)
      .map((e) => e.textContent ?? '')
      .join(' ');
    if (/quota|rate.limit|too many|limit reached|限额|频繁|лимит/i.test(alerts))
      return new Diagnostic('QUOTA', 'Provider quota/rate limit requires user action');
    if (alerts.trim())
      return new Diagnostic(
        'PROVIDER_ERROR',
        'Provider displayed an error; inspect the dedicated tab',
      );
    return undefined;
  }
  probe(): Probe {
    const error = this.diagnostic();
    const composer = this.first(this.config.selectors.composer);
    // Account/history evidence can be collapsed by the provider's responsive
    // sidebar. It is positive authenticated DOM evidence even without layout;
    // the composer must remain visible, and visible login/challenges win.
    const authenticated = !!this.doc.querySelector(this.config.selectors.signedIn.join(','));
    return {
      ready: !error && !!composer,
      signedIn: !error && !!composer && authenticated,
      error:
        error?.message ??
        (!composer
          ? 'DOM_UNSUPPORTED: Visible composer is missing'
          : !authenticated
            ? 'AUTH_EVIDENCE_MISSING: Composer is visible but no account/history evidence was found'
            : undefined),
      url: this.doc.location.href,
    };
  }
  // Capture the answer as the provider itself would copy it. Attachment is not
  // a gate: `markdown`/`content` are additive to the plain-text contract and
  // the answer is never failed only because a rich copy could not be taken.
  private capture(answer: Element, text: string): RichAnswer | undefined {
    try {
      return richAnswer(answer, text);
    } catch {
      return undefined;
    }
  }
  // A provider may show a reply before updating its history or redirecting.
  private hasSavedThread(provider: Job['provider']): boolean {
    const prefix = catalog[provider].thread;
    if (!prefix) return true;
    const { origin, pathname } = this.doc.location;
    if (!pathname.startsWith(prefix) || pathname.length <= prefix.length) return false;
    return [...this.doc.querySelectorAll<HTMLAnchorElement>('a[href]')].some((link) => {
      return link.origin === origin && link.pathname === pathname;
    });
  }
  messages(): Element[] {
    return this.all([...this.config.selectors.user, ...this.config.selectors.assistant]);
  }
  isUser(e: Element): boolean {
    return this.config.selectors.user.some((s) => e.matches(s));
  }
  identity(e: Element): string | Element {
    const row = e.closest('[data-virtual-list-item-key]');
    const key = row?.getAttribute('data-virtual-list-item-key');
    // DeepSeek reuses this row key when virtualized message nodes are replaced.
    // Without a provider identity we retain strict DOM-node correlation.
    return key !== null && key !== undefined
      ? `${this.isUser(e) ? 'user' : 'assistant'}:${key}`
      : e;
  }
  value(e: Element): string {
    return e instanceof this.doc.defaultView!.HTMLTextAreaElement ||
      e instanceof this.doc.defaultView!.HTMLInputElement
      ? e.value
      : (e as HTMLElement).innerText;
  }
  setValue(e: Element, value: string): void {
    const view = this.doc.defaultView!;
    if (e instanceof view.HTMLTextAreaElement || e instanceof view.HTMLInputElement) {
      const prototype =
        e instanceof view.HTMLTextAreaElement
          ? view.HTMLTextAreaElement.prototype
          : view.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(e, value);
    } else if (e.getAttribute('contenteditable') === 'true') {
      // execCommand inserts plaintext into controlled contenteditable editors (no HTML interpretation).
      (e as HTMLElement).focus();
      const selection = view.getSelection();
      const range = this.doc.createRange();
      range.selectNodeContents(e);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (this.doc.execCommand(value ? 'insertText' : 'delete', false, value)) return;
      e.textContent = value;
    } else throw new Diagnostic('COMPOSER_UNSUPPORTED', 'Configured composer is not editable');
    e.dispatchEvent(
      new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
    e.dispatchEvent(new view.Event('change', { bubbles: true }));
  }
  async run(job: Job, authorize: () => Promise<void>): Promise<Result> {
    const start = Date.now(),
      deadline = start + job.timeout_ms;
    let clicked = false;
    let written: Element | undefined;
    let sent = false,
      partialText = '',
      observer: MutationObserver | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const progress = {
      revision: 'live-dom-4',
      phase: 'prepare',
      userSeen: false,
      assistantSeen: false,
      messageCount: 0,
      complete: false,
      generating: false,
    };
    const pause = () =>
      new Promise<void>((resolve) => {
        let done = false;
        const wake = () => {
          if (done) return;
          done = true;
          observer?.disconnect();
          if (timer) clearTimeout(timer);
          resolve();
        };
        observer = new this.doc.defaultView!.MutationObserver(wake);
        observer.observe(this.doc.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        timer = setTimeout(wake, this.config.poll_ms);
      });
    const onTargetChat = () =>
      !job.chat_url || savedChatUrl(job.provider, this.doc.location.href) === job.chat_url;
    try {
      const problem = this.diagnostic();
      if (problem) throw problem;
      const { [REPLACE_DRAFT]: replaceDraft, ...providerModes } = job.modes ?? {};
      if (
        replaceDraft !== undefined &&
        (job.operation === 'open' || typeof replaceDraft !== 'boolean')
      )
        throw new Diagnostic('MODE_VALUE_UNSUPPORTED', 'Draft replacement requires ask and on/off');
      let composer = this.first(this.config.selectors.composer);
      if (!composer || !this.probe().signedIn)
        throw new Diagnostic(
          'DOM_UNSUPPORTED',
          'Missing composer or positive signed-in evidence; update provider selectors',
        );
      if (this.first(this.config.selectors.generating))
        throw new Diagnostic('TAB_BUSY', 'Provider is already generating');
      await applyRequestedModes(this, job.provider, providerModes, deadline);
      if (!onTargetChat())
        throw new Diagnostic('CHAT_URL_CHANGED', 'The saved chat changed before submission');
      if (job.operation === 'open') {
        const problem = this.diagnostic();
        if (problem) throw problem;
        if (!this.probe().signedIn)
          throw new Diagnostic(
            'PROVIDER_NOT_READY',
            'Authenticated UI was lost while applying modes',
          );
        return result(job, 'completed', undefined, '', this.doc.location.href);
      }
      composer = this.first(this.config.selectors.composer);
      if (!composer)
        throw new Diagnostic('DOM_UNSUPPORTED', 'Composer disappeared before submission');
      if (normalize(this.value(composer)) && replaceDraft !== true)
        throw new Diagnostic(
          'USER_DRAFT',
          'The tab contains an unsent draft; use --replace-draft to discard it',
        );
      const baseline = this.messages();
      const baselineText = baseline.map((e) => this.text(e));
      const baselineIds = baseline.map((e) => this.identity(e));
      const baselineSet = new Set(baselineIds);
      let user: Element | undefined, assistant: Element | undefined;
      let userIdentity: string | Element | undefined;
      let assistantIdentity: string | Element | undefined;
      let mismatchSince: number | undefined;
      const virtualKey = (element: Element | undefined): number | undefined => {
        if (job.provider !== 'deepseek' || !element?.matches('.ds-message')) return;
        const key = element
          .closest('[data-virtual-list-item-key]')
          ?.getAttribute('data-virtual-list-item-key');
        if (key && /^-?\d+$/.test(key)) return Number(key);
      };
      this.setValue(composer, job.prompt);
      if (normalize(this.value(composer)) !== normalize(job.prompt)) {
        await pause();
        composer = this.first(this.config.selectors.composer) ?? composer;
        if (normalize(this.value(composer)) !== normalize(job.prompt))
          throw new Diagnostic('COMPOSER_MISMATCH', 'Composer did not retain the exact prompt');
      }
      written = composer;
      let send: Element | undefined;
      while (Date.now() < deadline) {
        const d = this.diagnostic();
        if (d) throw d;
        send = this.first(this.config.selectors.send);
        if (send && !send.hasAttribute('disabled') && send.getAttribute('aria-disabled') !== 'true')
          break;
        await pause();
      }
      if (!send || send.hasAttribute('disabled') || send.getAttribute('aria-disabled') === 'true')
        throw new Diagnostic(
          'SEND_CONTROL_MISSING',
          'No enabled send control; update provider selectors',
        );
      // Persistence barrier is in the background. There is no click before it resolves.
      await authorize();
      sent = true;
      if (Date.now() >= deadline)
        throw new Diagnostic('DEADLINE', 'Deadline expired before click', 'timeout');
      if (
        !onTargetChat() ||
        this.messages().length !== baseline.length ||
        this.messages().some(
          (e, i) => this.identity(e) !== baselineIds[i] || this.text(e) !== baselineText[i],
        ) ||
        normalize(this.value(composer)) !== normalize(job.prompt)
      )
        throw new Diagnostic(
          'TAB_INTERFERENCE',
          'Conversation changed before submission',
          'unknown',
        );
      // The awaited storage barrier can let React replace the original button.
      // Resolve the current control once, immediately before the only click.
      send = this.first(this.config.selectors.send);
      if (
        !send ||
        !send.isConnected ||
        send.hasAttribute('disabled') ||
        send.getAttribute('aria-disabled') === 'true'
      )
        throw new Diagnostic(
          'SEND_CONTROL_CHANGED',
          'Send control changed before click; no click performed',
        );
      clicked = true;
      (send as HTMLElement).click();
      progress.phase = 'await_user_echo';
      let lastText = '',
        stableSince = Date.now();
      while (Date.now() < deadline) {
        const d = this.diagnostic();
        if (d) throw d;
        const messages = this.messages();
        progress.messageCount = messages.length;
        // Old messages cannot be used as new answers; history changes are ambiguous.
        if (
          baseline.some(
            (_, i) =>
              !messages[i] ||
              this.identity(messages[i]!) !== baselineIds[i] ||
              this.text(messages[i]!) !== baselineText[i],
          )
        )
          throw new Diagnostic('HISTORY_CHANGED', 'Conversation history was replaced', 'unknown');
        if (new Set(messages.map((e) => this.identity(e))).size !== messages.length)
          throw new Diagnostic('IDENTITY_COLLISION', 'Message identities are ambiguous', 'unknown');
        const fresh = messages.filter((e) => !baselineSet.has(this.identity(e)));
        if (!user && fresh.length) {
          const candidate = fresh[0]!;
          if (!this.isUser(candidate) || this.text(candidate) !== normalize(job.prompt)) {
            const kimiPending =
              job.provider === 'kimi' &&
              (!this.isUser(candidate) || !candidate.querySelector('.user-content__text'));
            if (virtualKey(candidate) !== undefined || kimiPending) {
              // Wait briefly for a provider to mount the role and its text.
              mismatchSince ??= Date.now();
              if (Date.now() - mismatchSince < 600) {
                await pause();
                continue;
              }
            }
            throw new Diagnostic(
              'PROMPT_CORRELATION',
              'New user message does not match this request',
              'unknown',
            );
          }
          user = candidate;
          userIdentity = this.identity(candidate);
          progress.userSeen = true;
          progress.phase = 'await_assistant';
        }
        if (user) {
          const first = fresh[0];
          const verifiedUserKey = virtualKey(user);
          let answer: Element | undefined;
          if (first && this.isUser(first)) {
            const currentUserKey = virtualKey(first);
            const reconciled =
              verifiedUserKey !== undefined &&
              verifiedUserKey < 0 &&
              currentUserKey !== undefined &&
              currentUserKey > 0;
            const identity = this.identity(first);
            if (
              (!reconciled && identity !== userIdentity) ||
              this.text(first) !== normalize(job.prompt)
            )
              throw new Diagnostic('PROMPT_CHANGED', 'Captured prompt changed', 'unknown');
            user = first;
            userIdentity = identity;
            answer = fresh[1];
          } else if (verifiedUserKey !== undefined) {
            // A long reply can scroll the positively identified user turn out of
            // the DOM. Correlate only its already tracked or adjacent assistant.
            if (!first) {
              await pause();
              continue;
            }
            if (fresh.length > 1)
              throw new Diagnostic(
                'TAB_INTERFERENCE',
                'Unexpected extra turn in dedicated tab',
                'unknown',
              );
            const firstKey = virtualKey(first);
            if (
              (assistantIdentity !== undefined && this.identity(first) === assistantIdentity) ||
              (verifiedUserKey > 0 && firstKey === verifiedUserKey + 1)
            )
              answer = first;
            else {
              await pause();
              continue;
            }
          } else {
            throw new Diagnostic('PROMPT_CHANGED', 'Captured prompt changed', 'unknown');
          }
          if (fresh.length > (first === answer ? 1 : 2) || (answer && this.isUser(answer)))
            throw new Diagnostic(
              'TAB_INTERFERENCE',
              'Unexpected extra turn in dedicated tab',
              'unknown',
            );
          if (!assistant && answer) {
            assistant = answer;
            assistantIdentity = this.identity(answer);
          }
          if (assistant) {
            progress.assistantSeen = true;
            progress.phase = 'await_completion';
            if (!answer || this.identity(answer) !== assistantIdentity)
              throw new Diagnostic(
                'ANSWER_CHANGED',
                'Captured assistant message was replaced',
                'unknown',
              );
            if (answer !== assistant) stableSince = Date.now();
            assistant = answer;
            const text = this.text(assistant);
            partialText = text;
            if (text !== lastText) {
              lastText = text;
              stableSince = Date.now();
            }
            const complete =
              this.config.selectors.complete.some((s) => assistant!.matches(s)) ||
              !!this.first(this.config.selectors.complete, assistant);
            progress.complete = complete;
            progress.generating = !!this.first(this.config.selectors.generating);
            if (
              (job.chat_url ? onTargetChat() : this.hasSavedThread(job.provider)) &&
              text &&
              complete &&
              !progress.generating &&
              Date.now() - stableSince >= this.config.stable_ms
            ) {
              const response = result(
                job,
                'completed',
                undefined,
                text,
                this.doc.location.href,
                this.capture(assistant, text),
              );
              if (utf8Bytes(JSON.stringify(response)) > MAX_RESULT_BYTES)
                throw new Diagnostic(
                  'ANSWER_TOO_LARGE',
                  'Answer exceeds native frame limit',
                  'failed',
                );
              return response;
            }
          }
        }
        await pause();
      }
      return result(
        job,
        'timeout',
        'DOM_TIMEOUT: ' +
          JSON.stringify({
            ...progress,
            documentVisibility: this.doc.visibilityState,
            userMatches: this.doc.querySelectorAll(this.config.selectors.user.join(',')).length,
            assistantMatches: this.doc.querySelectorAll(this.config.selectors.assistant.join(','))
              .length,
          }),
        partialText.slice(0, 500_000),
        this.doc.location.href,
        assistant ? this.capture(assistant, partialText.slice(0, 500_000)) : undefined,
      );
    } catch (error) {
      const d =
        error instanceof Diagnostic
          ? error
          : new Diagnostic(
              'DOM_ERROR',
              'Unexpected DOM adapter error',
              sent ? 'unknown' : 'failed',
            );
      const preservePartial =
        d.status === 'timeout' || ['CAPTCHA', 'QUOTA', 'PROVIDER_ERROR'].includes(d.code);
      return result(
        job,
        d.status,
        d.message,
        preservePartial ? partialText.slice(0, 500_000) : '',
        this.doc.location.href,
      );
    } finally {
      // Only undo an exact unsent draft this run wrote. A changed or sent draft is left alone.
      if (
        !clicked &&
        written?.isConnected &&
        normalize(this.value(written)) === normalize(job.prompt)
      ) {
        try {
          this.setValue(written, '');
        } catch {
          /* Provider removed its editable control. */
        }
      }
      observer?.disconnect();
      if (timer) clearTimeout(timer);
    }
  }
}
