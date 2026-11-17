import pytest
from pydantic import ValidationError

from multi_chat_agent.models import Plan


@pytest.mark.parametrize(
    "change",
    [
        "duplicate",
        "case_duplicate",
        "unknown",
        "cycle",
        "self",
        "duplicate_dependency",
        "reserved",
        "traversal",
        "nan",
        "zero",
        "extra",
        "provider",
    ],
)
def test_plan_rejects_invalid_dag_and_inputs(plan, change):
    data = plan.model_dump()
    if change == "duplicate":
        data["jobs"][1]["id"] = "intro"
    elif change == "case_duplicate":
        data["jobs"][1]["id"] = "INTRO"
    elif change == "unknown":
        data["jobs"][0]["depends_on"] = ["missing"]
    elif change == "cycle":
        data["jobs"][0]["depends_on"] = ["conclusion"]
    elif change == "self":
        data["jobs"][0]["depends_on"] = ["intro"]
    elif change == "duplicate_dependency":
        data["jobs"][2]["depends_on"] = ["intro", "intro"]
    elif change == "reserved":
        data["task_id"] = "CON.txt"
    elif change == "traversal":
        data["task_id"] = "../outside"
    elif change == "nan":
        data["jobs"][0]["timeout"] = float("nan")
    elif change == "zero":
        data["jobs"][0]["timeout"] = 0
    elif change == "extra":
        data["unexpected"] = True
    elif change == "provider":
        data["jobs"][0]["provider"] = "other"
    with pytest.raises(ValidationError):
        Plan.model_validate(data)


def test_unordered_acyclic_plan_is_valid(plan):
    data = plan.model_dump()
    data["jobs"].reverse()
    assert Plan.model_validate(data).jobs[0].id == "conclusion"
