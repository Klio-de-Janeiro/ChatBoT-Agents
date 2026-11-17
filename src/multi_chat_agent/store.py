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
from .errors import AgentError
from .files import atomic_text
from .models import TERMINAL, NativeResult, Plan

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
PRAGMA user_version=1;
"""


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.home.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise AgentError("unsupported_schema", "unsupported database schema version")
            db.executescript(SCHEMA)

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

    def submit(self, plan: Plan, *, kind: str = "plan") -> bool:
        serialized = plan.model_dump_json()
        now = time.time()
        with self.connect(transaction=True) as db:
            previous = db.execute(
                "SELECT plan_json,kind FROM tasks WHERE task_id=? COLLATE NOCASE", (plan.task_id,)
            ).fetchone()
            if previous:
                if previous["plan_json"] != serialized or previous["kind"] != kind:
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
                    "INSERT INTO jobs(task_id,job_id,role,provider,timeout) VALUES(?,?,?,?,?)",
                    (plan.task_id, job.id, "author", job.provider, job.timeout),
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
                "SELECT j.*,c.metadata_path FROM jobs j LEFT JOIN commands c "
                "ON j.request_id=c.request_id WHERE j.task_id=? ORDER BY j.rowid",
                (task_id,),
            )
            return {row["job_id"]: dict(row) for row in rows}

    def summary(self, task_id: str) -> dict[str, Any]:
        task = self.task(task_id)
        return {
            "task_id": task_id,
            "status": task["status"],
            "error": task["error"],
            "output_path": task["output_path"],
            "task_dir": str(self.task_dir(task_id)),
            "jobs": [
                {
                    key: job[key]
                    for key in (
                        "job_id",
                        "role",
                        "provider",
                        "status",
                        "request_id",
                        "result_path",
                        "metadata_path",
                        "error",
                    )
                }
                for job in self.jobs(task_id).values()
            ],
        }

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
        self, task_id: str, status: str, *, error: str | None = None, output_path: str | None = None
    ) -> None:
        with self.connect(transaction=True) as db:
            db.execute(
                "UPDATE tasks SET status=?,error=?,output_path=?,updated=? WHERE task_id=?",
                (status, error, output_path, time.time(), task_id),
            )

    def add_editor(self, task_id: str, plan: Plan, *, repair: bool = False) -> str:
        assert plan.editor is not None
        job_id = "_repair" if repair else "_editor"
        with self.connect(transaction=True) as db:
            db.execute(
                "INSERT OR IGNORE INTO jobs(task_id,job_id,role,provider,timeout) "
                "VALUES(?,?,?,?,?)",
                (
                    task_id,
                    job_id,
                    "repair" if repair else "editor",
                    plan.editor.provider,
                    plan.editor.timeout,
                ),
            )
        return job_id

    def enqueue(self, task_id: str, job_id: str, prompt: str) -> str | None:
        if len(prompt.encode("utf-8")) > self.settings.max_prompt_bytes:
            raise AgentError("prompt_too_large", "prompt exceeds configured size limit")
        with self.connect(transaction=True) as db:
            job = db.execute(
                "SELECT * FROM jobs WHERE task_id=? AND job_id=?", (task_id, job_id)
            ).fetchone()
            if job is None or job["status"] != "pending":
                return None
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
            }
            if len(json.dumps(wire, ensure_ascii=False).encode("utf-8")) > (
                self.settings.max_outbound_bytes
            ):
                raise AgentError(
                    "native_message_too_large", "serialized job exceeds Chrome native message limit"
                )
            db.execute(
                "INSERT INTO commands(request_id,task_id,job_id,provider,prompt,conversation_key,"
                "timeout_ms,created) VALUES(?,?,?,?,?,?,?,?)",
                (
                    request_id,
                    task_id,
                    job_id,
                    job["provider"],
                    prompt,
                    conversation_key,
                    timeout_ms,
                    time.time(),
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
                "SELECT * FROM commands WHERE state='pending' ORDER BY created LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE commands SET state='sent',owner=?,sent_at=?,deadline=?,send_count=1 "
                "WHERE request_id=? AND state='pending'",
                (
                    owner,
                    now,
                    now + row["timeout_ms"] / 1000 + self.settings.io_timeout,
                    row["request_id"],
                ),
            )
            db.execute("UPDATE jobs SET status='running' WHERE request_id=?", (row["request_id"],))
            return {
                "type": "job",
                "request_id": row["request_id"],
                "provider": row["provider"],
                "prompt": row["prompt"],
                "conversation_key": row["conversation_key"],
                "timeout_ms": row["timeout_ms"],
            }

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
            directory = self.task_dir(row["task_id"]) / "responses"
            raw = directory / f"{row['job_id']}.txt"
            metadata = directory / f"{row['job_id']}.result.json"
            atomic_text(raw, result.text)
            atomic_text(metadata, result.model_dump_json(exclude={"text"}))
            error = None if result.status == "completed" else f"provider_{result.status}"
            self._finish(db, result.request_id, result.status, error, str(raw), str(metadata))
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
                "WHERE (c.state='pending' AND c.created<?) OR "
                "(c.state='sent' AND (c.deadline<? OR h.owner IS NULL OR h.heartbeat<?))",
                (now - self.settings.queue_timeout, now, now - self.settings.host_lease),
            ).fetchall()
            for row in rows:
                status = "timeout" if row["state"] == "pending" else "unknown"
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
                "SELECT request_id FROM commands WHERE task_id=? AND state='pending'", (task_id,)
            ).fetchall()
            for row in rows:
                self._finish(db, row["request_id"], "failed", reason)
            db.execute(
                "UPDATE jobs SET status='failed',error=? WHERE task_id=? AND status='pending'",
                (reason, task_id),
            )

    def is_terminal(self, task_id: str) -> bool:
        return self.task(task_id)["status"] in TERMINAL
