from __future__ import annotations

import asyncio
import io
import struct
import threading

import pytest

from multi_chat_agent.native_host import (
    NativeHost,
    ProtocolError,
    StdioTransport,
    read_frame,
    write_frame,
)
from multi_chat_agent.scheduler import Scheduler


def test_framing_uses_utf8_byte_length_and_handles_partial_io():
    class Partial(io.BytesIO):
        def read(self, size=-1):
            return super().read(min(size, 2))

        def write(self, data):
            return super().write(data[:3])

    stream = Partial()
    message = {"type": "hello", "text": "Привет 🌍"}
    write_frame(stream, message, 1000)
    payload = stream.getvalue()
    assert struct.unpack("<I", payload[:4])[0] == len(payload[4:])
    stream.seek(0)
    assert read_frame(stream, 1000) == message


@pytest.mark.parametrize(
    "payload,error",
    [
        (b"\x00\x00\x00\x00", ProtocolError),
        (struct.pack("<I", 10000), ProtocolError),
        (struct.pack("<I", 3) + b"[1]", ProtocolError),
        (struct.pack("<I", 1) + b"{", ProtocolError),
        (struct.pack("<I", 1) + b"\xff", ProtocolError),
        (b"\x01\x00", EOFError),
        (struct.pack("<I", 5) + b"{}", EOFError),
    ],
)
def test_bad_native_frames_fail_bounded(payload, error):
    with pytest.raises(error):
        read_frame(io.BytesIO(payload), 1000)


async def test_native_write_failure_is_unknown_and_not_resent(store, plan):
    class Broken:
        async def send(self, message):
            raise BrokenPipeError

        async def receive(self):
            await asyncio.Future()

    store.submit(plan)
    Scheduler(store).tick(plan.task_id)
    with pytest.raises(BrokenPipeError):
        await NativeHost(store, Broken()).run()
    assert store.jobs(plan.task_id)["intro"]["status"] == "unknown"
    assert store.jobs(plan.task_id)["details"]["status"] == "queued"


async def test_stuck_writer_has_bounded_timeout_without_non_daemon_threads():
    forever = threading.Event()

    class Stuck(io.BytesIO):
        def write(self, data):
            forever.wait()
            return len(data)

    transport = StdioTransport(io.BytesIO(), Stuck(), max_bytes=1024, io_timeout=0.02)
    try:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(transport.send({"type": "hello"}), 0.2)
    finally:
        forever.set()


async def test_hello_ignored_before_result_and_unknown_result_ignored(store, plan):
    class HelloThenClosed:
        def __init__(self):
            self.messages = asyncio.Queue()
            self.messages.put_nowait({"type": "hello", "version": 1})
            self.messages.put_nowait(
                {
                    "type": "result",
                    "request_id": "irrelevant",
                    "status": "completed",
                    "text": "private",
                }
            )

        async def send(self, message):
            pass

        async def receive(self):
            if self.messages.empty():
                raise EOFError
            return await self.messages.get()

    # Idle host still consumes hello and unknown results safely.
    await asyncio.wait_for(NativeHost(store, HelloThenClosed()).run(), timeout=1)
    with store.connect() as db:
        assert db.execute("SELECT count(*) FROM commands").fetchone()[0] == 0


def test_outbound_framing_rejects_oversize_before_writing():
    target = io.BytesIO()
    with pytest.raises(ProtocolError):
        write_frame(target, {"prompt": "я" * 100}, 100)
    assert not target.getvalue()
