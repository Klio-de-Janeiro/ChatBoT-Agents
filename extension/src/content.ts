import { DomAdapter } from './dom';
import { isObject, originProvider, parseJob } from './protocol';
import { parseSettings, type ProviderConfig, DEFAULT_SETTINGS } from './config';

const documentToken = crypto.randomUUID();
let busy = false;
const ownSender = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id &&
  (!sender.url || sender.url.startsWith(chrome.runtime.getURL('')));
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!ownSender(sender) || !isObject(message) || !['probe', 'run'].includes(String(message.type)))
    return;
  const provider = originProvider(location.href);
  if (!provider) return;
  try {
    // Reuse strict config parser; content scripts do not read extension storage.
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.providers[provider] = message.config as ProviderConfig;
    const config = parseSettings(settings).providers[provider];
    const adapter = new DomAdapter(document, config);
    if (message.type === 'probe') {
      respond({
        ...adapter.probe(),
        document_token: documentToken,
        message_count: adapter.messages().length,
        draft:
          !!adapter.first(config.selectors.composer) &&
          !!adapter.value(adapter.first(config.selectors.composer)!).trim(),
      });
      return;
    }
    const job = parseJob(message.job);
    if (
      job.provider !== provider ||
      message.document_token !== documentToken ||
      typeof message.nonce !== 'string' ||
      busy
    ) {
      respond({ error: 'INVALID_RUN_OR_BUSY' });
      return;
    }
    busy = true;
    void adapter
      .run(job, async () => {
        const answer: unknown = await chrome.runtime.sendMessage({
          type: 'authorize',
          request_id: job.request_id,
          nonce: message.nonce,
          document_token: documentToken,
        });
        if (!isObject(answer) || answer.authorized !== true)
          throw new Error('Submission barrier denied');
      })
      .then(respond)
      .finally(() => {
        busy = false;
      });
    return true;
  } catch {
    respond({ error: 'INVALID_CONFIG_OR_COMMAND' });
  }
});
