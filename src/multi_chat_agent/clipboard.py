"""Clipboard hand-off for provider-formatted answers.

The answer is piped through the platform's clipboard utility, so the exact
bytes the provider produced arrive in the clipboard unchanged (no shell
quoting, no text re-encoding). No utility is bundled or installed: when none
is present the caller gets a structured `clipboard_unavailable` error and the
already saved files remain the copy source.
"""

from __future__ import annotations

import os
import shutil
import subprocess

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
    if os.uname().sysname == "Darwin":
        return _MACOS
    return _LINUX


def copy_text(text: str) -> str:
    """Copy `text` verbatim and return the utility name that accepted it."""
    for name, arguments in candidates():
        executable = shutil.which(name)
        if executable is None:
            continue
        try:
            completed = subprocess.run(
                [executable, *arguments],
                input=text.encode("utf-8"),
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
