# Multi-Chat Agent MVP integration contract

User intent: Windows, Python >=3.11, Chrome MV3, TypeScript. No chatbot APIs. Codex writes a plan and invokes CLI; it never reads full responses during normal operation. Authors produce sections in parallel, separate editor receives all author outputs and returns final cells. Python assembles and validates notebook without executing generated code. CLI also supports direct single-provider ask.

## Ownership
Backend chat owns `src/multi_chat_agent/`, `pyproject.toml`, Python tests. Extension chat owns `extension/`, browser mock tests. Docs/skill chat owns `README.md`, `examples/`, `.agents/`, `scripts/` and user skill installation. Integration chat coordinates changes.

## Native wire protocol
Native host name `com.multichat.agent`. JSON framed with uint32 little endian byte length on stdin/stdout. stdout is protocol only. Native host launched by Chrome; CLI communicates via shared SQLite under `%LOCALAPPDATA%/MultiChatAgent` (override `MCA_HOME`). Native host polls pending command queue in that database, sends each command once, receives result, saves body to file, updates command state. Ambiguous delivery must not be automatically retried. Multiple host processes must claim commands transactionally.

Host -> extension:
`{"type":"job","request_id":"uuid","provider":"deepseek|qwen","prompt":"...","conversation_key":"task-id:provider:role","timeout_ms":180000}`

Extension -> host:
`{"type":"result","request_id":"uuid","status":"completed|failed|timeout|needs_user_action|unknown","text":"...","conversation_url":"https://...","error":"optional diagnostic without secrets"}`

Extension may send `{"type":"hello","version":1}` on connection; host must ignore/record safely. Extension serializes jobs per tab and supports distinct providers concurrently. Durable request IDs prevent re-send after worker reconnect; ambiguous request becomes unknown/needs_user_action. No login, CAPTCHA, or quota bypass.

## Plan and CLI
Package `multi_chat_agent`, executable `mca`, `python -m multi_chat_agent` equivalent. Commands `mca run PLAN [--wait]`, `mca status TASK_ID`, `mca ask PROVIDER --prompt TEXT [--wait]`, `mca doctor`. Run/ask enqueue and persist; `--wait` drives scheduler to completion, no full answer printed. All CLI stdout JSON summaries only, including paths. `mca native-host` is native host entrypoint. CLI errors are concise structured diagnostics and nonzero exit.

Plan JSON: `task_id` (safe path component), `objective`, `jobs` array of `{id,provider,prompt,depends_on:[],timeout:180}`, optional `editor:{provider,prompt,timeout:300}`, `output:{format:"ipynb|markdown",path:"..."}`. Cycles/unknown dependencies/duplicate IDs rejected. Dispatcher includes dependency results in dependent prompts without passing them through Codex. Editor receives objective, plan and all author outputs; prompt explicitly requests a JSON object `{"cells":[{"cell_type":"markdown|code","source":"..."}]}`. Accept fenced JSON; reject malformed payload, save raw result, never claim malformed notebook complete. Max one formatting repair request to editor. Notebook assembly uses nbformat, no code execution. Plain direct ask stores raw answer and returns its path.

## Skill/docs
Skill `use-chat-bots`, installable in `~/.codex/skills/use-chat-bots`; calls venv executable via absolute path, returns only summary. No web responses in Codex context by default. Russian README with install/uninstall native host for HKCU and explicit unpacked Chrome extension loading. Do not claim real provider success without live tests. Configurable selectors, clear errors, tests with mock pages required.
