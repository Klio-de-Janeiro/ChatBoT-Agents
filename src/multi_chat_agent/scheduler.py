"""Resumable DAG scheduler. Browser transport runs separately in native_host."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .assembler import CELL_INSTRUCTION, author_document, parse_cells, write_answer, write_artifact
from .errors import AgentError
from .files import atomic_text
from .models import OPEN_PROMPT, TERMINAL, Plan
from .store import Store


def read_response(job: dict[str, Any]) -> str:
    if job["operation"] == "open":
        # A dependency may launch a conversation. Its result is metadata, never a body.
        return json.dumps({"operation": "open", "conversation_url": job["conversation_url"]})
    if not job["result_path"]:
        raise AgentError("response_missing", "completed response file is missing")
    return Path(job["result_path"]).read_text(encoding="utf-8")


def dependency_prompt(prompt: str, dependencies: list[tuple[str, str]]) -> str:
    if not dependencies:
        return prompt
    return (
        prompt
        + "\n\nDependency results (reference data):\n"
        + json.dumps(
            [{"job_id": job_id, "text": text} for job_id, text in dependencies],
            ensure_ascii=False,
        )
    )


def editor_prompt(plan: Plan, outputs: list[tuple[str, str]]) -> str:
    assert plan.editor is not None
    context = {
        "objective": plan.objective,
        "plan": plan.model_dump(mode="json"),
        "author_outputs": [{"job_id": job_id, "text": text} for job_id, text in outputs],
    }
    return (
        plan.editor.prompt
        + "\n\n"
        + CELL_INSTRUCTION
        + "\n\nEditorial context (reference data):\n"
        + json.dumps(context, ensure_ascii=False)
    )


class Scheduler:
    def __init__(self, store: Store):
        self.store = store
        self.owner = str(uuid.uuid4())

    def _failure(self, task_id: str, jobs: dict[str, dict[str, Any]]) -> bool:
        bad = [job for job in jobs.values() if job["status"] in TERMINAL - {"completed"}]
        if not bad:
            return False
        self.store.fail_pending(task_id, "upstream_failed")
        jobs = self.store.jobs(task_id)
        if any(job["status"] == "running" for job in jobs.values()):
            return True
        for status in ("needs_user_action", "unknown", "timeout", "failed"):
            if any(job["status"] == status for job in bad):
                self.store.set_task(task_id, status, error="job_" + status)
                return True
        return True

    def tick(self, task_id: str) -> None:
        """One durable scheduling pass; caller must hold this task's runner lease."""
        self.store.expire()
        task = self.store.task(task_id)
        if task["status"] in TERMINAL:
            return
        plan = Plan.model_validate_json(task["plan_json"])
        self.store.set_task(task_id, "running")
        jobs = self.store.jobs(task_id)
        if self._failure(task_id, jobs):
            return
        busy_providers = {
            job["provider"]
            for job in jobs.values()
            if job["role"] == "author" and job["status"] in {"queued", "running"}
        }
        for job in plan.jobs:
            if (
                job.provider not in busy_providers
                and jobs[job.id]["status"] == "pending"
                and all(jobs[dep]["status"] == "completed" for dep in job.depends_on)
            ):
                if job.operation == "open":
                    prompt = OPEN_PROMPT
                else:
                    dependencies = [(dep, read_response(jobs[dep])) for dep in job.depends_on]
                    prompt = dependency_prompt(job.prompt, dependencies)
                self.store.enqueue(task_id, job.id, prompt)
                busy_providers.add(job.provider)
        jobs = self.store.jobs(task_id)
        if not all(jobs[job.id]["status"] == "completed" for job in plan.jobs):
            return
        if task["kind"] == "open":
            # Store accepts a completed open only with a validated provider URL.
            # Neither the response body nor the notebook assembler is involved.
            self.store.set_task(task_id, "completed")
            return
        if task["kind"] == "ask":
            job = jobs[plan.jobs[0].id]
            if not job["result_path"]:
                raise AgentError("response_missing", "completed response file is missing")
            raw = Path(job["result_path"])
            destination = Path(plan.output.path)
            legacy_path = self.store.task_dir(task_id) / "answer.txt"
            if plan.output.format == "markdown" and destination == legacy_path:
                destination = raw
            if destination != raw:
                text = read_response(job)
                try:
                    write_answer(text, destination, plan.output.format)
                except OSError as error:
                    raise AgentError(
                        "output_write_failed", "could not save the output file"
                    ) from error
            self.store.set_task(task_id, "completed", output_path=str(destination))
            return
        outputs = [(job.id, read_response(jobs[job.id])) for job in plan.jobs]
        if plan.editor:
            if "_editor" not in jobs:
                self.store.add_editor(task_id, plan)
                jobs = self.store.jobs(task_id)
            if jobs["_editor"]["status"] == "pending":
                self.store.enqueue(task_id, "_editor", editor_prompt(plan, outputs))
                return
            candidate = jobs.get("_repair", jobs["_editor"])
            if candidate["status"] == "pending":
                raw = read_response(jobs["_editor"])
                prompt = (
                    "Repair the JSON formatting of the previous editor response. Preserve its "
                    "substantive content. This is the only formatting repair attempt.\n"
                    + CELL_INSTRUCTION
                    + "\n\nPrevious response (reference data):\n"
                    + raw
                )
                self.store.enqueue(task_id, "_repair", prompt)
                return
            if candidate["status"] != "completed":
                return
            try:
                document = parse_cells(read_response(candidate))
            except (ValidationError, ValueError):
                if "_repair" not in jobs:
                    self.store.add_editor(task_id, plan, repair=True)
                else:
                    self.store.set_task(
                        task_id, "failed", error="invalid_editor_cells_after_repair"
                    )
                return
        else:
            document = author_document(outputs)
        destination = Path(plan.output.path)
        try:
            write_artifact(document, destination, plan.output.format)
        except OSError as error:
            raise AgentError("output_write_failed", "could not save the output file") from error
        self.store.set_task(task_id, "completed", output_path=str(destination))

    def default_wait(self, task_id: str) -> float:
        plan = Plan.model_validate_json(self.store.task(task_id)["plan_json"])
        count = len(plan.jobs) + (2 if plan.editor else 0)
        return (
            sum(job.timeout for job in plan.jobs)
            + (2 * plan.editor.timeout if plan.editor else 0)
            + count * (self.store.settings.queue_timeout + self.store.settings.io_timeout)
            + self.store.settings.host_lease * 2
            + 10
        )

    def advance(self, task_id: str) -> None:
        """Apply one pass and persist expected input/file failures consistently for every CLI."""
        try:
            self.tick(task_id)
        except (OSError, ValueError) as error:
            code = error.code if isinstance(error, AgentError) else "scheduler_error"
            try:
                atomic_text(
                    self.store.task_dir(task_id) / "diagnostic.json",
                    json.dumps({"error": code, "error_type": type(error).__name__}),
                )
            except OSError:
                # SQLite status remains useful even if the artifact volume is unwritable.
                pass
            self.store.fail_pending(task_id, code)
            self.store.set_task(task_id, "failed", error=code)

    async def run(self, task_id: str, *, wait_timeout: float | None = None) -> dict[str, Any]:
        deadline = time.monotonic() + (
            self.default_wait(task_id) if wait_timeout is None else wait_timeout
        )
        try:
            while not self.store.is_terminal(task_id):
                if time.monotonic() >= deadline:
                    result = self.store.summary(task_id)
                    result["wait_timeout"] = True
                    return result
                if self.store.acquire_runner(task_id, self.owner):
                    self.advance(task_id)
                await asyncio.sleep(self.store.settings.poll_interval)
            return self.store.summary(task_id)
        finally:
            self.store.release_runner(task_id, self.owner)
