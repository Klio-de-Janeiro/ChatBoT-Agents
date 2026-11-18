"""Parse explicit CLI mode settings without inventing omitted website defaults."""

from __future__ import annotations

from pydantic import TypeAdapter

from .errors import AgentError
from .models import Modes, ModeValue

_MODES = TypeAdapter(Modes)


def parse_modes(*, think: list[str], search: list[str], extra: list[str]) -> dict[str, ModeValue]:
    settings: dict[str, ModeValue] = {}

    def add(name: str, value: ModeValue) -> None:
        if name in settings and settings[name] != value:
            raise AgentError("conflicting_modes", "conflicting duplicate mode settings")
        settings[name] = value

    for name, values in (("think", think), ("search", search)):
        for value in values:
            add(name, value == "on")
    for setting in extra:
        name, separator, value = setting.partition("=")
        if not separator:
            raise AgentError("invalid_mode", "--mode requires NAME=VALUE")
        parsed: ModeValue = value == "on" if value in {"on", "off"} else value
        add(name, parsed)
    return _MODES.validate_python(settings)
