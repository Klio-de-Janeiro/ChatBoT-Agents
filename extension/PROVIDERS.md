# Provider evidence and limitations

Inspection date: 2026-11-17. Production domains are fixed to `https://chat.deepseek.com` and `https://chat.qwen.ai`.

Official sources confirm the web endpoints:

- DeepSeek official docs link the web chat: https://api-docs.deepseek.com/news/news1210/
- Qwen official website links its web service: https://qwen.ai/ and https://qwen.ai/qwenchat
- Chrome Native Messaging protocol and host registration: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- MV3 worker lifecycle requires persistent state: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

Read-only public browser inspection (`npm run inspect:providers`, fresh Playwright Chromium, no user profile):

| Provider | Observed                                                                  | What was not verified                                                                |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| DeepSeek | HTTP 403, CloudFront “Request blocked”, no composer or account DOM        | Authenticated composer, message containers, submit and streaming/completion controls |
| Qwen     | HTTP 200, title “Qwen”; no composer/account DOM during bounded inspection | Authenticated message containers, submit and streaming/completion controls           |

The web fetch also showed a Qwen unsupported-system page. No real prompt was submitted. No existing authenticated Chrome tab/profile was available through the connected browser inventory. The implementation therefore ships editable **candidate selectors**, not a claim of validated current live compatibility. In particular DeepSeek hashed role/button classes may need a local selector update; no broad unscoped message fallback is used to pretend success.

The local mock models signed-in/account UI, textarea, historical user/assistant messages, streamed text, scoped copy/completion marker, global stop control, route changes, replacement messages, login, CAPTCHA, quota and drafts. Tests run the production MV3 worker/content code with a test-only native port. These prove state/correlation behavior against the modeled DOM; they do not prove either provider currently uses those selectors. This is the principal remaining acceptance limitation.

The extension never reads cookies, copies profiles, changes login state, bypasses challenges or calls chatbot network APIs. Long responses can remain unknown if the tab/document or worker is lost; the extension deliberately does not retry them.

Authenticated read-only inspection on 2026-11-17 confirmed that the initial selectors need revision: DeepSeek composer is a textarea with placeholder "Сообщение для DeepSeek" and no `chat-input` ID; Qwen uses `textarea.message-input-textarea` with placeholder "Спросить Qwen". DeepSeek controls include `div[role=button]`, often without accessible labels. No live send/completion controls have been validated. Do not treat adding the composer selectors alone as a working provider adapter. The CLI test could not reach either provider because no native host was registered/connected.

## Subsequent authenticated UI tests

After host registration and provider enablement, CLI reached the extension but existing tabs lacked its content script. Reloaded both pages after checking for empty drafts. Separate test conversations were submitted through the browser UI: DeepSeek returned a short response with the final action toolbar; Qwen returned a dual-response comparison card. These are UI tests, not successful end-to-end CLI tests.

Updated selector defaults cover observed message roles, composer, submit controls, account evidence and completion markers. Stored legacy selector lists migrate only when unchanged; custom lists and enabled providers are preserved. Qwen dual-response cards produce a provider error requiring manual review, rather than silently selecting a response. The rebuilt extension must be reloaded in Chrome before an end-to-end CLI retest. Local verification: 13 unit tests and 13 mock-browser scenarios passed.
