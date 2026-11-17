from __future__ import annotations

from pathlib import Path

import pytest

from multi_chat_agent.config import Settings
from multi_chat_agent.models import Plan
from multi_chat_agent.store import Store


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return Store(
        Settings(
            home=tmp_path / "state",
            poll_interval=0.005,
            queue_timeout=0.3,
            host_lease=0.2,
            io_timeout=0.05,
        )
    )


@pytest.fixture
def plan(tmp_path: Path) -> Plan:
    return Plan.model_validate(
        {
            "task_id": "material-1",
            "objective": "Explain durable scheduling",
            "jobs": [
                {
                    "id": "intro",
                    "provider": "deepseek",
                    "prompt": "Write introduction",
                    "timeout": 1,
                },
                {"id": "details", "provider": "qwen", "prompt": "Write details", "timeout": 1},
                {
                    "id": "conclusion",
                    "provider": "deepseek",
                    "prompt": "Write conclusion",
                    "depends_on": ["intro", "details"],
                    "timeout": 1,
                },
            ],
            "editor": {"provider": "qwen", "prompt": "Edit all author outputs", "timeout": 1},
            "output": {"format": "ipynb", "path": str(tmp_path / "final.ipynb")},
        }
    )
