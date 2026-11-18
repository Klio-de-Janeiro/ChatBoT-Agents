import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, migrateLegacySelectors } from '../src/config';

test('selector migration upgrades stored defaults and preserves opt-in and custom selectors', () => {
  const saved = structuredClone(DEFAULT_SETTINGS);
  saved.enabled = ['qwen'];
  saved.providers.qwen.selectors.composer = [
    'textarea#chat-input',
    '#chat-input[contenteditable="true"]',
    'textarea#prompt-textarea',
  ];
  saved.providers.deepseek.selectors.send = ['#locally-customized-send'];
  const updated = migrateLegacySelectors(saved);
  assert.deepEqual(updated.enabled, ['qwen']);
  assert.ok(updated.providers.qwen.selectors.composer.includes('textarea.message-input-textarea'));
  assert.deepEqual(updated.providers.deepseek.selectors.send, ['#locally-customized-send']);
  assert.equal(saved.providers.qwen.selectors.composer.length, 3);
  assert.deepEqual(migrateLegacySelectors(updated), updated);
});

test('Qwen role-button migration upgrades only the unchanged 0.2.0 search control', () => {
  const saved = structuredClone(DEFAULT_SETTINGS);
  const search = saved.providers.qwen.modes!.controls.search;
  assert.equal(search?.kind, 'search-chip');
  if (search?.kind !== 'search-chip') throw new Error('Expected search chip');
  search.trigger.selector = ['button'];
  const updated = migrateLegacySelectors(saved);
  assert.deepEqual(updated.providers.qwen.modes, DEFAULT_SETTINGS.providers.qwen.modes);
  assert.deepEqual(migrateLegacySelectors(updated), updated);
  search.trigger.labels = ['My local control'];
  assert.deepEqual(migrateLegacySelectors(saved).providers.qwen.modes, saved.providers.qwen.modes);
});
test('Qwen mobile authentication migration upgrades only the exact prior default', () => {
  const saved = structuredClone(DEFAULT_SETTINGS);
  saved.providers.qwen.selectors.signedIn = saved.providers.qwen.selectors.signedIn.filter(
    (selector) => selector !== 'button.user-menu-btn-mobile',
  );
  const updated = migrateLegacySelectors(saved);
  assert.deepEqual(
    updated.providers.qwen.selectors.signedIn,
    DEFAULT_SETTINGS.providers.qwen.selectors.signedIn,
  );
  assert.deepEqual(migrateLegacySelectors(updated), updated);
  saved.providers.qwen.selectors.signedIn = ['button.local-auth'];
  assert.deepEqual(migrateLegacySelectors(saved).providers.qwen.selectors.signedIn, [
    'button.local-auth',
  ]);
});
