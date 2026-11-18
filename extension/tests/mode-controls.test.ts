import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODE_REGISTRIES, parseModeRegistry } from '../src/mode-controls';
import { DEFAULT_SETTINGS, migrateLegacySelectors, parseSettings } from '../src/config';

test('mode registry is editable data and rejects executable or malformed controls', () => {
  for (const registry of Object.values(DEFAULT_MODE_REGISTRIES))
    assert.equal(parseModeRegistry(registry), registry);
  for (const change of [
    { controls: { model: { kind: 'javascript', code: 'alert(1)' } } },
    { timeout_ms: 0 },
    { settle_ms: 3000 },
    { bindings: { model: { control: 'missing', type: 'string', values: { a: 'a' } } } },
    { bindings: { think: { control: 'think', type: 'boolean', values: { true: 'unsupported' } } } },
  ])
    assert.throws(() => parseModeRegistry({ ...DEFAULT_MODE_REGISTRIES.deepseek, ...change }));
  const extra = structuredClone(DEFAULT_MODE_REGISTRIES.deepseek);
  extra.controls.research = { ...extra.controls.search! };
  extra.bindings.research = {
    control: 'research',
    type: 'boolean',
    values: { true: 'on', false: 'off' },
  };
  assert.equal(parseModeRegistry(extra).bindings.research!.control, 'research');
});
test('pre-0.2 settings preserve custom selectors and gain mode defaults', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  delete settings.providers.deepseek.modes;
  settings.providers.deepseek.selectors.send = ['button.custom'];
  const migrated = migrateLegacySelectors(parseSettings(settings));
  assert.deepEqual(migrated.providers.deepseek.selectors.send, ['button.custom']);
  assert.deepEqual(migrated.providers.deepseek.modes, DEFAULT_MODE_REGISTRIES.deepseek);
});
