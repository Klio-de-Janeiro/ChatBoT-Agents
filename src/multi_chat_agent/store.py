"""Transactional task/command journal. A command is claimable only before its first send.

The send claim is committed BEFORE writing to Chrome. A crash in that gap sacrifices
liveness (unknown) rather than risking a duplicate prompt. Terminal commands never
return to pending, including on a host reconnect or late/duplicate result.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .config import Settings
from .diagnostics import receipt_diagnostic
from .errors import AgentError
from .files import atomic_text
from .models import OPEN_PROMPT, TERMINAL, NativeResult, Plan, TaskKind
from .providers import saved_chat_url, trusted_url

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY, plan_json TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', output_path TEXT, error TEXT,
    created REAL NOT NULL, updated REAL NOT NULL,
    runner TEXT, runner_heartbeat REAL
);
CREATE TABLE IF NOT EXISTS jobs (
    task_id TEXT NOT NULL REFERENCES tasks(task_id), job_id TEXT NOT NULL,
    role TEXT NOT NULL, provider TEXT NOT NULL, timeout REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', request_id TEXT UNIQUE,
    result_path TEXT, error TEXT, PRIMARY KEY(task_id,job_id)
);
CREATE TABLE IF NOT EXISTS hosts (
    owner TEXT PRIMARY KEY, heartbeat REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS commands (
    request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, job_id TEXT NOT NULL,
    provider TEXT NOT NULL, prompt TEXT NOT NULL, conversation_key TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    created REAL NOT NULL, owner TEXT, sent_at REAL, deadline REAL,
    send_count INTEGER NOT NULL DEFAULT 0 CHECK(send_count <= 1),
    result_path TEXT, metadata_path TEXT, error TEXT,
    FOREIGN KEY(task_id,job_id) REFERENCES jobs(task_id,job_id),
    UNIQUE(task_id,job_id)
);
CREATE INDEX IF NOT EXISTS commands_pending ON commands(state,created);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_casefold ON tasks(task_id COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_casefold ON jobs(task_id,job_id COLLATE NOCASE);
"""

# Additive migration: completed/uncertain commands and their send_count remain intact.
V2_COLUMNS = {
    "jobs": {
        "operation": "TEXT NOT NULL DEFAULT 'ask'",
        "modes_json": "TEXT NOT NULL DEFAULT '{}'",
    },
    "commands": {
        "operation": "TEXT NOT NULL DEFAULT 'ask'",
        "modes_json": "TEXT NOT NULL DEFAULT '{}'",
        "conversation_url": "TEXT",
    },
}


V3_COLUMNS = {"jobs": {"chat_url": "TEXT"}, "commands": {"chat_url": "TEXT"}}

# Additive migration: provider-native Markdown copies next to raw .txt bodies.
# `commands.markdown_path` points at responses/<job>.md, while
# `tasks.output_markdown_path` points at the published Markdown answer.
V4_COLUMNS = {
    "commands": {"markdown_path": "TEXT"},
    "tasks": {"output_markdown_path": "TEXT"},
}


def _wire_payload(payload: dict[str, Any]) -> dict[str, Any]:
    # The v1 extension rejects unknown fields. Preserve its exact request shape for
    # ordinary asks, while keeping operation/modes durable in the v2 journal.
    wire = payload.copy()
    if not wire["chat_url"]:
        del wire["chat_url"]
    if wire["operation"] == "ask" and not wire["modes"]:
        del wire["operation"]
        del wire["modes"]
    return wire


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.home.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            # SQLite versions shipped with Python 3.11 may return BUSY immediately
            # during concurrent WAL transitions, ignoring the normal busy timeout.
            # Retrying this initialization is safe: no command has been claimed.
            wal_deadline = time.monotonic() + 5
            while True:
                try:
                    db.execute("PRAGMA journal_mode=WAL")
                    break
                except sqlite3.OperationalError as error:
                    code = getattr(error, "sqlite_errorcode", 0) & 255
                    if code not in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED} or (
                        time.monotonic() >= wal_deadline
                    ):
                        raise
                    time.sleep(0.02)
            # executescript commits implicitly; execute static DDL statements separately
            # so both bootstrap and migration are atomic across concurrent host startups.
            db.execute("BEGIN IMMEDIATE")
            try:
                version = db.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1, 2, 3, 4):
                    raise AgentError("unsupported_schema", "unsupported database schema version")
                for statement in SCHEMA.split(";"):
                    if statement.strip():
                        db.execute(statement)
                for target, changes in ((2, V2_COLUMNS), (3, V3_COLUMNS), (4, V4_COLUMNS)):
                    if version >= target:
                        continue
                    for table, columns in changes.items():
                        existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
                        for name, definition in columns.items():
                            if name not in existing:
                                db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
                    db.execute(f"PRAGMA user_version={target}")
                db.commit()
            except BaseException:
                db.rollback()
                raise

    @contextmanager
    def connect(self, *, transaction: bool = False) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.settings.database, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        try:
            if transaction:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if transaction:
                db.commit()
        except BaseException:
            if transaction:
                db.rollback()
            raise
        finally:
            db.close()

    def task_dir(self, task_id: str) -> Path:
        return self.settings.home / "tasks" / task_id

    def submit(self, plan: Plan, *, kind: TaskKind = "plan") -> bool:
        if kind in {"ask", "open"} and (
            len(plan.jobs) != 1 or plan.editor is not None or plan.jobs[0].operation != kind
        ):
            raise AgentError("invalid_direct_task", "direct tasks require one matching operation")
        serialized = plan.model_dump_json()
        now = time.time()
        with self.connect(transaction=True) as db:
            previous = db.execute(
                "SELECT plan_json,kind FROM tasks WHERE task_id=? COLLATE NOCASE", (plan.task_id,)
            ).fetchone()
            if previous:
                # Older plans omit defaults added in v2. Compare validated meaning,
                # not their JSON spelling, to preserve idempotent resume after upgrade.
                if (
                    Plan.model_validate_json(previous["plan_json"]) != plan
                    or previous["kind"] != kind
                ):
                    raise AgentError(
                        "task_conflict", "task_id already exists with a different plan"
                    )
                return False
            db.execute(
                "INSERT INTO tasks(task_id,plan_json,kind,created,updated) VALUES(?,?,?,?,?)",
                (plan.task_id, serialized, kind, now, now),
            )
            for job in plan.jobs:
                db.execute(
                    "INSERT INTO jobs(task_id,job_id,role,provider,timeout,"
                    "operation,modes_json,chat_url) VALUES(?,?,?,?,?,?,?,?)",
                    (
                        plan.task_id,
                        job.id,
                        "author",
                        job.provider,
                        job.timeout,
                        job.operation,
                        json.dumps(job.modes, ensure_ascii=False),
                        job.chat_url,
                    ),
                )
        atomic_text(self.task_dir(plan.task_id) / "plan.json", serialized)
        return True

    def task(self, task_id: str) -> dict[str, Any]:
        with self.connect() as db:
            row = db.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        if row is None:
            raise AgentError("task_not_found", "task not found")
        return dict(row)

    def jobs(self, task_id: str) -> dict[str, dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT j.*,c.metadata_path,c.conversation_url,c.markdown_path FROM jobs j "
                "LEFT JOIN commands c ON j.request_id=c.request_id "
                "WHERE j.task_id=? ORDER BY j.rowid",
                (task_id,),
            )
            jobs = {}
            for row in rows:
                job = dict(row)
                job["modes"] = json.loads(job.pop("modes_json"))
                jobs[row["job_id"]] = job
            return jobs

    def summary(self, task_id: str) -> dict[str, Any]:
        task = self.task(task_id)
        jobs = self.jobs(task_id)
        job_summaries = []
        for job in jobs.values():
            item = {
                key: job[key]
                for key in (
                    "job_id",
                    "role",
                    "provider",
                    "operation",
                    "modes",
                    "status",
                    "request_id",
                    "result_path",
                    "markdown_path",
                    "metadata_path",
                    "conversation_url",
                    "error",
                )
            }
            item["diagnostic"] = receipt_diagnostic(job["metadata_path"])
            job_summaries.append(item)
        summary = {
            "task_id": task_id,
            "status": task["status"],
            "error": task["error"],
            "output_path": task["output_path"],
            # Published provider-native Markdown copy (answers only, None until done).
            "output_markdown_path": task["output_markdown_path"],
            "task_dir": str(self.task_dir(task_id)),
            "jobs": job_summaries,
            "diagnostic": next(
                (
                    job["diagnostic"]
                    for job in job_summaries
                    if job["status"] != "completed" and job["diagnostic"]
                ),
                None,
            ),
        }
        if task["kind"] == "open":
            summary["conversation_url"] = next(iter(jobs.values()))["conversation_url"]
        return summary

    def acquire_runner(self, task_id: str, owner: str) -> bool:
        now = time.time()
        with self.connect(transaction=True) as db:
            cursor = db.execute(
                "UPDATE tasks SET runner=?,runner_heartbeat=? WHERE task_id=? "
                "AND (runner IS NULL OR runner=? OR runner_heartbeat<?)",
                (owner, now, task_id, owner, now - self.settings.host_lease),
            )
            return cursor.rowcount == 1

    def release_runner(self, task_id: str, owner: str) -> None:
        with self.connect(transaction=True) as db:
            db.execute(
                "UPDATE tasks SET runner=NULL,runner_heartbeat=NULL WHERE task_id=? AND runner=?",
                (task_id, owner),
            )

    def set_task(
        self,
        task_id: str,
        status: str,
        *,
        error: str | None = None,
        output_path: str | None = None,
        markdown_path: str | None = None,
    ) -> None:
        with self.connect(transaction=True) as db:
            db.execute(
                "UPDATE tasks SET status=?,error=?,output_path=?,updated=?,"
                "output_markdown_path=COALESCE(?,output_markdown_path) WHERE task_id=?",
                (status, error, output_path, time.time(), markdown_path, task_id),
            )

    def add_editor(self, task_id: str, plan: Plan, *, repair: bool = False) -> str:
        assert plan.editor is not None
        job_id = "_repair" if repair else "_editor"
        with self.connect(transaction=True) as db:
            db.execute(
                "INSERT OR IGNORE INTO jobs(task_id,job_id,role,provider,timeout,"
                "modes_json,chat_url) VALUES(?,?,?,?,?,?,?)",
                (
                    task_id,
                    job_id,
                    "repair" if repair else "editor",
                    plan.editor.provider,
                    plan.editor.timeout,
                    json.dumps(plan.editor.modes, ensure_ascii=False),
                    plan.editor.chat_url,
                ),
            )
        return job_id

    def enqueue(self, task_id: str, job_id: str, prompt: str) -> str | None:
        with self.connect(transaction=True) as db:
            job = db.execute(
                "SELECT * FROM jobs WHERE task_id=? AND job_id=?", (task_id, job_id)
            ).fetchone()
            if job is None or job["status"] != "pending":
                return None
            # Even a plan containing demo/user text must not send that text for open.
            prompt = OPEN_PROMPT if job["operation"] == "open" else prompt
            if len(prompt.encode("utf-8")) > self.settings.max_prompt_bytes:
                raise AgentError("prompt_too_large", "prompt exceeds configured size limit")
            request_id = str(uuid.uuid4())
            role = "editor" if job["role"] == "repair" else job["role"]
            conversation_key = f"{task_id}:{job['provider']}:{role}"
            timeout_ms = max(1, int(job["timeout"] * 1000))
            wire = {
                "type": "job",
                "request_id": request_id,
                "provider": job["provider"],
                "prompt": prompt,
                "conversation_key": conversation_key,
                "timeout_ms": timeout_ms,
                "operation": job["operation"],
                "modes": json.loads(job["modes_json"]),
                "chat_url": job["chat_url"],
            }
            pending_state = "pending"
            if wire["chat_url"]:
                pending_state = "pending_v3"
            elif wire["operation"] != "ask" or wire["modes"]:
                pending_state = "pending_v2"
            if len(json.dumps(_wire_payload(wire), ensure_ascii=False).encode("utf-8")) > (
                self.settings.max_outbound_bytes
            ):
                raise AgentError(
                    "native_message_too_large", "serialized job exceeds Chrome native message limit"
                )
            db.execute(
                "INSERT INTO commands(request_id,task_id,job_id,provider,prompt,conversation_key,"
                "timeout_ms,created,operation,modes_json,state,chat_url) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    request_id,
                    task_id,
                    job_id,
                    job["provider"],
                    prompt,
                    conversation_key,
                    timeout_ms,
                    time.time(),
                    job["operation"],
                    job["modes_json"],
                    # A pre-upgrade native-host still running in memory only claims
                    # state='pending'. Never let it mistake an open sentinel for an ask.
                    pending_state,
                    job["chat_url"],
                ),
            )
            db.execute(
                "UPDATE jobs SET status='queued',request_id=? WHERE task_id=? AND job_id=?",
                (request_id, task_id, job_id),
            )
            return request_id

    def heartbeat(self, owner: str) -> None:
        with self.connect(transaction=True) as db:
            db.execute(
                "INSERT INTO hosts(owner,heartbeat) VALUES(?,?) "
                "ON CONFLICT(owner) DO UPDATE SET heartbeat=excluded.heartbeat",
                (owner, time.time()),
            )

    def claim(self, owner: str) -> dict[str, Any] | None:
        """Persist the irreversible send claim before the transport sees this request."""
        now = time.time()
        with self.connect(transaction=True) as db:
            row = db.execute(
                "SELECT * FROM commands WHERE state IN ('pending','pending_v2','pending_v3') "
                "ORDER BY created LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE commands SET state='sent',owner=?,sent_at=?,deadline=?,send_count=1 "
                "WHERE request_id=? AND state IN ('pending','pending_v2','pending_v3')",
                (
                    owner,
                    now,
                    now + row["timeout_ms"] / 1000 + self.settings.io_timeout,
                    row["request_id"],
                ),
            )
            db.execute("UPDATE jobs SET status='running' WHERE request_id=?", (row["request_id"],))
            return _wire_payload(
                {
                    "type": "job",
                    "request_id": row["request_id"],
                    "provider": row["provider"],
                    "prompt": row["prompt"],
                    "conversation_key": row["conversation_key"],
                    "timeout_ms": row["timeout_ms"],
                    "operation": row["operation"],
                    "modes": json.loads(row["modes_json"]),
                    "chat_url": row["chat_url"],
                }
            )

    @staticmethod
    def _finish(
        db: sqlite3.Connection,
        request_id: str,
        status: str,
        error: str | None,
        result_path: str | None = None,
        metadata_path: str | None = None,
    ) -> None:
        db.execute(
            "UPDATE commands SET state=?,error=?,result_path=?,metadata_path=? WHERE request_id=?",
            (status, error, result_path, metadata_path, request_id),
        )
        db.execute(
            "UPDATE jobs SET status=?,error=?,result_path=? WHERE request_id=?",
            (status, error, result_path, request_id),
        )

    def accept_result(self, owner: str, result: NativeResult) -> bool:
        with self.connect(transaction=True) as db:
            row = db.execute(
                "SELECT * FROM commands WHERE request_id=? AND owner=? AND state='sent'",
                (result.request_id, owner),
            ).fetchone()
            if row is None:
                return False
            url = trusted_url(row["provider"], result.conversation_url)
            status = result.status
            error = None if status == "completed" else f"provider_{status}"
            if status == "completed" and row["operation"] == "ask" and not result.text.strip():
                status, error = "failed", "provider_empty_response"
            if status == "completed" and row["operation"] == "open" and url is None:
                status, error = "needs_user_action", "provider_invalid_conversation_url"
            if result.status == "completed" and row["chat_url"]:
                if not url or saved_chat_url(row["provider"], url) != row["chat_url"]:
                    status, error = "unknown", "provider_chat_url_changed"
            directory = self.task_dir(row["task_id"]) / "responses"
            raw = None
            markdown = None
            content = None
            if row["operation"] != "open":
                raw = directory / f"{row['job_id']}.txt"
                atomic_text(raw, result.text)
                # Lossless capture: exactly what the provider would copy (tables,
                # code fences, formulas) plus a structured tree for future rich
                # consumers such as copied images or speech. The plain `.txt`
                # above remains the compatibility contract, so a missing or empty
                # Markdown capture falls back to the stored text.
                if result.markdown is not None and result.markdown.strip():
                    markdown = directory / f"{row['job_id']}.md"
                    atomic_text(markdown, result.markdown)
                if result.content is not None:
                    content = directory / f"{row['job_id']}.content.json"
                    atomic_text(
                        content,
                        result.content.model_dump_json(indent=1, exclude_none=True) + "\n",
                    )
            metadata = directory / f"{row['job_id']}.result.json"
            # Receipts stay body-free; only file paths and capture sizes are added.
            receipt = result.model_dump(exclude={"text", "markdown", "content"})
            receipt.update(
                {
                    "operation": row["operation"],
                    "modes": json.loads(row["modes_json"]),
                    "chat_url": row["chat_url"],
                    "accepted_status": status,
                    "accepted_error": error,
                    "trusted_conversation_url": url,
                    "markdown_path": str(markdown) if markdown is not None else None,
                    "markdown_bytes": (
                        len(result.markdown.encode("utf-8")) if markdown is not None else 0
                    ),
                    "content_path": str(content) if content is not None else None,
                    "content_blocks": len(result.content.blocks) if content is not None else 0,
                }
            )
            atomic_text(metadata, json.dumps(receipt, ensure_ascii=False))
            db.execute(
                "UPDATE commands SET conversation_url=?,markdown_path=? WHERE request_id=?",
                (url, str(markdown) if markdown is not None else None, result.request_id),
            )
            self._finish(
                db,
                result.request_id,
                status,
                error,
                str(raw) if raw is not None else None,
                str(metadata),
            )
            return True

    def uncertain(self, request_id: str, owner: str, reason: str) -> None:
        with self.connect(transaction=True) as db:
            row = db.execute(
                "SELECT state FROM commands WHERE request_id=? AND owner=?", (request_id, owner)
            ).fetchone()
            if row and row["state"] == "sent":
                self._finish(db, request_id, "unknown", reason)

    def expire(self) -> None:
        now = time.time()
        with self.connect(transaction=True) as db:
            rows = db.execute(
                "SELECT c.request_id,c.state FROM commands c LEFT JOIN hosts h ON c.owner=h.owner "
                "WHERE (c.state IN ('pending','pending_v2','pending_v3') AND c.created<?) OR "
                "(c.state='sent' AND (c.deadline<? OR h.owner IS NULL OR h.heartbeat<?))",
                (now - self.settings.queue_timeout, now, now - self.settings.host_lease),
            ).fetchall()
            for row in rows:
                status = "unknown" if row["state"] == "sent" else "timeout"
                reason = "native_host_unavailable" if status == "timeout" else "delivery_uncertain"
                self._finish(db, row["request_id"], status, reason)
            db.execute("DELETE FROM hosts WHERE heartbeat<?", (now - self.settings.host_lease,))

    def close_host(self, owner: str) -> None:
        with self.connect(transaction=True) as db:
            rows = db.execute(
                "SELECT request_id FROM commands WHERE owner=? AND state='sent'", (owner,)
            ).fetchall()
            for row in rows:
                self._finish(db, row["request_id"], "unknown", "host_disconnected")
            db.execute("DELETE FROM hosts WHERE owner=?", (owner,))

    def command_state(self, request_id: str) -> str:
        with self.connect() as db:
            row = db.execute(
                "SELECT state FROM commands WHERE request_id=?", (request_id,)
            ).fetchone()
            return row[0] if row else "unknown"

    def fail_pending(self, task_id: str, reason: str) -> None:
        with self.connect(transaction=True) as db:
            # Unsent commands can be cancelled safely; sent ones must finish/expire.
            rows = db.execute(
                "SELECT request_id FROM commands WHERE task_id=? "
                "AND state IN ('pending','pending_v2','pending_v3')",
                (task_id,),
            ).fetchall()
            for row in rows:
                self._finish(db, row["request_id"], "failed", reason)
            db.execute(
                "UPDATE jobs SET status='failed',error=? WHERE task_id=? AND status='pending'",
                (reason, task_id),
            )

    def is_terminal(self, task_id: str) -> bool:
        return self.task(task_id)["status"] in TERMINAL
