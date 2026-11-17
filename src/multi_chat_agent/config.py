"""Small explicit configuration surface; all durations are seconds."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path


def _number(name: str, default: float, minimum: float = 0.01) -> float:
    value = float(os.environ.get(name, default))
    if not math.isfinite(value) or value < minimum:
        raise ValueError(f"{name} must be a finite number >= {minimum}")
    return value


@dataclass(frozen=True)
class Settings:
    home: Path
    poll_interval: float = 0.1
    queue_timeout: float = 60
    host_lease: float = 10
    io_timeout: float = 5
    max_frame_bytes: int = 8 * 1024 * 1024
    max_prompt_bytes: int = 900 * 1024
    max_outbound_bytes: int = 1024 * 1024
    max_inflight: int = 4

    @property
    def database(self) -> Path:
        return self.home / "queue.sqlite3"

    @classmethod
    def from_env(cls) -> Settings:
        default = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share"))
        home = Path(os.environ.get("MCA_HOME", str(default / "MultiChatAgent")))
        return cls(
            home=home.expanduser().resolve(),
            poll_interval=_number("MCA_POLL_INTERVAL", 0.1),
            queue_timeout=_number("MCA_QUEUE_TIMEOUT", 60),
            host_lease=_number("MCA_HOST_LEASE", 10),
            io_timeout=_number("MCA_IO_TIMEOUT", 5),
        )
