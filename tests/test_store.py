import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from multi_chat_agent.models import JobPlan, NativeResult
from multi_chat_agent.store import Store


def result(command, text="answer", status="completed"):
    return NativeResult(type="result", request_id=command["request_id"], status=status, text=text)


def test_identical_submit_is_idempotent_and_different_plan_rejected(store, plan):
    assert store.submit(plan)
    assert not Store(store.settings).submit(plan)
    plan.objective = "different"
    with pytest.raises(ValueError, match="different plan"):
        store.submit(plan)


def test_windows_task_directory_case_collision_rejected(store, plan):
    store.submit(plan)
    changed = plan.model_copy(deep=True)
    changed.task_id = plan.task_id.upper()
    with pytest.raises(ValueError, match="different plan"):
        store.submit(changed)
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 1


def test_transactional_claim_across_threads_sends_once(store, plan):
    store.submit(plan)
    store.enqueue(plan.task_id, "intro", "prompt")
    for index in range(12):
        store.heartbeat(str(index))
    with ThreadPoolExecutor(max_workers=12) as pool:
        claimed = list(pool.map(lambda n: Store(store.settings).claim(str(n)), range(12)))
    assert sum(command is not None for command in claimed) == 1
    with store.connect() as db:
        assert db.execute("SELECT send_count FROM commands").fetchone()[0] == 1


def test_crashed_owner_is_unknown_and_never_resent_or_revived(store, plan):
    store.submit(plan)
    store.enqueue(plan.task_id, "intro", "private prompt")
    store.heartbeat("crashed")
    command = store.claim("crashed")
    with store.connect(transaction=True) as db:
        db.execute("UPDATE hosts SET heartbeat=?", (time.time() - 10,))
    recovered = Store(store.settings)
    recovered.expire()
    assert recovered.command_state(command["request_id"]) == "unknown"
    recovered.heartbeat("new-host")
    assert recovered.claim("new-host") is None
    assert not recovered.accept_result("crashed", result(command))


def test_duplicate_result_does_not_overwrite_answer(store, plan):
    store.submit(plan)
    store.enqueue(plan.task_id, "intro", "prompt")
    store.heartbeat("host")
    command = store.claim("host")
    assert store.accept_result("host", result(command, "first"))
    assert not store.accept_result("host", result(command, "duplicate"))
    assert not store.accept_result("other-host", result(command, "wrong host"))
    from pathlib import Path

    assert Path(store.jobs(plan.task_id)["intro"]["result_path"]).read_text() == "first"


def test_dotted_job_names_have_distinct_files(store, plan):
    plan.jobs = [
        JobPlan(id=name, provider="qwen", prompt=name) for name in ("part.one", "part.two")
    ]
    plan.editor = None
    store.submit(plan)
    store.heartbeat("host")
    for job in plan.jobs:
        store.enqueue(plan.task_id, job.id, job.prompt)
        command = store.claim("host")
        store.accept_result("host", result(command, job.id))
    paths = [job["result_path"] for job in store.jobs(plan.task_id).values()]
    assert len(set(paths)) == 2
    assert paths[0].endswith("part.one.txt")
    assert paths[1].endswith("part.two.txt")


@pytest.mark.parametrize("prompt", ["я" * (500 * 1024), "\n" * (600 * 1024)])
def test_oversized_utf8_or_escaped_wire_is_not_enqueued(store, plan, prompt):
    store.submit(plan)
    with pytest.raises(ValueError, match="(size limit|message limit)"):
        store.enqueue(plan.task_id, "intro", prompt)
    assert store.jobs(plan.task_id)["intro"]["status"] == "pending"
    assert store.claim("host") is None


def test_expired_unsent_command_is_known_timeout(store, plan):
    store.submit(plan)
    request_id = store.enqueue(plan.task_id, "intro", "prompt")
    with store.connect(transaction=True) as db:
        db.execute("UPDATE commands SET created=?", (time.time() - 100,))
    store.expire()
    assert store.command_state(request_id) == "timeout"
    assert store.claim("host") is None
