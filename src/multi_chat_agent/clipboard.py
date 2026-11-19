"""Clipboard hand-off for provider-formatted answers.

The answer is piped through the platform's clipboard utility without shell
quoting. No utility is bundled or installed: when none
is present the caller gets a structured `clipboard_unavailable` error and the
already saved files remain the copy source.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

from .errors import AgentError

# Ordered by availability on the target platform; Windows first matches the MVP.
_WINDOWS = [("clip", [])]
_MACOS = [("pbcopy", [])]
_LINUX = [
    ("wl-copy", []),
    ("xclip", ["-selection", "clipboard"]),
    ("xsel", ["--clipboard", "--input"]),
]


def candidates() -> list[tuple[str, list[str]]]:
    if os.name == "nt":
        return _WINDOWS
    if sys.platform == "darwin":
        return _MACOS
    return _LINUX


def copy_text(text: str) -> str:
    """Copy `text` verbatim and return the utility name that accepted it."""
    for name, arguments in candidates():
        executable = shutil.which(name)
        if executable is None:
            continue
        # clip.exe recognizes UTF-16 with its BOM. Unmarked UTF-8 is decoded
        # with the local code page and corrupts Cyrillic and other Unicode.
        data = text.encode("utf-16") if name == "clip" else text.encode("utf-8")
        try:
            completed = subprocess.run(
                [executable, *arguments],
                input=data,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if completed.returncode == 0:
            return name
    raise AgentError(
        "clipboard_unavailable",
        "no clipboard utility found; use the saved answer file instead",
    )
