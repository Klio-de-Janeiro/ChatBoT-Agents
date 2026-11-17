"""The no-wait path must actually progress after its launching CLI exits."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import pytest

from multi_chat_agent.config import Settings
from multi_chat_agent.store import Store


@pytest.mark.parametrize(
    "wait_args,exit_code", [([], 0), (["--wait", "--wait-timeout", "0.01"], 3)]
)
def test_detached_worker_finishes_without_native_host(tmp_path, wait_args, exit_code):
    home = tmp_path / "detached-state"
    environment = {
        **os.environ,
        "MCA_HOME": str(home),
        "MCA_QUEUE_TIMEOUT": "1",
        "MCA_POLL_INTERVAL": "0.01",
    }
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "multi_chat_agent",
            "ask",
            "qwen",
            "--task-id",
            "background",
            "--prompt",
            "SECRET_BACKGROUND_PROMPT",
            *wait_args,
        ],
        capture_output=True,
        env=environment,
        timeout=10,
        check=False,
    )
    assert completed.returncode == exit_code, completed.stderr
    assert "SECRET_BACKGROUND_PROMPT" not in completed.stdout.decode("utf-8")
    # A very short CLI deadline may expire before the first scheduling pass.
    assert json.loads(completed.stdout)["status"] in {"pending", "running"}
    store = Store(Settings(home=home))
    deadline = time.monotonic() + 10
    while (
        store.task("background")["status"] in {"pending", "running"} and time.monotonic() < deadline
    ):
        time.sleep(0.05)
    assert store.task("background")["status"] == "timeout"
    assert store.jobs("background")["answer"]["error"] == "native_host_unavailable"
