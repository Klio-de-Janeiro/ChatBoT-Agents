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
from .clipboard import copy_text
from .config import Settings
from .errors import AgentError
from .models import OPEN_PROMPT, OUTPUT_EXTENSIONS, JobPlan, OutputPlan, Plan
from .modes import parse_modes
from .native_host import NativeHost, StdioTransport
from .providers import PROVIDERS, registry_summary
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
        dest="command",
        required=True,
        metavar="{run,ask,open,copy,providers,status,doctor,native-host}",
    )
    run = commands.add_parser("run", help="enqueue a JSON plan; resume an identical task safely")
    run.add_argument("plan", type=Path)
    ask = commands.add_parser("ask", help="save a single provider's raw response to a local file")
    prompt = ask.add_mutually_exclusive_group(required=True)
    prompt.add_argument("--prompt")
    prompt.add_argument("--prompt-file", type=Path)
    ask.add_argument(
        "--replace-draft", action="store_true", help="discard an existing draft in the target tab"
    )
    ask.add_argument("--format", choices=tuple(OUTPUT_EXTENSIONS), help="format of the answer file")
    ask.add_argument(
        "--output", type=Path, help="destination file, relative to the current directory"
    )
    launch = commands.add_parser(
        "open", help="open an owned provider conversation without submitting"
    )
    for command in (ask, launch):
        command.add_argument("provider", choices=tuple(PROVIDERS))
        command.add_argument("--chat-url", help="URL of an existing chat")
        command.add_argument("--timeout", type=positive_seconds, default=180)
        command.add_argument("--task-id", help="optional durable ID, otherwise a new random ID")
        command.add_argument("--think", choices=("on", "off"), action="append", default=[])
        command.add_argument("--search", choices=("on", "off"), action="append", default=[])
        command.add_argument("--mode", metavar="NAME=VALUE", action="append", default=[])
    for command in (run, ask, launch):
        command.add_argument("--wait", action="store_true")
        command.add_argument(
            "--wait-timeout",
            type=positive_seconds,
            help="bound this CLI wait; does not cancel the task",
        )
    copy = commands.add_parser(
        "copy", help="copy the answer to the clipboard exactly as the provider formatted it"
    )
    copy.add_argument("task_id")
    copy.add_argument(
        "--raw",
        action="store_true",
        help="copy the plain saved text instead of the provider-native Markdown",
    )
    status = commands.add_parser("status", help="report or resume a persisted task")
    status.add_argument("task_id")
    status.add_argument("--wait", action="store_true")
    status.add_argument("--wait-timeout", type=positive_seconds)
    commands.add_parser("doctor", help="report local configuration without response bodies")
    commands.add_parser("providers", help="list provider adapters and configurable modes")
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
        "status": ("failed" if integrity != "ok" else "ok" if hosts else "needs_user_action"),
        "version": __version__,
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "home": str(store.settings.home),
        "database_path": str(store.settings.database),
        "database_check": integrity,
        "native_host_name": "com.multichat.agent",
        "connected_hosts": hosts,
        "browser_bridge_ready": bool(hosts),
        "next_action": None
        if hosts
        else (
            "Load extension/dist in Chrome, register native host with its actual extension ID, "
            "then reload the extension. Opening provider tabs alone does not connect the CLI."
        ),
        "live_provider_test": "not_performed",
        "queue_timeout_seconds": store.settings.queue_timeout,
    }


def _copy(store: Store, task_id: str, raw: bool) -> dict[str, Any]:
    """Put one answer on the clipboard without printing or re-encoding it."""
    task = store.task(task_id)
    if task["status"] != "completed":
        raise AgentError("task_not_completed", "only a completed task has an answer to copy")
    jobs = store.jobs(task_id)
    job = next((item for item in jobs.values() if item["role"] == "author"), None)
    if job is None or job["operation"] == "open":
        raise AgentError("no_answer_to_copy", "this task opened a conversation; it has no answer")
    # Results received before 0.3.0 have only the plain `.txt` body.
    markdown = None if raw else job["markdown_path"]
    source = markdown or job["result_path"]
    if not source or not Path(source).is_file():
        raise AgentError("response_missing", "the saved answer file is missing")
    text = Path(source).read_text(encoding="utf-8")
    utility = copy_text(text)
    return {
        "status": "ok",
        "task_id": task_id,
        "job_id": job["job_id"],
        "format": "markdown" if markdown else "text",
        "source_path": source,
        "characters": len(text),
        "clipboard": utility,
    }


def direct_output(args: argparse.Namespace, task_dir: Path) -> OutputPlan:
    # Retain the original plan defaults so old task IDs can still be resumed.
    if args.command == "open" or (args.format is None and args.output is None):
        return OutputPlan(format="markdown", path=str(task_dir / "answer.txt"))

    output_format = args.format
    destination = args.output.expanduser() if args.output is not None else None
    if destination is not None and destination.is_dir():
        raise AgentError("output_is_directory", "--output must name a file")
    if destination is not None and destination.suffix:
        suffix = destination.suffix.lower()
        if output_format is None:
            output_format = next(
                (name for name, ext in OUTPUT_EXTENSIONS.items() if ext == suffix), None
            )
            if output_format is None:
                raise AgentError(
                    "unsupported_output_extension", "choose a supported file extension"
                )
        elif OUTPUT_EXTENSIONS[output_format] != suffix:
            raise AgentError("output_extension_mismatch", "the filename must match --format")
    output_format = output_format or "txt"
    suffix = OUTPUT_EXTENSIONS[output_format]
    if destination is None:
        destination = task_dir / "responses" / ("answer" + suffix)
    elif not destination.suffix:
        destination = destination.with_name(destination.name + suffix)
    return OutputPlan(format=output_format, path=str(destination.expanduser().resolve()))


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    # Chrome appends an origin and potentially --parent-window; these are host arguments.
    if arguments and arguments[0] == "native-host":
        return _native()
    try:
        args = parser().parse_args(arguments)
        if args.command == "providers":
            emit(registry_summary())
            return 0
        store = Store(Settings.from_env())
        if args.command == "doctor":
            store.expire()
            summary = _doctor(store)
        elif args.command == "_worker":
            asyncio.run(Scheduler(store).run(args.task_id))
            return 0
        elif args.command == "copy":
            store.expire()
            emit(_copy(store, args.task_id, args.raw))
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
                mode_flags = args.mode
                if args.command == "ask" and args.replace_draft:
                    mode_flags = [*mode_flags, "replace-draft=on"]
                modes = parse_modes(think=args.think, search=args.search, extra=mode_flags)
                if args.command == "open":
                    prompt_text = OPEN_PROMPT
                else:
                    prompt_text = (
                        args.prompt
                        if args.prompt is not None
                        else args.prompt_file.read_text(encoding="utf-8-sig")
                    )
                task_id = args.task_id or f"{args.command}-{uuid.uuid4().hex}"
                plan = Plan(
                    task_id=task_id,
                    objective="Open provider conversation"
                    if args.command == "open"
                    else "Direct provider ask",
                    jobs=[
                        JobPlan(
                            id="conversation" if args.command == "open" else "answer",
                            provider=args.provider,
                            prompt=prompt_text,
                            timeout=args.timeout,
                            operation=args.command,
                            modes=modes,
                            chat_url=args.chat_url,
                        )
                    ],
                    output=direct_output(args, store.task_dir(task_id)),
                )
                store.submit(plan, kind=args.command)
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
