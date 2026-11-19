"""Provider-native answer copies: Markdown, structured content and publication."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from multi_chat_agent.cli import main
from multi_chat_agent.config import Settings
from multi_chat_agent.models import AnswerContent, JobPlan, NativeResult
from multi_chat_agent.scheduler import Scheduler
from multi_chat_agent.store import Store

MARKDOWN = "## Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```python\nprint(1)\n```\n"
CONTENT = {
    "version": 1,
    "plain": "Title\nab12\nprint(1)",
    "blocks": [
        {"type": "heading", "level": 2, "text": "Title", "markdown": "Title"},
        {
            "type": "table",
            "header": ["a", "b"],
            "rows": [["1", "2"]],
            "align": [None, None],
        },
        {"type": "code", "language": "python", "text": "print(1)", "markdown": "```python"},
    ],
}


def rich(command, *, status="completed", text="plain answer", url=None):
    return NativeResult(
        type="result",
        request_id=command["request_id"],
        status=status,
        text=text,
        markdown=MARKDOWN,
        content=AnswerContent.model_validate(CONTENT),
        conversation_url=url,
    )


def test_native_result_accepts_rich_capture_and_rejects_unknown_blocks():
    result = NativeResult.model_validate(
        {
            "type": "result",
            "request_id": "r1",
            "status": "completed",
            "text": "plain",
            "markdown": MARKDOWN,
            "content": CONTENT,
            "future_field": "ignored",
        }
    )
    assert result.markdown == MARKDOWN
    assert [block.type for block in result.content.blocks] == ["heading", "table", "code"]
    # Forward-compatible block keys are preserved for future renderers.
    assert result.content.blocks[0].model_dump()["level"] == 2
    with pytest.raises(ValidationError):
        NativeResult.model_validate(
            {
                "type": "result",
                "request_id": "r1",
                "status": "completed",
                "content": {"blocks": [{"type": "attachment"}]},
            }
        )


def test_accept_result_saves_markdown_and_content_next_to_raw_text(store, plan):
    store.submit(plan)
    Scheduler(store).tick(plan.task_id)
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result("host", rich(command))
    job = store.jobs(plan.task_id)["intro"]
    assert Path(job["result_path"]).read_text(encoding="utf-8") == "plain answer"
    assert Path(job["markdown_path"]).read_text(encoding="utf-8") == MARKDOWN
    directory = store.task_dir(plan.task_id) / "responses"
    content = json.loads((directory / "intro.content.json").read_text(encoding="utf-8"))
    assert [block["type"] for block in content["blocks"]] == ["heading", "table", "code"]
    receipt = json.loads(Path(job["metadata_path"]).read_text(encoding="utf-8"))
    # Receipts stay body-free: they only point at the captured files.
    assert "markdown" not in receipt and "content" not in receipt and "text" not in receipt
    assert receipt["markdown_path"].endswith("intro.md")
    assert receipt["markdown_bytes"] == len(MARKDOWN.encode("utf-8"))
    assert receipt["content_path"].endswith("intro.content.json")
    assert receipt["content_blocks"] == 3
    summary = store.summary(plan.task_id)
    assert summary["jobs"][0]["markdown_path"].endswith("intro.md")


def test_results_without_rich_capture_keep_the_previous_behavior(store, plan):
    store.submit(plan)
    Scheduler(store).tick(plan.task_id)
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result(
        "host",
        NativeResult(
            type="result",
            request_id=command["request_id"],
            status="completed",
            text="only text",
        ),
    )
    job = store.jobs(plan.task_id)["intro"]
    assert job["markdown_path"] is None
    assert not (store.task_dir(plan.task_id) / "responses" / "intro.md").exists()
    assert store.summary(plan.task_id)["jobs"][0]["markdown_path"] is None


def test_empty_markdown_falls_back_to_the_raw_text(store, plan):
    store.submit(plan)
    Scheduler(store).tick(plan.task_id)
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result(
        "host",
        NativeResult(
            type="result",
            request_id=command["request_id"],
            status="completed",
            text="text wins",
            markdown="   \n\t",
        ),
    )
    job = store.jobs(plan.task_id)["intro"]
    assert job["markdown_path"] is None
    assert Path(job["result_path"]).read_text(encoding="utf-8") == "text wins"


def test_open_operation_never_stores_copies(store, plan):
    plan.jobs = [JobPlan(id="view", provider="qwen", prompt="demo", operation="open")]
    plan.editor = None
    store.submit(plan, kind="open")
    Scheduler(store).tick(plan.task_id)
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result("host", rich(command, text="", url="https://chat.qwen.ai/c/1"))
    job = store.jobs(plan.task_id)["view"]
    assert job["result_path"] is None
    assert job["markdown_path"] is None
    assert not list(store.task_dir(plan.task_id).rglob("*.md"))
    assert not list(store.task_dir(plan.task_id).rglob("*.content.json"))


@pytest.mark.parametrize(
    "extension,expected_markdown_files",
    [("txt", ["notes.md", "notes.txt"]), ("md", ["notes.md"])],
)
async def test_ask_publishes_provider_markdown_alongside_output(
    store, plan, extension, expected_markdown_files
):
    destination = Path(plan.output.path).parent / f"notes.{extension}"
    plan.jobs = [JobPlan(id="answer", provider="qwen", prompt="question", timeout=1)]
    plan.editor = None
    plan.output.format = "markdown" if extension == "md" else "txt"
    plan.output.path = str(destination)
    store.submit(plan, kind="ask")
    Scheduler(store).tick(plan.task_id)
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result("host", rich(command))
    summary = await Scheduler(store).run(plan.task_id)
    assert summary["status"] == "completed"
    published = Path(summary["output_markdown_path"])
    assert published.read_text(encoding="utf-8") == MARKDOWN
    assert (
        sorted(path.name for path in destination.parent.iterdir() if path.name != "state")
        == expected_markdown_files
    )
    if extension == "md":
        # --format md publishes the provider Markdown verbatim, not the plain text.
        assert Path(summary["output_path"]) == destination
        assert summary["output_markdown_path"] == summary["output_path"]
    else:
        assert Path(summary["output_path"]).read_text(encoding="utf-8") == "plain answer"


async def test_ask_without_markdown_publishes_no_extra_file(store, plan):
    destination = Path(plan.output.path).parent / "notes.txt"
    plan.jobs = [JobPlan(id="answer", provider="qwen", prompt="question", timeout=1)]
    plan.editor = None
    plan.output.format = "txt"
    plan.output.path = str(destination)
    store.submit(plan, kind="ask")
    Scheduler(store).tick(plan.task_id)
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result(
        "host",
        NativeResult(
            type="result",
            request_id=command["request_id"],
            status="completed",
            text="plain only",
        ),
    )
    summary = await Scheduler(store).run(plan.task_id)
    assert summary["status"] == "completed"
    assert summary["output_markdown_path"] is None
    assert [path.name for path in destination.parent.iterdir() if path.name != "state"] == [
        "notes.txt"
    ]


def test_cli_summary_exposes_markdown_paths_without_bodies(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("MCA_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("MCA_POLL_INTERVAL", "0.01")
    assert main(["ask", "qwen", "--prompt", "Question", "--task-id", "rich"]) == 0
    capsys.readouterr()
    store = Store(Settings.from_env())
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result("host", rich(command))
    assert main(["status", "rich", "--wait"]) == 0
    output = capsys.readouterr().out
    assert MARKDOWN.strip() not in output
    receipt = json.loads(output)
    assert receipt["jobs"][0]["markdown_path"].endswith("answer.md")
    assert receipt["output_markdown_path"].endswith("answer.md")
    assert Path(receipt["output_markdown_path"]).read_text(encoding="utf-8") == MARKDOWN


@pytest.fixture
def clipboard_cli_home(monkeypatch, tmp_path):
    monkeypatch.setenv("MCA_HOME", str(tmp_path))
    monkeypatch.setenv("MCA_POLL_INTERVAL", "0.01")
    # These tests advance the queue directly through Store instead of spawning a worker.
    monkeypatch.setattr("multi_chat_agent.cli._background", lambda *_: None)


def test_clipboard_copy_uses_provider_markdown_verbatim(monkeypatch, capsys, clipboard_cli_home):
    copied: dict[str, str] = {}

    def fake_copy(text: str) -> str:
        copied["text"] = text
        return "fake-clip"

    monkeypatch.setattr("multi_chat_agent.cli.copy_text", fake_copy)
    assert main(["ask", "qwen", "--prompt", "Question", "--task-id", "clip"]) == 0
    capsys.readouterr()
    store = Store(Settings.from_env())
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result("host", rich(command))
    assert main(["status", "clip", "--wait"]) == 0
    capsys.readouterr()
    assert main(["copy", "clip"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["format"] == "markdown"
    assert report["clipboard"] == "fake-clip"
    assert report["source_path"].endswith("answer.md")
    # Exactly the provider bytes: tables, fences and formulas are untouched.
    assert copied["text"] == MARKDOWN
    assert MARKDOWN.strip() not in json.dumps(report)


def test_clipboard_copy_can_fall_back_to_the_plain_text(monkeypatch, capsys, clipboard_cli_home):
    copied: dict[str, str] = {}
    monkeypatch.setattr(
        "multi_chat_agent.cli.copy_text",
        lambda text: (copied.setdefault("text", text), "fake-clip")[1],
    )
    assert main(["ask", "qwen", "--prompt", "Question", "--task-id", "clip-raw"]) == 0
    capsys.readouterr()
    store = Store(Settings.from_env())
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result("host", rich(command))
    assert main(["status", "clip-raw", "--wait"]) == 0
    capsys.readouterr()
    assert main(["copy", "clip-raw", "--raw"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["format"] == "text"
    assert copied["text"] == "plain answer"


def test_clipboard_copy_refuses_unfinished_tasks(capsys, clipboard_cli_home):
    assert main(["ask", "qwen", "--prompt", "Question", "--task-id", "unfinished"]) == 0
    capsys.readouterr()
    assert main(["copy", "unfinished"]) == 2
    report = json.loads(capsys.readouterr().out)
    assert report["error"] == "task_not_completed"


def test_clipboard_copy_reports_missing_open_answer(capsys, clipboard_cli_home):
    assert main(["open", "qwen", "--task-id", "open-copy"]) == 0
    capsys.readouterr()
    store = Store(Settings.from_env())
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result(
        "host",
        NativeResult(
            type="result",
            request_id=command["request_id"],
            status="completed",
            text="",
            conversation_url="https://chat.qwen.ai/c/1",
        ),
    )
    assert main(["status", "open-copy", "--wait"]) == 0
    capsys.readouterr()
    assert main(["copy", "open-copy"]) == 2
    report = json.loads(capsys.readouterr().out)
    assert report["error"] == "no_answer_to_copy"


def test_clipboard_utility_selection_and_structured_failure(monkeypatch):
    from multi_chat_agent import clipboard

    monkeypatch.setattr(clipboard.os, "name", "nt")
    assert clipboard.candidates() == [("clip", [])]
    monkeypatch.setattr(clipboard.shutil, "which", lambda name: None)
    with pytest.raises(ValueError, match="clipboard"):
        clipboard.copy_text("x")


def test_clipboard_pipes_bytes_without_shell_quoting(monkeypatch):
    from multi_chat_agent import clipboard

    seen = {}

    class Completed:
        returncode = 0

    def fake_run(command, **kwargs):
        seen["command"] = command
        seen["input"] = kwargs["input"]
        assert kwargs.get("shell") in (None, False)
        return Completed()

    monkeypatch.setattr(clipboard.os, "name", "posix")
    monkeypatch.setattr(clipboard.sys, "platform", "linux")
    monkeypatch.setattr(clipboard.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(clipboard.subprocess, "run", fake_run)
    text = 'Таблица | `code` | $(rm -rf /)\n```python\nprint("x")\n```\n'
    assert clipboard.copy_text(text) == "wl-copy"
    assert seen["command"] == ["/usr/bin/wl-copy"]
    assert seen["input"] == text.encode("utf-8")


def test_windows_clipboard_sends_unicode_with_bom(monkeypatch):
    from multi_chat_agent import clipboard

    monkeypatch.setattr(clipboard, "candidates", lambda: [("clip", [])])
    monkeypatch.setattr(clipboard.shutil, "which", lambda name: name)

    def fake_run(command, **kwargs):
        assert command == ["clip"]
        assert kwargs["input"].decode("utf-16") == "Кириллица и √"
        return clipboard.subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(clipboard.subprocess, "run", fake_run)
    assert clipboard.copy_text("Кириллица и √") == "clip"
