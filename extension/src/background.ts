import { BrowserPlatform, store } from './browser';
import { Engine } from './engine';
import { isObject, type Result } from './protocol';

let port: chrome.runtime.Port | undefined;
const diagnostic = (message: string) => {
  void store.set('diagnostic', { message, time: new Date().toISOString() }).catch(() => {});
};
function emit(response: Result) {
  try {
    port?.postMessage(response);
  } catch {
    diagnostic('NATIVE_DISCONNECTED: Result retained for replay');
  }
}
const platform = new BrowserPlatform();
const engine = new Engine(store, platform, emit, diagnostic);
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await engine.recover();
})();

function connect() {
  if (port) return;
  try {
    const connected = chrome.runtime.connectNative('com.multichat.agent');
    port = connected;
    connected.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message;
      if (port === connected) port = undefined;
      diagnostic(
        `NATIVE_DISCONNECTED: ${error ?? 'Host disconnected'}; install/check com.multichat.agent`,
      );
      void chrome.alarms.create('native-reconnect', { delayInMinutes: 0.5 });
    });
    connected.onMessage.addListener((message: unknown) => {
      void ready
        .then(() => engine.accept(message))
        .catch(() => diagnostic('ENGINE_FAILURE: Request not resubmitted'));
    });
    connected.postMessage({ type: 'hello', version: 1 });
    void engine.replay().catch(() => diagnostic('REPLAY_FAILURE: Storage unavailable'));
  } catch {
    port = undefined;
    diagnostic('NATIVE_UNAVAILABLE: Check native host registration');
  }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!isObject(message)) return;
  if (message.type === 'authorize') {
    void ready
      .then(() => platform.authorize(message, sender))
      .then(respond)
      .catch(() => respond({ authorized: false }));
    return true;
  }
  // Only our extension options page may request status; pages cannot enqueue jobs.
  if (
    message.type === 'status' &&
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL('options.html')
  ) {
    respond({ connected: !!port });
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'native-reconnect') void ready.then(connect);
});
chrome.runtime.onStartup.addListener(() => {
  void ready.then(connect);
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create('native-reconnect', { periodInMinutes: 0.5 });
  void ready.then(connect);
});
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
void ready
  .then(connect)
  .catch(() => diagnostic('STORAGE_FAILURE: Bridge disabled until storage is available'));
