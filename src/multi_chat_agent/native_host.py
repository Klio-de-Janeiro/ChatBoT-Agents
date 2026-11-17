"""Chrome Native Messaging broker with bounded, daemon-thread pipe I/O."""

from __future__ import annotations

import asyncio
import json
import queue
import struct
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, BinaryIO, Protocol

from pydantic import ValidationError

from .models import NativeResult
from .store import Store


class ProtocolError(ValueError):
    pass


def _exact(stream: BinaryIO, count: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < count:
        part = stream.read(count - len(chunks))
        if not part:
            raise EOFError("native messaging stream closed")
        chunks.extend(part)
    return bytes(chunks)


def read_frame(stream: BinaryIO, max_bytes: int) -> dict[str, Any]:
    size = struct.unpack("<I", _exact(stream, 4))[0]
    if not 0 < size <= max_bytes:
        raise ProtocolError("invalid native frame length")
    try:
        value = json.loads(_exact(stream, size).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("invalid native frame JSON") from error
    if not isinstance(value, dict):
        raise ProtocolError("native frame must contain an object")
    return value


def write_frame(stream: BinaryIO, message: dict[str, Any], max_bytes: int) -> None:
    encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > max_bytes:
        raise ProtocolError("outbound native frame too large")
    data = struct.pack("<I", len(encoded)) + encoded
    # Raw Windows pipes and custom streams may perform partial writes.
    offset = 0
    while offset < len(data):
        written = stream.write(data[offset:])
        if written is None or written <= 0:
            raise OSError("native pipe write failed")
        offset += written
    stream.flush()


class Transport(Protocol):
    async def send(self, message: dict[str, Any]) -> None: ...
    async def receive(self) -> dict[str, Any]: ...


@dataclass
class _Write:
    message: dict[str, Any]
    done: threading.Event
    errors: list[Exception]


class StdioTransport:
    """No non-daemon blocked pipe reader survives native-host shutdown."""

    def __init__(self, stdin: BinaryIO, stdout: BinaryIO, *, max_bytes: int, io_timeout: float):
        self.stdin, self.stdout = stdin, stdout
        self.max_bytes, self.io_timeout = max_bytes, io_timeout
        self.incoming: queue.Queue[dict[str, Any] | Exception] = queue.Queue(maxsize=100)
        self.outgoing: queue.Queue[_Write] = queue.Queue(maxsize=10)
        threading.Thread(target=self._reader, daemon=True, name="mca-stdin").start()
        threading.Thread(target=self._writer, daemon=True, name="mca-stdout").start()

    def _reader(self) -> None:
        try:
            while True:
                self.incoming.put(read_frame(self.stdin, self.max_bytes))
        except Exception as error:
            self.incoming.put(error)

    def _writer(self) -> None:
        while True:
            work = self.outgoing.get()
            try:
                write_frame(self.stdout, work.message, min(self.max_bytes, 1024 * 1024))
            except Exception as error:
                work.errors.append(error)
            finally:
                work.done.set()

    async def send(self, message: dict[str, Any]) -> None:
        work = _Write(message, threading.Event(), [])
        self.outgoing.put_nowait(work)
        async with asyncio.timeout(self.io_timeout):
            while not work.done.is_set():
                await asyncio.sleep(0.01)
        if work.errors:
            raise work.errors[0]

    async def receive(self) -> dict[str, Any]:
        while True:
            try:
                item = self.incoming.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.01)
                continue
            if isinstance(item, Exception):
                raise item
            return item


class NativeHost:
    def __init__(self, store: Store, transport: Transport):
        self.store, self.transport = store, transport
        self.owner = str(uuid.uuid4())

    async def run(self, *, stop: Callable[[], bool] = lambda: False) -> None:
        active: set[str] = set()
        receiver: asyncio.Task[dict[str, Any]] | None = None
        self.store.heartbeat(self.owner)
        try:
            receiver = asyncio.create_task(self.transport.receive())
            while not stop():
                self.store.heartbeat(self.owner)
                self.store.expire()
                active = {
                    request_id
                    for request_id in active
                    if self.store.command_state(request_id) == "sent"
                }
                # Check disconnect/protocol errors before taking another send claim.
                if receiver.done():
                    message = receiver.result()
                    if message.get("type") == "result":
                        try:
                            result = NativeResult.model_validate(message)
                        except ValidationError as error:
                            raise ProtocolError("invalid result envelope") from error
                        self.store.accept_result(self.owner, result)
                        active.discard(result.request_id)
                    elif message.get("type") != "hello":
                        raise ProtocolError("unsupported native message type")
                    receiver = asyncio.create_task(self.transport.receive())
                while len(active) < self.store.settings.max_inflight:
                    self.store.heartbeat(self.owner)
                    command = self.store.claim(self.owner)
                    if command is None:
                        break
                    active.add(command["request_id"])
                    try:
                        await asyncio.wait_for(
                            self.transport.send(command), timeout=self.store.settings.io_timeout
                        )
                    except (OSError, ValueError, TimeoutError, queue.Full):
                        self.store.uncertain(
                            command["request_id"], self.owner, "native_write_uncertain"
                        )
                        raise
                await asyncio.sleep(self.store.settings.poll_interval)
        except EOFError:
            # Chrome closed the connection; outstanding commands are ambiguous.
            pass
        finally:
            if receiver:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
            self.store.close_host(self.owner)
