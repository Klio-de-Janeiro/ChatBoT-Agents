# MultiChatAgent

## Product intent

- Codex plans and invokes the CLI. Full chatbot responses stay in local files and move between web bots through deterministic code, outside the Codex model context.
- Authors write sections; a separate web-bot editor reviews and returns final material. The assembler validates notebook structure without executing generated code.
- Use existing authenticated browser profiles. Never copy cookies or automate login/CAPTCHA bypass.

## Maintainability

- Keep provider selectors and timing in extension configuration; browser operations, scheduling, storage and artifact assembly have separate modules.
- Prefer named functions, explicit types and short readable branches over compressed statements. Explain unusual failure/recovery behavior in comments.
- Preserve the wire contract in CONTRACT.md. Update the examples and README when public CLI or plan fields change.
- Never automatically retry a request whose submission may have occurred. Save diagnostic status and already received data.
- CLI stdout contains compact JSON summaries and file paths; answer bodies are never printed by default.

## Validation

- Python: `.venv/Scripts/python.exe -m pytest` and `.venv/Scripts/python.exe -m ruff check src tests`.
- Extension: `npm.cmd test` and `npm.cmd run build` from `extension/`.
- Windows installer: `./scripts/test_installation.ps1`.
- Distinguish mock-browser success from real-service success in all reports.
