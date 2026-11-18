from __future__ import annotations

import asyncio
import json
from pathlib import Path

import nbformat
import pytest

from multi_chat_agent.models import JobPlan
from multi_chat_agent.native_host import NativeHost
from multi_chat_agent.scheduler import Scheduler
from multi_chat_agent.store import Store


class FakeTransport:
    def __init__(self, respond):
        self.respond = respond
        self.incoming = asyncio.Queue()
        self.sent = []
        self.tasks = []
        self.active = set()
        self.concurrent_providers = False

    async def send(self, message):
        self.sent.append(message)
        assert message["provider"] not in self.active
        self.active.add(message["provider"])
        self.concurrent_providers |= len(self.active) == 2

        async def deliver():
            await asyncio.sleep(0.02)
            response = self.respond(message)
            self.active.remove(message["provider"])
            if response is not None:
                await self.incoming.put(
                    {
                        "type": "result",
                        "request_id": message["request_id"],
                        "status": "completed",
                        "text": response,
                        "conversation_url": "https://example.test/chat/1",
                    }
                )

        self.tasks.append(asyncio.create_task(deliver()))

    async def receive(self):
        return await self.incoming.get()


async def drive(store, task_id, transport):
    stop = False
    host = asyncio.create_task(NativeHost(store, transport).run(stop=lambda: stop))
    try:
        # Windows durable fsyncs can take hundreds of milliseconds under parallel
        # integration runs; the outer bound detects hangs, not disk throughput.
        summary = await asyncio.wait_for(Scheduler(store).run(task_id), timeout=10)
        return summary
    finally:
        stop = True
        await asyncio.wait_for(host, timeout=1)
        await asyncio.gather(*transport.tasks)


async def test_authors_dependencies_editor_notebook_end_to_end(store, plan, tmp_path):
    marker = tmp_path / "must-not-execute"
    code = f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')"

    def respond(message):
        prompt = message["prompt"]
        if ":editor" in message["conversation_key"]:
            assert plan.objective in prompt
            assert (
                "INTRO_BODY" in prompt and "DETAIL_BODY" in prompt and "CONCLUSION_BODY" in prompt
            )
            assert '"cells"' in prompt
            return (
                "```json\n"
                + json.dumps(
                    {
                        "cells": [
                            {"cell_type": "markdown", "source": "# Final lesson"},
                            {"cell_type": "code", "source": code},
                        ]
                    }
                )
                + "\n```"
            )
        if prompt.startswith("Write introduction"):
            return "INTRO_BODY"
        if prompt.startswith("Write details"):
            return "DETAIL_BODY"
        assert "INTRO_BODY" in prompt and "DETAIL_BODY" in prompt
        return "CONCLUSION_BODY"

    store.submit(plan)
    transport = FakeTransport(respond)
    summary = await drive(store, plan.task_id, transport)
    assert summary["status"] == "completed"
    assert len(transport.sent) == 4
    assert transport.concurrent_providers
    assert transport.sent[0]["conversation_key"] == transport.sent[2]["conversation_key"]
    assert transport.sent[-1]["conversation_key"].endswith(":qwen:editor")
    notebook = nbformat.read(summary["output_path"], as_version=4)
    nbformat.validate(notebook)
    assert notebook.cells[1].source == code
    assert notebook.cells[1].execution_count is None and notebook.cells[1].outputs == []
    assert not marker.exists()


@pytest.mark.parametrize("repair_succeeds", [True, False])
async def test_editor_format_repaired_at_most_once_and_raw_preserved(store, plan, repair_succeeds):
    calls = 0

    def respond(message):
        nonlocal calls
        if message["conversation_key"].endswith(":editor"):
            calls += 1
            if calls == 2 and repair_succeeds:
                assert "only formatting repair" in message["prompt"]
                return '{"cells":[{"cell_type":"markdown","source":"fixed"}]}'
            return "malformed payload"
        return "author text"

    store.submit(plan)
    transport = FakeTransport(respond)
    summary = await drive(store, plan.task_id, transport)
    assert calls == 2
    assert summary["status"] == ("completed" if repair_succeeds else "failed")
    assert (
        Path(store.jobs(plan.task_id)["_editor"]["result_path"]).read_text() == "malformed payload"
    )
    assert Path(plan.output.path).exists() == repair_succeeds


async def test_missing_host_has_bounded_timeout_and_restart_does_not_requeue(store, plan):
    store.submit(plan)
    summary = await asyncio.wait_for(Scheduler(store).run(plan.task_id), 2)
    assert summary["status"] == "timeout"
    assert not Path(plan.output.path).exists()
    summary = await Scheduler(Store(store.settings)).run(plan.task_id)
    assert summary["status"] == "timeout"
    assert store.claim("reconnected") is None


async def test_sent_request_timeout_is_unknown_and_blocks_downstream(store, plan):
    plan.jobs = [
        JobPlan(id="one", provider="qwen", prompt="no response", timeout=0.03),
        JobPlan(id="two", provider="qwen", prompt="dependent", depends_on=["one"]),
    ]
    store.submit(plan)
    transport = FakeTransport(lambda message: None)
    summary = await drive(store, plan.task_id, transport)
    assert summary["status"] == "unknown"
    assert len(transport.sent) == 1
    assert store.jobs(plan.task_id)["two"]["status"] == "failed"


async def test_restart_resumes_only_unsent_jobs(store, plan):
    store.submit(plan)
    scheduler = Scheduler(store)
    scheduler.tick(plan.task_id)
    store.heartbeat("original-host")
    intro = store.claim("original-host")
    from multi_chat_agent.models import NativeResult

    store.accept_result(
        "original-host",
        NativeResult(
            type="result",
            request_id=intro["request_id"],
            status="completed",
            text="saved intro",
        ),
    )
    store.close_host("original-host")
    reopened = Store(store.settings)
    transport = FakeTransport(
        lambda message: (
            '{"cells":[{"cell_type":"markdown","source":"resumed"}]}'
            if message["conversation_key"].endswith(":editor")
            else "other body"
        )
    )
    summary = await drive(reopened, plan.task_id, transport)
    assert summary["status"] == "completed"
    assert all(message["request_id"] != intro["request_id"] for message in transport.sent)
    assert len(transport.sent) == 3


async def test_no_editor_retains_prose_as_markdown_cells(store, plan):
    plan.editor = None
    store.submit(plan)
    summary = await drive(store, plan.task_id, FakeTransport(lambda message: "raw prose"))
    assert summary["status"] == "completed"
    nb = nbformat.read(summary["output_path"], as_version=4)
    assert len(nb.cells) == 3
    assert all(cell.cell_type == "markdown" for cell in nb.cells)


@pytest.mark.parametrize("status", ["failed", "timeout", "needs_user_action", "unknown"])
async def test_provider_failure_preserves_partial_and_prevents_downstream(store, plan, status):
    from multi_chat_agent.models import NativeResult

    store.submit(plan)
    Scheduler(store).tick(plan.task_id)
    store.heartbeat("host")
    command = store.claim("host")
    store.accept_result(
        "host",
        NativeResult(
            type="result",
            request_id=command["request_id"],
            status=status,
            text="PARTIAL_PRIVATE_RESPONSE",
            error="PRIVATE_PROVIDER_DIAGNOSTIC",
        ),
    )
    store.close_host("host")
    summary = await Scheduler(store).run(plan.task_id)
    assert summary["status"] == status
    assert len(store.jobs(plan.task_id)) == 3
    assert store.claim("new") is None
    assert "PRIVATE_PROVIDER_DIAGNOSTIC" not in json.dumps(summary)
    job = summary["jobs"][0]
    assert Path(job["result_path"]).read_text() == "PARTIAL_PRIVATE_RESPONSE"
    assert "PRIVATE_PROVIDER_DIAGNOSTIC" in Path(job["metadata_path"]).read_text()
