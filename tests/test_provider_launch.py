from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from multi_chat_agent.cli import main
from multi_chat_agent.config import Settings
from multi_chat_agent.models import OPEN_PROMPT, JobPlan, NativeResult
from multi_chat_agent.native_host import NativeHost
from multi_chat_agent.providers import registry_summary, trusted_url
from multi_chat_agent.scheduler import Scheduler
from multi_chat_agent.store import Store


def test_providers_lists_explicit_registry_without_database_or_browser(monkeypatch, capsys):
    def unexpected(*args):
        raise AssertionError("provider listing must not open the queue")

    monkeypatch.setattr("multi_chat_agent.cli.Store", unexpected)
    assert main(["providers"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert {provider["id"] for provider in result["providers"]} == {
        "deepseek",
        "qwen",
        "kimi",
        "perplexity",
    }
    by_id = {provider["id"]: provider for provider in result["providers"]}
    assert set(by_id["deepseek"]["modes"]) == {"think", "search"}
    assert set(by_id["qwen"]["modes"]) == {"think", "search", "reasoning"}
    assert by_id["qwen"]["modes"]["reasoning"]["values"] == ["auto", "thinking", "fast"]
    assert result == registry_summary()


@pytest.mark.parametrize("command", ["ask", "open"])
def test_cli_operations_persist_mode_payload(monkeypatch, tmp_path, capsys, command):
    monkeypatch.setenv("MCA_HOME", str(tmp_path / "state"))
    monkeypatch.setattr("multi_chat_agent.cli._background", lambda *args: None)
    arguments = [
        command,
        "qwen",
        "--task-id",
        "direct",
        "--think",
        "on",
        "--search",
        "off",
        "--mode",
        "model=qwen-plus",
    ]
    if command == "ask":
        arguments += ["--prompt", "PRIVATE_DIRECT_PROMPT"]
    assert main(arguments) == 0
    summary = capsys.readouterr().out
    assert "PRIVATE_DIRECT_PROMPT" not in summary
    store = Store(Settings.from_env())
    store.heartbeat("host")
    wire = store.claim("host")
    assert wire["operation"] == command
    assert wire["modes"] == {"think": True, "search": False, "model": "qwen-plus"}
    assert wire["prompt"] == (OPEN_PROMPT if command == "open" else "PRIVATE_DIRECT_PROMPT")
    assert store.task("direct")["kind"] == command


@pytest.mark.parametrize(
    "extra,error",
    [
        (["--think", "on", "--mode", "think=off"], "conflicting_modes"),
        (["--mode", "missing-equals"], "invalid_mode"),
        (["--mode", "bad key=on"], "validation_error"),
        (["--think", "off", "--mode", "reasoning=auto"], "validation_error"),
        (["--prompt", "DO_NOT_SUBMIT"], "invalid_arguments"),
    ],
)
def test_invalid_open_arguments_create_no_task(monkeypatch, tmp_path, capsys, extra, error):
    monkeypatch.setenv("MCA_HOME", str(tmp_path / "state"))
    assert main(["open", "qwen", *extra]) == 2
    output = capsys.readouterr().out
    assert "DO_NOT_SUBMIT" not in output
    assert json.loads(output)["error"] == error
    with Store(Settings.from_env()).connect() as db:
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0


async def test_open_fake_native_transport_never_submits_demo_or_reads_answer(
    store, plan, monkeypatch
):
    plan.jobs = [
        JobPlan(
            id="launch",
            provider="qwen",
            operation="open",
            prompt="DEMO_PREFIX_USER_TEXT_MUST_NOT_BE_SENT",
            modes={"think": True},
        )
    ]
    plan.editor = None
    store.submit(plan, kind="open")
    sent = []
    submissions = []
    incoming = asyncio.Queue()
    url = "https://chat.qwen.ai/c/test-conversation"

    class FakeBrowserTransport:
        async def send(self, wire):
            sent.append(wire)
            if wire["operation"] == "ask":
                submissions.append(wire["prompt"])
            await incoming.put(
                {
                    "type": "result",
                    "request_id": wire["request_id"],
                    "status": "completed",
                    "conversation_url": url,
                    "text": "PRIVATE_OPEN_BODY_MUST_NOT_BE_READ",
                }
            )

        async def receive(self):
            return await incoming.get()

    def forbidden(*args):
        raise AssertionError("open must not read bodies or assemble an artifact")

    monkeypatch.setattr("multi_chat_agent.scheduler.read_response", forbidden)
    monkeypatch.setattr("multi_chat_agent.scheduler.write_artifact", forbidden)
    stop = False
    host = asyncio.create_task(NativeHost(store, FakeBrowserTransport()).run(stop=lambda: stop))
    try:
        summary = await asyncio.wait_for(Scheduler(store).run(plan.task_id), 2)
    finally:
        stop = True
        await host
    assert summary["status"] == "completed"
    assert summary["conversation_url"] == url
    assert summary["output_path"] is None
    assert not Path(plan.output.path).exists()
    assert len(sent) == 1 and sent[0]["prompt"] == OPEN_PROMPT
    assert "DEMO_PREFIX_USER_TEXT" not in json.dumps(sent)
    assert "PRIVATE_OPEN_BODY" not in json.dumps(summary)
    assert submissions == []
    assert not list(store.task_dir(plan.task_id).rglob("*.txt"))
    assert summary["jobs"][0]["result_path"] is None


@pytest.mark.parametrize(
    "operation,text,url,status,error",
    [
        ("ask", "", "https://chat.qwen.ai/c/1", "failed", "provider_empty_response"),
        ("ask", " \t", "https://chat.qwen.ai/c/1", "failed", "provider_empty_response"),
        ("ask", "normal answer", None, "completed", None),
        ("open", "", "https://chat.qwen.ai/c/1", "completed", None),
        ("open", "", None, "needs_user_action", "provider_invalid_conversation_url"),
        (
            "open",
            "",
            "https://evil.test/",
            "needs_user_action",
            "provider_invalid_conversation_url",
        ),
    ],
)
def test_result_completion_is_operation_aware(store, plan, operation, text, url, status, error):
    plan.jobs = [JobPlan(id="one", provider="qwen", operation=operation, prompt="request")]
    plan.editor = None
    store.submit(plan, kind=operation)
    store.enqueue(plan.task_id, "one", "request")
    store.heartbeat("host")
    wire = store.claim("host")
    assert store.accept_result(
        "host",
        NativeResult(
            type="result",
            request_id=wire["request_id"],
            status="completed",
            text=text,
            conversation_url=url,
        ),
    )
    job = store.jobs(plan.task_id)["one"]
    assert job["status"] == status and job["error"] == error
    metadata = json.loads(Path(job["metadata_path"]).read_text(encoding="utf-8"))
    assert "text" not in metadata
    assert metadata["accepted_status"] == status
    if operation == "open":
        assert job["result_path"] is None
        assert not list(store.task_dir(plan.task_id).rglob("*.txt"))


@pytest.mark.parametrize(
    "url",
    [
        "http://chat.qwen.ai/c/1",
        "https://chat.qwen.ai.evil.test/",
        "javascript:alert(1)",
        "https://user:password@chat.qwen.ai/",
        "https://chat.qwen.ai:444/",
        "https://chat.deepseek.com/",
        "https://chat.qwen.ai/\nnew",
        "https://chat.qwen.ai:not-a-port/",
    ],
)
def test_open_summary_trusts_only_selected_provider_https_urls(url):
    assert trusted_url("qwen", url) is None


def test_editor_and_single_repair_keep_their_modes_in_durable_wire(store, plan):
    plan.editor.modes = {"think": False, "search": True}
    store.submit(plan)
    store.heartbeat("host")
    for repair in (False, True):
        job_id = store.add_editor(plan.task_id, plan, repair=repair)
        store.enqueue(plan.task_id, job_id, "editor prompt")
        wire = Store(store.settings).claim("host")
        assert wire["operation"] == "ask"
        assert wire["modes"] == {"think": False, "search": True}
        assert wire["conversation_key"].endswith(":qwen:editor")


def test_unsupported_control_diagnostic_is_retained_without_sending_prompt(store, plan):
    plan.jobs = [
        JobPlan(
            id="launch",
            provider="qwen",
            prompt="demo",
            operation="open",
            modes={"custom-control": "requested"},
        )
    ]
    plan.editor = None
    store.submit(plan, kind="open")
    Scheduler(store).tick(plan.task_id)
    store.heartbeat("host")
    wire = store.claim("host")
    assert wire["operation"] == "open" and wire["prompt"] == OPEN_PROMPT
    store.accept_result(
        "host",
        NativeResult(
            type="result",
            request_id=wire["request_id"],
            status="needs_user_action",
            error="MODE_UNSUPPORTED: qwen.custom-control: no registered control",
        ),
    )
    Scheduler(store).tick(plan.task_id)
    summary = store.summary(plan.task_id)
    assert summary["status"] == "needs_user_action"
    assert summary["conversation_url"] is None
    assert summary["diagnostic"] == {
        "code": "MODE_UNSUPPORTED",
        "message": "qwen.custom-control: no registered control",
    }
    assert "MODE_UNSUPPORTED: qwen.custom-control: no registered control" in Path(
        summary["jobs"][0]["metadata_path"]
    ).read_text(encoding="utf-8")


@pytest.mark.parametrize("operation,modes", [("open", {}), ("ask", {"think": True})])
def test_pre_upgrade_host_cannot_claim_feature_requests(store, plan, operation, modes):
    plan.jobs = [
        JobPlan(id="one", provider="qwen", prompt="demo", operation=operation, modes=modes)
    ]
    plan.editor = None
    store.submit(plan, kind=operation)
    store.enqueue(plan.task_id, "one", "demo")
    with store.connect() as db:
        # This is the exact command selection used by a still-running v1 host.
        assert db.execute("SELECT * FROM commands WHERE state='pending'").fetchone() is None
    store.heartbeat("v2-host")
    wire = store.claim("v2-host")
    assert wire["operation"] == operation and wire["modes"] == modes
    assert wire["prompt"] == (OPEN_PROMPT if operation == "open" else "demo")


def test_new_plain_ask_preserves_exact_legacy_wire_shape(store, plan):
    store.submit(plan)
    store.enqueue(plan.task_id, "intro", "original ask")
    with store.connect() as db:
        assert db.execute("SELECT state FROM commands").fetchone()[0] == "pending"
    store.heartbeat("host")
    assert set(store.claim("host")) == {
        "type",
        "request_id",
        "provider",
        "prompt",
        "conversation_key",
        "timeout_ms",
    }


def test_public_diagnostic_reads_only_bounded_receipt_metadata(tmp_path):
    from multi_chat_agent.diagnostics import receipt_diagnostic

    receipt = tmp_path / "result.json"
    receipt.write_text(json.dumps({"error": "MODE_VERIFY_FAILED: " + "x" * 800}), encoding="utf-8")
    diagnostic = receipt_diagnostic(str(receipt))
    assert diagnostic["code"] == "MODE_VERIFY_FAILED"
    assert len(diagnostic["message"]) == 320
    receipt.write_text(json.dumps({"error": "PRIVATE_PROVIDER_RESPONSE"}), encoding="utf-8")
    assert receipt_diagnostic(str(receipt)) is None
    receipt.write_text("x" * 20000, encoding="utf-8")
    assert receipt_diagnostic(str(receipt)) is None


@pytest.mark.parametrize(
    "code",
    [
        "NEW_CHAT_NOT_READY",
        "WORKSPACE_MINIMIZED",
        "LOGIN_OR_DOM_REQUIRED",
        "ANSWER_CHANGED",
    ],
)
def test_current_extension_diagnostic_codes_are_returned(tmp_path, code):
    from multi_chat_agent.diagnostics import receipt_diagnostic

    receipt = tmp_path / "result.json"
    receipt.write_text(
        json.dumps({"error": f"{code}: Dedicated tab requires user action"}), encoding="utf-8"
    )
    assert receipt_diagnostic(str(receipt)) == {
        "code": code,
        "message": "Dedicated tab requires user action",
    }


def test_cli_saved_chat_survives_queue_and_rejects_wrong_chat(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("MCA_HOME", str(tmp_path / "state"))
    monkeypatch.setattr("multi_chat_agent.cli._background", lambda *args: None)
    url = "https://chat.deepseek.com/a/chat/s/old-chat"
    assert (
        main(
            [
                "ask",
                "deepseek",
                "--chat-url",
                url + "?from=history",
                "--prompt",
                "Follow up",
                "--task-id",
                "follow-up",
            ]
        )
        == 0
    )
    store = Store(Settings.from_env())
    store.heartbeat("new-host")
    wire = store.claim("new-host")
    assert wire["chat_url"] == url
    assert store.accept_result(
        "new-host",
        NativeResult(
            type="result",
            request_id=wire["request_id"],
            status="completed",
            text="Unexpected reply",
            conversation_url=url + "-different",
        ),
    )
    assert store.command_state(wire["request_id"]) == "unknown"
    assert main(["open", "qwen", "--chat-url", url]) == 2
    assert json.loads(capsys.readouterr().out.splitlines()[-1])["error"] == "validation_error"
