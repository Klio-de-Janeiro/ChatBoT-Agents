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
