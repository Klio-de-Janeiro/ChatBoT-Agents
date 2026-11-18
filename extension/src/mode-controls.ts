import { isObject, validModeName, type Provider } from './protocol';

type NamedControl = { selector: string[]; labels: string[] };
export type ToggleControl = NamedControl & {
  kind: 'toggle';
  stateAttribute: 'aria-pressed';
  activation: 'enter' | 'click';
};
export type SelectControl = {
  kind: 'select';
  trigger: string[];
  label: string[];
  menu: string[];
  option: string[];
  optionLabel: string[];
  selected: string[];
  states: Record<string, string[]>;
};
export type SearchControl = {
  kind: 'search-chip';
  trigger: NamedControl;
  menu: string[];
  option: string[];
  optionLabel: string[];
  chip: string[];
  labels: string[];
  close: string[];
};
export type ModeControl = ToggleControl | SelectControl | SearchControl;
export type ModeBinding = {
  control: string;
  type: 'boolean' | 'string';
  values: Record<string, string>;
};
export type ModeRegistry = {
  controls: Record<string, ModeControl>;
  bindings: Record<string, ModeBinding>;
  order: string[];
  timeout_ms: number;
  settle_ms: number;
};
const toggle = (labels: string[]): ToggleControl => ({
  kind: 'toggle',
  selector: ['.ds-toggle-button'],
  labels,
  stateAttribute: 'aria-pressed',
  activation: 'enter',
});
const booleanValues = { true: 'on', false: 'off' };
export const DEFAULT_MODE_REGISTRIES: Partial<Record<Provider, ModeRegistry>> &
  Record<'deepseek' | 'qwen', ModeRegistry> = {
  deepseek: {
    controls: {
      think: toggle(['DeepThink', 'Глубокое мышление']),
      search: toggle(['Search', 'Умный поиск', 'Поиск']),
    },
    bindings: {
      think: { control: 'think', type: 'boolean', values: booleanValues },
      search: { control: 'search', type: 'boolean', values: booleanValues },
    },
    order: ['search', 'think'],
    timeout_ms: 2000,
    settle_ms: 150,
  },
  qwen: {
    controls: {
      reasoning: {
        kind: 'select',
        trigger: ['.qwen-chat-v2-dropdown-menu-select-button'],
        label: ['.qwen-chat-v2-dropdown-menu-select-label'],
        menu: ['[role="menu"]'],
        option: ['[role="menuitem"]'],
        optionLabel: [],
        selected: ['.qwen-chat-v2-dropdown-menu-item-selected'],
        states: {
          fast: ['Быстрый', 'Fast'],
          thinking: ['Мышление', 'Thinking'],
          auto: ['Авто', 'Auto'],
        },
      },
      search: {
        kind: 'search-chip',
        trigger: {
          selector: ['button', '[role="button"]'],
          labels: ['Выбрать режим', 'Select mode'],
        },
        menu: ['[role="menu"]'],
        option: ['[role="menuitem"]'],
        optionLabel: ['.mode-select-dropdown-item-name'],
        chip: ['.mode-select-current-mode'],
        labels: ['Поиск в сети', 'Web search'],
        close: ['.mode-select-current-mode-close'],
      },
    },
    bindings: {
      think: { control: 'reasoning', type: 'boolean', values: { true: 'thinking', false: 'fast' } },
      reasoning: {
        control: 'reasoning',
        type: 'string',
        values: { fast: 'fast', thinking: 'thinking', auto: 'auto' },
      },
      search: { control: 'search', type: 'boolean', values: booleanValues },
    },
    order: ['search', 'reasoning'],
    timeout_ms: 2000,
    settle_ms: 150,
  },
};

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function stringList(value: unknown, allowEmpty = false): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= 20 &&
    value.every((item) => typeof item === 'string' && !!item.trim() && item.length <= 500)
  );
}
function namedControl(value: unknown): boolean {
  return (
    isObject(value) &&
    onlyKeys(value, ['selector', 'labels']) &&
    stringList(value.selector) &&
    stringList(value.labels)
  );
}
function validControl(value: unknown): value is ModeControl {
  if (!isObject(value)) return false;
  if (value.kind === 'toggle') {
    return (
      onlyKeys(value, ['kind', 'selector', 'labels', 'stateAttribute', 'activation']) &&
      stringList(value.selector) &&
      stringList(value.labels) &&
      value.stateAttribute === 'aria-pressed' &&
      ['enter', 'click'].includes(String(value.activation))
    );
  }
  if (value.kind === 'select') {
    const keys = [
      'kind',
      'trigger',
      'label',
      'menu',
      'option',
      'optionLabel',
      'selected',
      'states',
    ];
    return (
      onlyKeys(value, keys) &&
      ['trigger', 'label', 'menu', 'option', 'selected'].every((key) => stringList(value[key])) &&
      stringList(value.optionLabel, true) &&
      isObject(value.states) &&
      Object.keys(value.states).length > 0 &&
      Object.keys(value.states).length <= 16 &&
      Object.entries(value.states).every(
        ([key, labels]) => validModeName(key) && stringList(labels),
      )
    );
  }
  if (value.kind === 'search-chip') {
    return (
      onlyKeys(value, [
        'kind',
        'trigger',
        'menu',
        'option',
        'optionLabel',
        'chip',
        'labels',
        'close',
      ]) &&
      namedControl(value.trigger) &&
      ['menu', 'option', 'optionLabel', 'chip', 'labels', 'close'].every((key) =>
        stringList(value[key]),
      )
    );
  }
  return false;
}
function supportedState(control: ModeControl, state: string): boolean {
  return control.kind === 'select'
    ? Object.hasOwn(control.states, state)
    : ['on', 'off'].includes(state);
}
export function parseModeRegistry(value: unknown): ModeRegistry {
  if (
    !isObject(value) ||
    !onlyKeys(value, ['controls', 'bindings', 'order', 'timeout_ms', 'settle_ms']) ||
    !isObject(value.controls) ||
    !isObject(value.bindings) ||
    !Array.isArray(value.order)
  )
    throw new Error('Invalid mode registry');
  const controls = Object.entries(value.controls);
  if (
    controls.length > 16 ||
    controls.some(([name, control]) => !validModeName(name) || !validControl(control))
  )
    throw new Error('Invalid mode control');
  const bindings = Object.entries(value.bindings);
  if (bindings.length > 16) throw new Error('Too many registered modes');
  for (const [name, binding] of bindings) {
    if (
      !validModeName(name) ||
      !isObject(binding) ||
      !onlyKeys(binding, ['control', 'type', 'values']) ||
      !['boolean', 'string'].includes(String(binding.type)) ||
      typeof binding.control !== 'string' ||
      !Object.hasOwn(value.controls, binding.control) ||
      !isObject(binding.values)
    )
      throw new Error('Invalid mode binding');
    const control = value.controls[binding.control] as ModeControl;
    const entries = Object.entries(binding.values);
    if (
      !entries.length ||
      entries.length > 16 ||
      entries.some(
        ([setting, state]) =>
          !setting.trim() ||
          setting.length > 100 ||
          typeof state !== 'string' ||
          !supportedState(control, state),
      )
    )
      throw new Error('Invalid mode binding state');
  }
  if (
    value.order.length > 16 ||
    new Set(value.order).size !== value.order.length ||
    value.order.some((name) => typeof name !== 'string' || !Object.hasOwn(value.controls!, name))
  )
    throw new Error('Invalid mode order');
  if (
    typeof value.timeout_ms !== 'number' ||
    !Number.isInteger(value.timeout_ms) ||
    value.timeout_ms < 100 ||
    value.timeout_ms > 10000 ||
    typeof value.settle_ms !== 'number' ||
    !Number.isInteger(value.settle_ms) ||
    value.settle_ms < 25 ||
    value.settle_ms > 1000 ||
    value.settle_ms >= value.timeout_ms
  )
    throw new Error('Invalid mode timing');
  return value as ModeRegistry;
}
