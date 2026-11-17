"""Compact JSON CLI. Full prompts and provider responses stay in local files."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from . import __version__
from .config import Settings
from .errors import AgentError
from .models import JobPlan, OutputPlan, Plan
from .native_host import NativeHost, StdioTransport
from .scheduler import Scheduler
from .store import Store


class CliError(ValueError):
    pass


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)


class JsonParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CliError(message)

    def print_help(self, file: Any = None) -> None:
        emit({"help": self.format_help()})


def positive_seconds(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a positive finite duration")
    return value


def parser() -> JsonParser:
    result = JsonParser(prog="mca", description="Durable local browser chat orchestration")
    commands = result.add_subparsers(
        dest="command", required=True, metavar="{run,ask,status,doctor,native-host}"
    )
    run = commands.add_parser("run", help="enqueue a JSON plan; resume an identical task safely")
    run.add_argument("plan", type=Path)
    ask = commands.add_parser("ask", help="save a single provider's raw response to a local file")
    ask.add_argument("provider", choices=("deepseek", "qwen"))
    prompt = ask.add_mutually_exclusive_group(required=True)
    prompt.add_argument("--prompt")
    prompt.add_argument("--prompt-file", type=Path)
    ask.add_argument("--timeout", type=positive_seconds, default=180)
    ask.add_argument("--task-id", help="optional durable ID, otherwise a new random ID")
    for command in (run, ask):
        command.add_argument("--wait", action="store_true")
        command.add_argument(
            "--wait-timeout",
            type=positive_seconds,
            help="bound this CLI wait; does not cancel the task",
        )
    status = commands.add_parser("status", help="report or resume a persisted task")
    status.add_argument("task_id")
    status.add_argument("--wait", action="store_true")
    status.add_argument("--wait-timeout", type=positive_seconds)
    commands.add_parser("doctor", help="report local configuration without response bodies")
    commands.add_parser("native-host", help="Chrome native messaging entrypoint")
    worker = commands.add_parser("_worker")
    worker.add_argument("task_id")
    return result


def _background(store: Store, task_id: str) -> None:
    """Launch an isolated scheduler; Windows never displays a helper console."""
    kwargs: dict[str, Any] = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    directory = store.task_dir(task_id)
    directory.mkdir(parents=True, exist_ok=True)
    # Internal worker emits no stdout. Its stderr is a local diagnostic artifact.
    with (directory / "worker.log").open("ab") as errors:
        subprocess.Popen(
            [sys.executable, "-m", "multi_chat_agent", "_worker", task_id],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=errors,
            close_fds=True,
            **kwargs,
        )


def _start(store: Store, task_id: str, *, wait: bool, wait_timeout: float | None) -> dict[str, Any]:
    scheduler = Scheduler(store)
    if wait:
        summary = asyncio.run(scheduler.run(task_id, wait_timeout=wait_timeout))
        if summary.get("wait_timeout"):
            _background(store, task_id)
        return summary
    if store.acquire_runner(task_id, scheduler.owner):
        try:
            scheduler.advance(task_id)
        finally:
            store.release_runner(task_id, scheduler.owner)
    if not store.is_terminal(task_id):
        _background(store, task_id)
    return store.summary(task_id)


def _native() -> int:
    try:
        if os.name == "nt":
            import msvcrt

            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        settings = Settings.from_env()
        transport = StdioTransport(
            sys.stdin.buffer,
            sys.stdout.buffer,
            max_bytes=settings.max_frame_bytes,
            io_timeout=settings.io_timeout,
        )
        # Chrome accepts at most 1 MiB from the host, while incoming frames can be larger.
        host = NativeHost(Store(settings), transport)
        asyncio.run(host.run())
        return 0
    except (OSError, ValueError, TimeoutError, sqlite3.Error):
        print('{"error":"native_host_failed"}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


def _doctor(store: Store) -> dict[str, Any]:
    with store.connect() as db:
        integrity = db.execute("PRAGMA quick_check").fetchone()[0]
        hosts = db.execute("SELECT count(*) FROM hosts").fetchone()[0]
    return {
        "status": "ok" if integrity == "ok" else "failed",
        "version": __version__,
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "home": str(store.settings.home),
        "database_path": str(store.settings.database),
        "database_check": integrity,
        "native_host_name": "com.multichat.agent",
        "connected_hosts": hosts,
        "live_provider_test": "not_performed",
        "queue_timeout_seconds": store.settings.queue_timeout,
    }


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    # Chrome appends an origin and potentially --parent-window; these are host arguments.
    if arguments and arguments[0] == "native-host":
        return _native()
    try:
        args = parser().parse_args(arguments)
        store = Store(Settings.from_env())
        if args.command == "doctor":
            store.expire()
            summary = _doctor(store)
        elif args.command == "_worker":
            asyncio.run(Scheduler(store).run(args.task_id))
            return 0
        elif args.command == "status":
            if args.wait:
                summary = _start(store, args.task_id, wait=True, wait_timeout=args.wait_timeout)
            else:
                # A one-pass resume also propagates recovered queue states to the task.
                scheduler = Scheduler(store)
                if store.acquire_runner(args.task_id, scheduler.owner):
                    try:
                        scheduler.advance(args.task_id)
                    finally:
                        store.release_runner(args.task_id, scheduler.owner)
                summary = store.summary(args.task_id)
        else:
            if args.command == "run":
                plan_path = args.plan.expanduser().resolve()
                plan = Plan.model_validate_json(plan_path.read_text(encoding="utf-8-sig"))
                output = Path(plan.output.path).expanduser()
                if not output.is_absolute():
                    output = plan_path.parent / output
                plan.output.path = str(output.resolve())
                store.submit(plan)
            else:
                prompt_text = (
                    args.prompt
                    if args.prompt is not None
                    else (args.prompt_file.read_text(encoding="utf-8-sig"))
                )
                task_id = args.task_id or f"ask-{uuid.uuid4().hex}"
                plan = Plan(
                    task_id=task_id,
                    objective="Direct provider ask",
                    jobs=[
                        JobPlan(
                            id="answer",
                            provider=args.provider,
                            prompt=prompt_text,
                            timeout=args.timeout,
                        )
                    ],
                    output=OutputPlan(
                        format="markdown", path=str(store.task_dir(task_id) / "answer.txt")
                    ),
                )
                store.submit(plan, kind="ask")
            summary = _start(store, plan.task_id, wait=args.wait, wait_timeout=args.wait_timeout)
        emit(summary)
        if summary.get("wait_timeout"):
            return 3
        return 0 if summary["status"] in {"ok", "pending", "running", "completed"} else 1
    except ValidationError as error:
        # Pydantic's default rendering embeds input values, potentially full responses.
        details = [
            {"location": list(item["loc"]), "type": item["type"]}
            for item in error.errors(include_input=False, include_context=False)
        ]
        emit({"status": "failed", "error": "validation_error", "details": details})
        return 2
    except (OSError, ValueError, sqlite3.Error) as error:
        # Never echo arbitrary provider text or a supplied prompt through exception messages.
        if isinstance(error, AgentError):
            code = error.code
        else:
            code = "invalid_arguments" if isinstance(error, CliError) else "operation_failed"
        emit({"status": "failed", "error": code, "error_type": type(error).__name__})
        return 2
    except KeyboardInterrupt:
        emit({"status": "interrupted"})
        return 130
