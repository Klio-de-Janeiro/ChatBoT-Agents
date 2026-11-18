"""Upgrade a populated independent v1 schema snapshot without losing send history."""

from __future__ import annotations

import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from multi_chat_agent.config import Settings
from multi_chat_agent.models import NativeResult, Plan
from multi_chat_agent.scheduler import Scheduler
from multi_chat_agent.store import Store

V1_SCHEMA = """
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, plan_json TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', output_path TEXT, error TEXT,
  created REAL NOT NULL, updated REAL NOT NULL, runner TEXT, runner_heartbeat REAL
);
CREATE TABLE jobs (
  task_id TEXT NOT NULL REFERENCES tasks(task_id), job_id TEXT NOT NULL,
  role TEXT NOT NULL, provider TEXT NOT NULL, timeout REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', request_id TEXT UNIQUE,
  result_path TEXT, error TEXT, PRIMARY KEY(task_id,job_id)
);
CREATE TABLE hosts (owner TEXT PRIMARY KEY, heartbeat REAL NOT NULL);
CREATE TABLE commands (
  request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, job_id TEXT NOT NULL,
  provider TEXT NOT NULL, prompt TEXT NOT NULL, conversation_key TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  created REAL NOT NULL, owner TEXT, sent_at REAL, deadline REAL,
  send_count INTEGER NOT NULL DEFAULT 0 CHECK(send_count <= 1),
  result_path TEXT, metadata_path TEXT, error TEXT,
  FOREIGN KEY(task_id,job_id) REFERENCES jobs(task_id,job_id), UNIQUE(task_id,job_id)
);
PRAGMA user_version=1;
"""


@pytest.fixture
def legacy(tmp_path):
    settings = Settings(home=tmp_path / "legacy", poll_interval=0.005, queue_timeout=30)
    settings.home.mkdir()
    answer = settings.home / "old-answer.txt"
    answer.write_text("PRESERVED_OLD_ANSWER", encoding="utf-8")
    now = time.time()
    plans = {}
    with sqlite3.connect(settings.database) as db:
        db.executescript(V1_SCHEMA)
        for state, task_status, job_status in (
            ("completed", "completed", "completed"),
            ("pending", "running", "queued"),
            ("sent", "running", "running"),
        ):
            task_id = f"old-{state}"
            plan = {
                "task_id": task_id,
                "objective": "Legacy ask",
                "jobs": [
                    {
                        "id": "answer",
                        "provider": "qwen",
                        "prompt": "LEGACY_PRIVATE_PROMPT",
                        "timeout": 180,
                        "depends_on": [],
                    }
                ],
                "editor": None,
                "output": {"format": "markdown", "path": str(answer)},
            }
            plans[task_id] = plan
            request_id = f"request-{state}"
            raw = str(answer) if state == "completed" else None
            owner = "crashed-owner" if state == "sent" else None
            db.execute(
                "INSERT INTO tasks(task_id,plan_json,kind,status,created,updated,output_path) "
                "VALUES(?,?,?,?,?,?,?)",
                (task_id, json.dumps(plan), "ask", task_status, now, now, raw),
            )
            db.execute(
                "INSERT INTO jobs(task_id,job_id,role,provider,timeout,status,request_id,"
                "result_path) VALUES(?,?,?,?,?,?,?,?)",
                (task_id, "answer", "author", "qwen", 180, job_status, request_id, raw),
            )
            db.execute(
                "INSERT INTO commands(request_id,task_id,job_id,provider,prompt,"
                "conversation_key,timeout_ms,state,created,owner,sent_at,deadline,"
                "send_count,result_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    request_id,
                    task_id,
                    "answer",
                    "qwen",
                    "LEGACY_PRIVATE_PROMPT",
                    f"{task_id}:qwen:author",
                    180000,
                    state,
                    now,
                    owner,
                    now - 20 if state == "sent" else None,
                    now + 100,
                    0 if state == "pending" else 1,
                    raw,
                ),
            )
        db.execute("INSERT INTO hosts VALUES(?,?)", ("crashed-owner", now - 30))
    return settings, plans, answer


def test_migration_preserves_old_tasks_jobs_results_and_send_counts(legacy):
    settings, plans, answer = legacy
    with sqlite3.connect(settings.database) as db:
        original = {
            table: db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            for table in ("tasks", "jobs", "commands")
        }
    store = Store(settings)
    with store.connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
        for table, rows in original.items():
            upgraded = db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            assert [tuple(row)[: len(rows[0])] for row in upgraded] == rows
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert answer.read_text(encoding="utf-8") == "PRESERVED_OLD_ANSWER"
    assert store.summary("old-completed")["output_path"] == str(answer)
    # Adding default operation/modes to a loaded plan must not break resubmission.
    for plan in plans.values():
        assert not store.submit(Plan.model_validate(plan), kind="ask")


async def test_migrated_pending_ask_resumes_but_uncertain_send_never_repeats(legacy):
    settings, _, _ = legacy
    store = Store(settings)
    store.expire()
    assert store.command_state("request-sent") == "unknown"
    store.heartbeat("new-host")
    wire = store.claim("new-host")
    assert wire["request_id"] == "request-pending"
    assert wire["prompt"] == "LEGACY_PRIVATE_PROMPT"
    assert "operation" not in wire and "modes" not in wire
    assert store.accept_result(
        "new-host",
        NativeResult(
            type="result",
            request_id=wire["request_id"],
            status="completed",
            text="NEW_ANSWER",
        ),
    )
    assert Store(settings).claim("new-host") is None
    assert (await Scheduler(store).run("old-pending"))["status"] == "completed"
    assert (await Scheduler(store).run("old-sent"))["status"] == "unknown"
    assert (await Scheduler(store).run("old-completed"))["status"] == "completed"


def test_concurrent_migration_is_atomic_and_idempotent(legacy):
    settings, _, _ = legacy
    with ThreadPoolExecutor(max_workers=8) as pool:
        stores = list(pool.map(lambda _: Store(settings), range(8)))
    with stores[0].connect() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
        assert db.execute("SELECT count(*) FROM commands").fetchone()[0] == 3
        assert db.execute("SELECT sum(send_count) FROM commands").fetchone()[0] == 2


def test_partial_additive_migration_is_recoverable(legacy):
    settings, _, _ = legacy
    with sqlite3.connect(settings.database) as db:
        db.execute("ALTER TABLE jobs ADD COLUMN operation TEXT NOT NULL DEFAULT 'ask'")
    store = Store(settings)
    assert store.jobs("old-pending")["answer"]["operation"] == "ask"
    assert store.jobs("old-pending")["answer"]["modes"] == {}


def test_newer_database_is_rejected_without_mutation(legacy):
    settings, _, _ = legacy
    with sqlite3.connect(settings.database) as db:
        db.execute("PRAGMA user_version=99")
    with pytest.raises(ValueError, match="unsupported database schema"):
        Store(settings)
    with sqlite3.connect(settings.database) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 99
        assert "operation" not in {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
