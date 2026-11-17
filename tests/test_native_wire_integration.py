"""Black-box checks through real CLI and Native Messaging subprocesses.

The simulated extension speaks the documented wire protocol. This verifies the
local process boundary; it deliberately makes no claim about live provider DOMs.
"""

from __future__ import annotations

import json
import os
import queue
import struct
import subprocess
import sys
import threading
from pathlib import Path

import nbformat


class NativePeer:
    def __init__(self, environment: dict[str, str]):
        self.process = subprocess.Popen(
            [sys.executable, "-u", "-m", "multi_chat_agent", "native-host"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        self.messages: queue.Queue[dict | Exception] = queue.Queue()
        threading.Thread(target=self._read_frames, daemon=True).start()

    def _read_frames(self) -> None:
        try:
            assert self.process.stdout is not None
            while prefix := self.process.stdout.read(4):
                if len(prefix) != 4:
                    raise ValueError("truncated native header")
                length = struct.unpack("<I", prefix)[0]
                body = self.process.stdout.read(length)
                if len(body) != length:
                    raise ValueError("truncated native body")
                self.messages.put(json.loads(body))
            self.messages.put(EOFError("native host exited"))
        except Exception as error:
            self.messages.put(error)

    def receive(self) -> dict:
        message = self.messages.get(timeout=15)
        if isinstance(message, Exception):
            raise message
        return message

    def reply(self, job: dict, text: str) -> None:
        message = {
            "type": "result",
            "request_id": job["request_id"],
            "status": "completed",
            "text": text,
            "conversation_url": "https://chat.deepseek.com/a/chat/test",
        }
        body = json.dumps(message, ensure_ascii=False).encode("utf-8")
        assert self.process.stdin is not None
        self.process.stdin.write(struct.pack("<I", len(body)) + body)
        self.process.stdin.flush()

    def close(self) -> None:
        self.process.kill()
        self.process.communicate(timeout=5)


def environment_for(path: Path) -> dict[str, str]:
    return {
        **os.environ,
        "MCA_HOME": str(path / "state"),
        "MCA_QUEUE_TIMEOUT": "10",
        "PYTHONIOENCODING": "utf-8",
    }


def test_cli_authors_editor_notebook_over_native_wire(tmp_path: Path) -> None:
    output = tmp_path / "result.ipynb"
    plan = {
        "task_id": "wire-notebook",
        "objective": "Объяснить пример без чтения ответов Codex",
        "jobs": [
            {"id": "theory.part", "provider": "deepseek", "prompt": "Напиши теорию"},
            {"id": "practice.part", "provider": "qwen", "prompt": "Напиши пример"},
        ],
        "editor": {"provider": "qwen", "prompt": "Согласуй разделы и исправь ошибки"},
        "output": {"format": "ipynb", "path": str(output)},
    }
    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
    environment = environment_for(tmp_path)
    peer = NativePeer(environment)
    runner = subprocess.Popen(
        [sys.executable, "-m", "multi_chat_agent", "run", str(plan_path), "--wait"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    raw_markers = ["AUTHOR_SECRET_теория", "AUTHOR_SECRET_пример"]
    try:
        authors = [peer.receive(), peer.receive()]
        assert {job["provider"] for job in authors} == {"deepseek", "qwen"}
        assert all(job["type"] == "job" for job in authors)
        for job, text in zip(authors, raw_markers, strict=True):
            peer.reply(job, text)
        editor = peer.receive()
        assert all(marker in editor["prompt"] for marker in raw_markers)
        assert editor["request_id"] not in {job["request_id"] for job in authors}
        peer.reply(
            editor,
            json.dumps(
                {
                    "cells": [
                        {"cell_type": "markdown", "source": "# EDITOR_SECRET_Учебный материал"},
                        {"cell_type": "code", "source": "raise RuntimeError('must not execute')"},
                    ]
                },
                ensure_ascii=False,
            ),
        )
        stdout, stderr = runner.communicate(timeout=15)
        assert runner.returncode == 0, stderr.decode("utf-8", errors="replace")
        summary_text = stdout.decode("utf-8")
        assert "completed" in summary_text
        assert all(marker not in summary_text for marker in [*raw_markers, "EDITOR_SECRET"])
        notebook = nbformat.read(output, as_version=4)
        nbformat.validate(notebook)
        assert len(notebook.cells) == 2
        assert notebook.cells[1].execution_count is None
        assert notebook.cells[1].outputs == []
    finally:
        if runner.poll() is None:
            runner.kill()
            runner.communicate(timeout=5)
        peer.close()


def test_direct_ask_returns_file_without_answer_body(tmp_path: Path) -> None:
    environment = environment_for(tmp_path)
    peer = NativePeer(environment)
    runner = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "multi_chat_agent",
            "ask",
            "deepseek",
            "--prompt",
            "Кратко объясни softmax",
            "--wait",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    try:
        job = peer.receive()
        assert "softmax" in job["prompt"]
        peer.reply(job, "RAW_ANSWER_SECRET_ответ")
        stdout, stderr = runner.communicate(timeout=15)
        assert runner.returncode == 0, stderr.decode("utf-8", errors="replace")
        assert "RAW_ANSWER_SECRET" not in stdout.decode("utf-8")
        assert "completed" in stdout.decode("utf-8")
        assert any(
            "RAW_ANSWER_SECRET" in p.read_text(encoding="utf-8")
            for p in (tmp_path / "state").rglob("*.txt")
        )
    finally:
        if runner.poll() is None:
            runner.kill()
            runner.communicate(timeout=5)
        peer.close()
