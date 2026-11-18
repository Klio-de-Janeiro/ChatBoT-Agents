import { Diagnostic, MAX_RESULT_BYTES, utf8Bytes, result, type Job, type Result } from './protocol';
import type { ProviderConfig } from './config';

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
    return {
      ready: !error && !!composer,
      signedIn: !error && !!composer && !!this.first(this.config.selectors.signedIn),
      error: error?.message,
      url: this.doc.location.href,
    };
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
      if (!this.doc.execCommand('insertText', false, value)) e.textContent = value;
    } else throw new Diagnostic('COMPOSER_UNSUPPORTED', 'Configured composer is not editable');
    e.dispatchEvent(
      new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
    e.dispatchEvent(new view.Event('change', { bubbles: true }));
  }
  async run(job: Job, authorize: () => Promise<void>): Promise<Result> {
    const start = Date.now(),
      deadline = start + job.timeout_ms;
    let sent = false,
      partialText = '',
      observer: MutationObserver | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const progress = {
      revision: 'live-dom-3',
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
    try {
      const problem = this.diagnostic();
      if (problem) throw problem;
      const composer = this.first(this.config.selectors.composer);
      if (!composer || !this.probe().signedIn)
        throw new Diagnostic(
          'DOM_UNSUPPORTED',
          'Missing composer or positive signed-in evidence; update provider selectors',
        );
      if (this.first(this.config.selectors.generating))
        throw new Diagnostic('TAB_BUSY', 'Provider is already generating');
      if (normalize(this.value(composer)))
        throw new Diagnostic('USER_DRAFT', 'Dedicated tab contains an unsent draft');
      const baseline = this.messages();
      const baselineText = baseline.map((e) => this.text(e));
      const baselineIds = baseline.map((e) => this.identity(e));
      const baselineSet = new Set(baselineIds);
      let user: Element | undefined, assistant: Element | undefined;
      let userIdentity: string | Element | undefined;
      let assistantIdentity: string | Element | undefined;
      this.setValue(composer, job.prompt);
      if (normalize(this.value(composer)) !== normalize(job.prompt))
        throw new Diagnostic('COMPOSER_MISMATCH', 'Composer did not retain the exact prompt');
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
          if (!this.isUser(fresh[0]!) || this.text(fresh[0]!) !== normalize(job.prompt))
            throw new Diagnostic(
              'PROMPT_CORRELATION',
              'New user message does not match this request',
              'unknown',
            );
          user = fresh[0];
          userIdentity = this.identity(user!);
          progress.userSeen = true;
          progress.phase = 'await_assistant';
        }
        if (user) {
          if (
            !fresh[0] ||
            this.identity(fresh[0]) !== userIdentity ||
            this.text(fresh[0]) !== normalize(job.prompt)
          )
            throw new Diagnostic('PROMPT_CHANGED', 'Captured prompt changed', 'unknown');
          user = fresh[0];
          if (fresh.length > 2 || (fresh[1] && this.isUser(fresh[1])))
            throw new Diagnostic(
              'TAB_INTERFERENCE',
              'Unexpected extra turn in dedicated tab',
              'unknown',
            );
          if (!assistant && fresh[1]) {
            assistant = fresh[1];
            assistantIdentity = this.identity(assistant);
          }
          if (assistant) {
            progress.assistantSeen = true;
            progress.phase = 'await_completion';
            if (!fresh[1] || this.identity(fresh[1]) !== assistantIdentity)
              throw new Diagnostic(
                'ANSWER_CHANGED',
                'Captured assistant message was replaced',
                'unknown',
              );
            if (fresh[1] !== assistant) stableSince = Date.now();
            assistant = fresh[1];
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
              text &&
              complete &&
              !progress.generating &&
              Date.now() - stableSince >= this.config.stable_ms
            ) {
              const response = result(job, 'completed', undefined, text, this.doc.location.href);
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
      observer?.disconnect();
      if (timer) clearTimeout(timer);
    }
  }
}
