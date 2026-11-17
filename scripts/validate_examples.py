"""Validate shipped plans against the installed backend schema, without submitting jobs."""

import sys
from pathlib import Path

from multi_chat_agent.models import Plan


def main() -> None:
    paths = list(Path(sys.argv[1]).glob("*.plan.json"))
    assert paths, "No example plans found"
    for path in paths:
        plan = Plan.model_validate_json(path.read_text(encoding="utf-8-sig"))
        assert plan.editor is not None, f"Missing editor: {path}"
        assert {job.provider for job in plan.jobs} == {"deepseek", "qwen"}
        print(f"Validated plan schema: {path.name}")


if __name__ == "__main__":
    main()
