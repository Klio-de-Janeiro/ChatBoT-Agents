import { Diagnostic, type Modes, type Provider } from './protocol';
import {
  DEFAULT_MODE_REGISTRIES,
  parseModeRegistry,
  type ModeRegistry,
  type ModeControl,
  type SelectControl,
  type SearchControl,
} from './mode-controls';

interface ModeDom {
  doc: Document;
  config: { poll_ms: number; modes?: ModeRegistry };
  all(selectors: string[], root?: ParentNode): Element[];
  first(selectors: string[], root?: ParentNode): Element | undefined;
  diagnostic(): Diagnostic | undefined;
}
type Target = { name: string; controlName: string; state: string; control: ModeControl };
const label = (element: Element): string =>
  (
    element.getAttribute('aria-label') ??
    (element as HTMLElement).innerText ??
    element.textContent ??
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();

function requestedTargets(provider: Provider, modes: Modes, registry: ModeRegistry): Target[] {
  if (provider === 'qwen' && Object.hasOwn(modes, 'think') && Object.hasOwn(modes, 'reasoning')) {
    throw new Diagnostic('MODE_CONFLICT', 'qwen: use either think or reasoning, not both');
  }
  const targets = new Map<string, Target>();
  for (const [name, value] of Object.entries(modes)) {
    const binding = Object.hasOwn(registry.bindings, name) ? registry.bindings[name] : undefined;
    if (!binding)
      throw new Diagnostic('MODE_UNSUPPORTED', `${provider}.${name}: no registered control`);
    if (typeof value !== binding.type || !Object.hasOwn(binding.values, String(value))) {
      throw new Diagnostic(
        'MODE_VALUE_UNSUPPORTED',
        `${provider}.${name}: expected ${binding.type}, one of ${Object.keys(binding.values).join(', ').slice(0, 300)}`,
      );
    }
    const state = binding.values[String(value)]!;
    const old = targets.get(binding.control);
    if (old && old.state !== state)
      throw new Diagnostic(
        'MODE_CONFLICT',
        `${provider}.${name}: conflicting states for ${binding.control}`,
      );
    targets.set(binding.control, {
      name,
      controlName: binding.control,
      state,
      control: registry.controls[binding.control]!,
    });
  }
  const rank = (name: string) => {
    const index = registry.order.indexOf(name);
    return index < 0 ? 999 : index;
  };
  return [...targets.values()].sort((a, b) => rank(a.controlName) - rank(b.controlName));
}

class ModeController {
  constructor(
    private dom: ModeDom,
    private provider: Provider,
    private registry: ModeRegistry,
    private deadline: number,
  ) {}
  private failure(code: string, target: Target, message: string): Diagnostic {
    return new Diagnostic(code, `${this.provider}.${target.name}: ${message}`);
  }
  private unique(elements: Element[], target: Target, purpose: string): Element | undefined {
    const distinct = [...new Set(elements)];
    if (distinct.length > 1)
      throw this.failure('MODE_CONTROL_AMBIGUOUS', target, `multiple ${purpose} controls`);
    return distinct[0];
  }
  private named(selectors: string[], labels: string[], target: Target): Element {
    const found = this.unique(
      this.dom.all(selectors).filter((element) => labels.includes(label(element))),
      target,
      'matching',
    );
    if (!found)
      throw this.failure('MODE_CONTROL_MISSING', target, `expected ${labels.join(' | ')}`);
    return found;
  }
  private selectTrigger(control: SelectControl, target: Target): Element {
    const knownLabels = Object.values(control.states).flat();
    const triggers = this.dom.all(control.trigger).filter((element) => {
      const text = this.dom.first(control.label, element);
      return !!text && knownLabels.includes(label(text));
    });
    const found = this.unique(triggers, target, 'reasoning dropdown');
    if (!found)
      throw this.failure(
        'MODE_STATE_UNREADABLE',
        target,
        'reasoning dropdown is missing or has an unrecognized label',
      );
    return found;
  }
  private searchChip(control: SearchControl, target: Target): Element | undefined {
    // An unrelated active tool is deliberately not considered a search chip.
    return this.unique(
      this.dom.all(control.chip).filter((element) => control.labels.includes(label(element))),
      target,
      'search chip',
    );
  }
  read(target: Target): string {
    const control = target.control;
    if (control.kind === 'toggle') {
      const element = this.named(control.selector, control.labels, target);
      const pressed = element.getAttribute(control.stateAttribute);
      if (pressed !== 'true' && pressed !== 'false')
        throw this.failure('MODE_STATE_UNREADABLE', target, 'aria-pressed must be true or false');
      return pressed === 'true' ? 'on' : 'off';
    }
    if (control.kind === 'search-chip') {
      if (this.searchChip(control, target)) return 'on';
      if (!this.dom.all(control.chip).length)
        this.named(control.trigger.selector, control.trigger.labels, target);
      return 'off';
    }
    const trigger = this.selectTrigger(control, target);
    const current = label(this.dom.first(control.label, trigger)!);
    return Object.keys(control.states).find((state) => control.states[state]!.includes(current))!;
  }
  private ensureEnabled(element: Element, target: Target): void {
    if (
      !element.isConnected ||
      element.hasAttribute('disabled') ||
      element.closest('[aria-disabled="true"]')
    ) {
      throw this.failure('MODE_CONTROL_DISABLED', target, 'requested control is disabled');
    }
  }
  private activate(element: Element, target: Target, method: 'click' | 'enter' = 'click'): void {
    this.ensureEnabled(element, target);
    const view = this.dom.doc.defaultView!;
    if (method === 'enter') {
      (element as HTMLElement).focus();
      if (this.dom.doc.activeElement !== element)
        throw this.failure('MODE_FOCUS_FAILED', target, 'toggle could not receive focus');
      for (const type of ['keydown', 'keyup'])
        element.dispatchEvent(
          new view.KeyboardEvent(type, {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
    } else (element as HTMLElement).click();
  }
  private pause(): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const observer = new this.dom.doc.defaultView!.MutationObserver(wake);
      function wake() {
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      }
      observer.observe(this.dom.doc.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      timer = setTimeout(wake, this.dom.config.poll_ms);
    });
  }
  private async waitFor<T>(
    target: Target,
    check: () => T | undefined,
    description: string,
  ): Promise<T> {
    const until = Math.min(this.deadline, Date.now() + this.registry.timeout_ms);
    while (Date.now() < until) {
      const problem = this.dom.diagnostic();
      if (problem) throw problem;
      const value = check();
      if (value !== undefined) return value;
      await this.pause();
    }
    throw this.failure('MODE_VERIFY_FAILED', target, description);
  }
  private option(
    control: SelectControl | SearchControl,
    target: Target,
    labels: string[],
  ): Element | undefined {
    const candidates: Element[] = [];
    for (const menu of this.dom.all(control.menu)) {
      for (const option of this.dom.all(control.option, menu)) {
        const leaf = control.optionLabel.length
          ? this.dom.first(control.optionLabel, option)
          : option;
        if (leaf && labels.includes(label(leaf))) candidates.push(option);
      }
    }
    return this.unique(candidates, target, 'menu option');
  }
  async change(target: Target): Promise<void> {
    const control = target.control;
    if (control.kind === 'toggle') {
      this.activate(
        this.named(control.selector, control.labels, target),
        target,
        control.activation,
      );
    } else if (control.kind === 'select') {
      this.activate(this.selectTrigger(control, target), target);
      const option = await this.waitFor(
        target,
        () => this.option(control, target, control.states[target.state]!),
        'requested reasoning option did not appear',
      );
      this.activate(option, target);
      // If the menu remains open, its explicit selected marker must agree too.
      await this.waitFor(
        target,
        () => {
          const visibleOption = this.option(control, target, control.states[target.state]!);
          const selected =
            !visibleOption ||
            control.selected.some((selector) => visibleOption.matches(selector)) ||
            !!this.dom.first(control.selected, visibleOption);
          return this.read(target) === target.state && selected ? true : undefined;
        },
        `requested ${target.state} was not selected`,
      );
    } else if (target.state === 'off') {
      const chip = this.searchChip(control, target)!;
      const close = this.unique(this.dom.all(control.close, chip), target, 'search close');
      if (!close)
        throw this.failure('MODE_CONTROL_MISSING', target, 'search chip has no close control');
      this.ensureEnabled(chip, target);
      this.activate(close, target);
    } else {
      this.activate(this.named(control.trigger.selector, control.trigger.labels, target), target);
      const option = await this.waitFor(
        target,
        () => this.option(control, target, control.labels),
        'Web search menu option did not appear',
      );
      this.activate(option, target);
    }
    await this.waitFor(
      target,
      () => (this.read(target) === target.state ? true : undefined),
      `requested ${target.state} was not reached; no second toggle attempted`,
    );
  }
  async verifyAll(targets: Target[]): Promise<void> {
    if (!targets.length) return;
    let stableSince: number | undefined;
    let mismatch = targets[0]!;
    try {
      await this.waitFor(
        targets[0]!,
        () => {
          const failed = targets.find((target) => this.read(target) !== target.state);
          if (failed) {
            mismatch = failed;
            stableSince = undefined;
            return undefined;
          }
          stableSince ??= Date.now();
          return Date.now() - stableSince >= this.registry.settle_ms ? true : undefined;
        },
        'requested states did not remain verified',
      );
    } catch (error) {
      if (error instanceof Diagnostic && error.code === 'MODE_VERIFY_FAILED')
        throw this.failure(
          'MODE_VERIFY_FAILED',
          mismatch,
          `requested ${mismatch.state}, observed ${this.read(mismatch)} during final verification`,
        );
      throw error;
    }
  }
}

export async function applyRequestedModes(
  dom: ModeDom,
  provider: Provider,
  modes: Modes,
  deadline: number,
): Promise<void> {
  if (!Object.keys(modes).length) return;
  const configured = dom.config.modes ?? DEFAULT_MODE_REGISTRIES[provider];
  if (!configured)
    throw new Diagnostic('MODE_UNSUPPORTED', `${provider} has no configured mode controls`);
  const registry = parseModeRegistry(configured);
  const targets = requestedTargets(provider, modes, registry);
  const controller = new ModeController(dom, provider, registry, deadline);
  const changed: string[] = [];
  try {
    // Validate every observable state before changing any control.
    for (const target of targets) controller.read(target);
    for (const target of targets) {
      const problem = dom.diagnostic();
      if (problem) throw problem;
      if (controller.read(target) !== target.state) {
        await controller.change(target);
        changed.push(`${target.name}=${target.state}`);
      }
    }
    await controller.verifyAll(targets);
  } catch (error) {
    const diagnostic =
      error instanceof Diagnostic
        ? error
        : new Diagnostic(
            'MODE_DOM_ERROR',
            `${provider}: invalid mode selectors or unexpected control error`,
          );
    const partial = changed.length ? `; changes already verified: ${changed.join(', ')}` : '';
    throw new Diagnostic(
      diagnostic.code,
      `${diagnostic.message.replace(`${diagnostic.code}: `, '')}${partial}; prompt not submitted`.slice(
        0,
        900,
      ),
      diagnostic.status,
    );
  }
}
