from __future__ import annotations

import json
from pathlib import Path

from multi_chat_agent.cli import main
from multi_chat_agent.config import Settings
from multi_chat_agent.store import Store


def setup_home(monkeypatch, tmp_path):
    monkeypatch.setenv("MCA_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("MCA_QUEUE_TIMEOUT", "0.04")
    monkeypatch.setenv("MCA_POLL_INTERVAL", "0.01")
    monkeypatch.setattr("multi_chat_agent.cli._background", lambda *args: None)


def test_prompt_file_and_inline_prompt_are_persisted_without_stdout_body(
    monkeypatch,
    tmp_path,
    capsys,
):
    setup_home(monkeypatch, tmp_path)
    prompt = tmp_path / "prompt.txt"
    prompt.write_text("SECRET_PROMPT_FROM_FILE", encoding="utf-8")
    assert main(["ask", "qwen", "--prompt-file", str(prompt), "--task-id", "ask-file"]) == 0
    output = capsys.readouterr().out
    assert "SECRET_PROMPT" not in output
    assert json.loads(output)["status"] == "running"
    assert main(["ask", "deepseek", "--prompt", "SECRET_INLINE", "--task-id", "ask-inline"]) == 0
    assert "SECRET_INLINE" not in capsys.readouterr().out
    with Store(Settings.from_env()).connect() as db:
        prompts = {row[0] for row in db.execute("SELECT prompt FROM commands")}
    assert prompts == {"SECRET_PROMPT_FROM_FILE", "SECRET_INLINE"}


def test_ask_wait_missing_host_nonzero_json_and_no_prompt(monkeypatch, tmp_path, capsys):
    setup_home(monkeypatch, tmp_path)
    assert main(["ask", "qwen", "--prompt", "PRIVATE_PROMPT", "--wait"]) == 1
    output = capsys.readouterr().out
    assert "PRIVATE_PROMPT" not in output
    assert json.loads(output)["status"] == "timeout"


def test_error_and_help_stdout_are_json_without_full_inputs(monkeypatch, tmp_path, capsys):
    setup_home(monkeypatch, tmp_path)
    assert main(["ask", "unknown-provider", "--prompt", "DO_NOT_PRINT"]) == 2
    output = capsys.readouterr().out
    assert "DO_NOT_PRINT" not in output
    assert json.loads(output)["error"] == "invalid_arguments"
    assert main(["ask", "qwen", "--prompt", " "]) == 2
    assert json.loads(capsys.readouterr().out)["error"] == "validation_error"


def test_relative_output_resolves_next_to_plan(monkeypatch, tmp_path, capsys, plan):
    setup_home(monkeypatch, tmp_path)
    directory = tmp_path / "nested"
    directory.mkdir()
    plan.output.path = "result.ipynb"
    file = directory / "plan.json"
    file.write_text(plan.model_dump_json(), encoding="utf-8")
    assert main(["run", str(file)]) == 0
    capsys.readouterr()
    persisted = Store(Settings.from_env()).task(plan.task_id)
    assert json.loads(persisted["plan_json"])["output"]["path"] == str(directory / "result.ipynb")


def test_doctor_checks_local_database_without_claiming_live_success(monkeypatch, tmp_path, capsys):
    setup_home(monkeypatch, tmp_path)
    assert main(["doctor"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["database_check"] == "ok"
    assert result["status"] == "needs_user_action"
    assert result["browser_bridge_ready"] is False
    assert result["next_action"]
    assert result["live_provider_test"] == "not_performed"
    assert Path(result["database_path"]).exists()


def test_doctor_connected_bridge_does_not_claim_provider_success(monkeypatch, tmp_path, capsys):
    setup_home(monkeypatch, tmp_path)
    Store(Settings.from_env()).heartbeat("test-host")
    assert main(["doctor"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["browser_bridge_ready"] is True
    assert result["next_action"] is None
    assert result["live_provider_test"] == "not_performed"


def test_missing_task_is_structured_error(monkeypatch, tmp_path, capsys):
    setup_home(monkeypatch, tmp_path)
    assert main(["status", "missing"]) == 2
    assert json.loads(capsys.readouterr().out)["status"] == "failed"


def test_oversized_prompt_marks_task_failed_even_without_wait(monkeypatch, tmp_path, capsys):
    setup_home(monkeypatch, tmp_path)
    assert main(["ask", "qwen", "--task-id", "oversize", "--prompt", "я" * 500_000]) == 1
    summary = json.loads(capsys.readouterr().out)
    assert summary["status"] == "failed"
    assert summary["error"] == "prompt_too_large"
    assert Store(Settings.from_env()).task("oversize")["status"] == "failed"
