import pytest
from pydantic import TypeAdapter, ValidationError

from multi_chat_agent.models import EditorPlan, JobPlan, Modes
from multi_chat_agent.modes import parse_modes


def test_omitted_modes_and_operation_preserve_ask_defaults():
    job = JobPlan(id="one", provider="qwen", prompt="hello")
    assert job.operation == "ask"
    assert job.modes == {}
    assert EditorPlan(provider="deepseek", prompt="edit").modes == {}


def test_cli_modes_parse_boolean_flags_and_string_values_preserving_equals():
    assert parse_modes(think=["on"], search=["off"], extra=["model=qwen-plus", "option=a=b"]) == {
        "think": True,
        "search": False,
        "model": "qwen-plus",
        "option": "a=b",
    }
    assert parse_modes(think=[], search=[], extra=["think=on", "search=off"]) == {
        "think": True,
        "search": False,
    }
    assert parse_modes(think=[], search=[], extra=[]) == {}


@pytest.mark.parametrize(
    "values",
    [
        {"think": ["on", "off"], "search": [], "extra": []},
        {"think": ["on"], "search": [], "extra": ["think=off"]},
        {"think": [], "search": [], "extra": ["model=one", "model=two"]},
    ],
)
def test_conflicting_duplicates_are_rejected(values):
    with pytest.raises(ValueError, match="conflicting duplicate"):
        parse_modes(**values)


def test_identical_duplicates_are_allowed():
    assert parse_modes(think=["on", "on"], search=[], extra=["think=on"]) == {"think": True}


@pytest.mark.parametrize(
    "modes",
    [
        {"Upper": True},
        {"_lower": True},
        {"1mode": True},
        {"space name": True},
        {"a" * 33: True},
        {"mode": ""},
        {"mode": " \t"},
        {"mode": "x" * 101},
        {f"m{number}": True for number in range(17)},
        {"mode": 1},
        {"mode": 0},
        {"mode": 0.5},
        {"mode": None},
        {"mode": []},
        {"mode": {}},
    ],
)
def test_invalid_modes_rejected_in_jobs_and_editors(modes):
    for model, arguments in (
        (JobPlan, {"id": "one", "provider": "qwen", "prompt": "hello"}),
        (EditorPlan, {"provider": "deepseek", "prompt": "edit"}),
    ):
        with pytest.raises(ValidationError):
            model(**arguments, modes=modes)


def test_mode_boundaries_and_literal_types_are_preserved():
    modes = {f"m{number}": "x" * 100 for number in range(15)}
    modes["a" * 32] = False
    assert TypeAdapter(Modes).validate_python(modes) == modes
    assert TypeAdapter(Modes).validate_python({"n": "false"}) == {"n": "false"}


@pytest.mark.parametrize("model", [JobPlan, EditorPlan])
def test_qwen_think_and_reasoning_are_mutually_exclusive(model):
    arguments = {
        "provider": "qwen",
        "prompt": "request",
        "modes": {"think": False, "reasoning": "auto"},
    }
    if model is JobPlan:
        arguments["id"] = "one"
    with pytest.raises(ValidationError, match="mutually exclusive"):
        model(**arguments)


@pytest.mark.parametrize("reasoning", ["auto", "thinking", "fast"])
def test_qwen_reasoning_string_values_pass_through(reasoning):
    job = JobPlan(id="one", provider="qwen", prompt="request", modes={"reasoning": reasoning})
    assert job.modes == {"reasoning": reasoning}


@pytest.mark.parametrize("setting", ["think", "=on", "think=", "Think=on", "x=   "])
def test_invalid_generic_cli_settings_are_rejected(setting):
    with pytest.raises(ValueError):
        parse_modes(think=[], search=[], extra=[setting])
