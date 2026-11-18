"""Explicit provider registry; adding a site also requires an extension adapter/allowlist."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from importlib.resources import files
from urllib.parse import urlsplit


@dataclass(frozen=True)
class ProviderInfo:
    id: str
    name: str
    url: str
    modes: tuple[str, ...]


_CATALOG = json.loads(
    files(__package__).joinpath("provider_catalog.json").read_text(encoding="utf-8")
)
PROVIDERS = {
    key: ProviderInfo(key, entry["name"], entry["origin"] + entry["start"], tuple(entry["modes"]))
    for key, entry in _CATALOG.items()
}


def validate_provider(value: str) -> str:
    if value not in PROVIDERS:
        raise ValueError("unknown provider")
    return value


def trusted_url(provider: str, value: str | None) -> str | None:
    """Allow a conversation URL only from the selected adapter's HTTPS origin."""
    if not value or any(character.isspace() or ord(character) < 32 for character in value):
        return None
    try:
        parsed = urlsplit(value)
        expected = urlsplit(PROVIDERS[provider].url)
        if (
            parsed.scheme == "https"
            and parsed.hostname == expected.hostname
            and parsed.port in (None, 443)
            and parsed.username is None
            and parsed.password is None
        ):
            return value
    except ValueError:
        pass
    return None


def saved_chat_url(provider: str, value: str) -> str | None:
    if len(value) > 512 or not trusted_url(provider, value):
        return None
    path = urlsplit(value).path.rstrip("/")
    for prefix in _CATALOG[provider]["resume_paths"]:
        if path.startswith(prefix) and re.fullmatch(r"[A-Za-z0-9_-]+", path[len(prefix) :]):
            return _CATALOG[provider]["origin"] + path
    return None


def registry_summary() -> dict[str, object]:
    return {
        "status": "ok",
        "providers": [
            {
                "id": provider.id,
                "name": provider.name,
                "url": provider.url,
                "operations": ["open", "ask"],
                "modes": {
                    mode: {"type": "string", "values": ["auto", "thinking", "fast"]}
                    if mode == "reasoning"
                    else {"type": "boolean"}
                    for mode in provider.modes
                },
                "mutually_exclusive_modes": [["think", "reasoning"]]
                if provider.id == "qwen"
                else [],
                "mode_control": "Requires a configured, verifiable extension control; "
                "unsupported modes or states return needs_user_action before submission.",
            }
            for provider in PROVIDERS.values()
        ],
    }
