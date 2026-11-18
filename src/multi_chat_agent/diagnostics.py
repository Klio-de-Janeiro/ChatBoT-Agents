"""Publish bounded app diagnostics from result receipts, never response text files."""

from __future__ import annotations

import json
import re
from pathlib import Path

_APP_CODES = frozenset(
    {
        "CAPTCHA",
        "LOGIN_REQUIRED",
        "QUOTA",
        "PROVIDER_ERROR",
        "DOM_UNSUPPORTED",
        "TAB_BUSY",
        "USER_DRAFT",
        "PROVIDER_NOT_READY",
        "COMPOSER_MISMATCH",
        "SEND_CONTROL_MISSING",
        "DEADLINE",
        "TAB_INTERFERENCE",
        "HISTORY_CHANGED",
        "IDENTITY_COLLISION",
        "PROMPT_CORRELATION",
        "RESPONSE_TIMEOUT",
        "SUBMISSION_UNKNOWN",
        "TAB_CLOSED",
        "TAB_NAVIGATED",
        "CHAT_URL_CHANGED",
        "CHAT_HISTORY_MISSING",
        "PROVIDER_DISABLED",
        "AUTH_REQUIRED",
        "BRIDGE_ERROR",
        "INVALID_RESULT",
        "INVALID_JOB",
        "QUEUE_TIMEOUT",
        "CONVERSATION_QUARANTINED",
        "DOMAIN_DISABLED",
        "INVALID_PAGE_RESULT",
        "INVALID_SELECTOR",
        "COMPOSER_UNSUPPORTED",
        "SEND_CONTROL_CHANGED",
        "PROMPT_CHANGED",
        "ANSWER_CHANGED",
        "ANSWER_TOO_LARGE",
        "DOM_ERROR",
        "CONVERSATION_LOST",
        "MISSING_TAB",
        "MISSING_PROVIDER_TAB",
        "LOGIN_OR_DOM_REQUIRED",
        "TAB_CREATE_FAILED",
        "TAB_REDIRECTED",
        "NEW_CHAT_NOT_EMPTY",
        "NEW_CHAT_BLOCKED",
        "NEW_CHAT_NOT_READY",
        "WORKSPACE_REQUIRED",
        "WORKSPACE_MINIMIZED",
        "WORKSPACE_HIDDEN",
        "CONTENT_SCRIPT_UNAVAILABLE",
        "CONTENT_TIMEOUT",
        "ANSWER_COPY_FAILED",
    }
)


def receipt_diagnostic(metadata_path: str | None) -> dict[str, str] | None:
    if not metadata_path:
        return None
    try:
        with Path(metadata_path).open(encoding="utf-8") as stream:
            # Native receipts contain no answer body. Do not consume arbitrary files
            # or an unexpectedly large metadata payload through the CLI summary.
            serialized = stream.read(16385)
        if len(serialized) > 16384:
            return None
        receipt = json.loads(serialized)
    except (OSError, ValueError):
        return None
    if not isinstance(receipt, dict) or not isinstance(receipt.get("error"), str):
        return None
    diagnostic = re.match(r"^([A-Z][A-Z0-9_]{1,63}):\s*(.*)", receipt["error"], re.DOTALL)
    if not diagnostic:
        return None
    code, message = diagnostic.groups()
    if code not in _APP_CODES and not code.startswith("MODE_"):
        return None
    message = " ".join(message.split())[:320]
    return {"code": code, "message": message}
