"""Offline byte-level smoke test for the compiled native launcher; no provider calls."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
from pathlib import Path


def main() -> None:
    executable = Path(sys.argv[1]).resolve()
    origin = sys.argv[2]
    payloads = [
        {"type": "hello", "version": 1},
        {"test": "Русский текст\nCRLF\r\nemoji \U0001f680", "long": "x" * 100_000},
    ]
    wire = b""
    for item in payloads:
        body = json.dumps(item, ensure_ascii=False).encode("utf-8")
        wire += struct.pack("<I", len(body)) + body
    result = subprocess.run(
        [str(executable), origin, "--parent-window=0"],
        input=wire,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    assert result.stdout == wire, "Launcher changed, truncated or contaminated protocol bytes"
    assert b"MOCK_STDERR_ONLY" in result.stderr, "Child stderr was lost"
    denied = subprocess.run(
        [str(executable), "chrome-extension://" + "b" * 32 + "/"],
        input=b"",
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert denied.returncode != 0 and denied.stdout == b"", "Origin rejection polluted stdout"
    print("Launcher byte transport, EOF, Chrome arguments, stderr and origin checks passed")


if __name__ == "__main__":
    main()
