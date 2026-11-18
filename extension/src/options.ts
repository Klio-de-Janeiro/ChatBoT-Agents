import { DEFAULT_SETTINGS, migrateLegacySelectors, parseSettings } from './config';
import { catalog, PROVIDERS } from './protocol';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const config = el<HTMLTextAreaElement>('config');
const message = el('message');
for (const provider of PROVIDERS) {
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = provider;
  const site = catalog[provider];
  const link = document.createElement('a');
  link.href = site.origin + site.start;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Открыть сайт';
  label.append(checkbox, ` ${site.name} · `, link);
  el('providers').append(label);
}
async function refresh() {
  const status = await chrome.runtime
    .sendMessage({ type: 'status' })
    .catch(() => ({ connected: false }));
  const diagnostic = (await chrome.storage.local.get('diagnostic')).diagnostic;
  el('diagnostic').textContent = JSON.stringify(
    {
      extension_id: chrome.runtime.id,
      native_host: 'com.multichat.agent',
      connected: status?.connected ?? false,
      last_diagnostic: diagnostic ?? null,
    },
    null,
    2,
  );
}
async function load() {
  const settings = migrateLegacySelectors(
    parseSettings(
      (await chrome.storage.local.get('settings')).settings ?? structuredClone(DEFAULT_SETTINGS),
    ),
  );
  for (const p of PROVIDERS) el<HTMLInputElement>(p).checked = settings.enabled.includes(p);
  config.value = JSON.stringify(settings.providers, null, 2);
  await refresh();
}
el('save').onclick = async () => {
  try {
    const settings = parseSettings({
      enabled: PROVIDERS.filter((p) => el<HTMLInputElement>(p).checked),
      providers: JSON.parse(config.value),
    });
    for (const c of Object.values(settings.providers))
      for (const selectors of Object.values(c.selectors))
        for (const selector of selectors) document.querySelector(selector);
    await chrome.storage.local.set({ settings });
    message.textContent = 'Сохранено';
  } catch (e) {
    message.textContent = `Ошибка: ${e instanceof Error ? e.message : 'Некорректная конфигурация'}`;
  }
};
el('defaults').onclick = () => {
  config.value = JSON.stringify(DEFAULT_SETTINGS.providers, null, 2);
  message.textContent = 'Селекторы восстановлены в редакторе; нажмите Сохранить';
};
el('refresh').onclick = () => {
  void refresh();
};
void load();
