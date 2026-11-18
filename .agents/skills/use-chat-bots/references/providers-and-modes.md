# Provider launch and modes

Use the absolute interpreter from `installation.md`. All commands emit compact JSON metadata; do not read response files.

```powershell
& 'C:\Users\User\Documents\ChatGPT\MultiChatAgent\.venv\Scripts\python.exe' -m multi_chat_agent providers
& 'C:\Users\User\Documents\ChatGPT\MultiChatAgent\.venv\Scripts\python.exe' -m multi_chat_agent open deepseek --think on --search off --wait
& 'C:\Users\User\Documents\ChatGPT\MultiChatAgent\.venv\Scripts\python.exe' -m multi_chat_agent open qwen --wait
& 'C:\Users\User\Documents\ChatGPT\MultiChatAgent\.venv\Scripts\python.exe' -m multi_chat_agent ask qwen --prompt 'User request' --think off --search on --wait
```

`providers` describes the local adapters and their declared modes, not the site's current mode state or the result of a live compatibility test. Get provider IDs and supported mode names with `providers`.

`open` creates/prepares an owned conversation, applies only requested modes, then returns `conversation_url` in its result summary. It never submits a composer prompt, invokes an editor or assembles an artifact. The internal open sentinel is a wire implementation detail, never a user message. Do not replace `open` with an empty or demonstration `ask`.

`--think on|off` and `--search on|off` become boolean `think` and `search` settings. Repeat `--mode NAME=VALUE` for another supported setting, or use `--mode think=on --mode search=off` as the generic equivalent. Generic `on`/`off` become booleans; other values remain strings, so `--mode think=true` is not a boolean equivalent. Use only names/types declared by `providers`. A conflict such as `--think on --mode think=off` is an error, not precedence. Mode names are lowercase letters/digits with `_` or `-`, start with a letter and have at most 32 characters. At most 16 settings are allowed, and string values must be nonblank and at most 100 characters.

Omitting a flag or a plan mode key leaves that site's state untouched, even if another task changed it. Do not impose `off` defaults. When a setting is explicit, the adapter must read the control's state, change it only if necessary and verify the result before sending a prompt. An unsupported mode, missing/ambiguous control or unverified state is a `needs_user_action` failure; do not silently continue with a different mode. Invalid/conflicting command syntax is a structured CLI error. Login, CAPTCHA and quotas remain manual user actions.

For an already submitted task use `status TASK_ID --wait`. A queued/running summary is not proof that a tab is ready. After a timeout, unknown delivery or mode failure, report the diagnostic rather than automatically submitting a replacement request. Open success means tab readiness and requested mode verification; ask/document success additionally requires a new correlated response and applicable artifact validation.
