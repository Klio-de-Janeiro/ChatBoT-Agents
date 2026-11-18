"""The public plan and native result contracts."""

from __future__ import annotations

import re
from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    field_validator,
    model_validator,
)

from .providers import saved_chat_url, validate_provider

Provider = Annotated[str, AfterValidator(validate_provider)]
Operation = Literal["ask", "open"]
TaskKind = Literal["plan", "ask", "open"]
OPEN_PROMPT = "MCA_INTERNAL_OPEN_CONVERSATION_WITHOUT_SUBMISSION"
Timeout = Annotated[float, Field(gt=0, le=3600, allow_inf_nan=False)]
Identifier = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")]
ResultStatus = Literal["completed", "failed", "timeout", "needs_user_action", "unknown"]
TERMINAL = frozenset({"completed", "failed", "timeout", "needs_user_action", "unknown"})


def nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("value must contain non-whitespace text")
    return value


Nonblank = Annotated[str, Field(min_length=1), AfterValidator(nonblank)]
ModeName = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,31}$", strict=True)]
ModeString = Annotated[
    str, Field(min_length=1, max_length=100, strict=True), AfterValidator(nonblank)
]
ModeValue = StrictBool | ModeString
Modes = Annotated[dict[ModeName, ModeValue], Field(max_length=16)]


def check_mode_conflicts(provider: Provider, modes: dict[str, ModeValue]) -> None:
    if provider == "qwen" and "think" in modes and "reasoning" in modes:
        raise ValueError("Qwen modes think and reasoning are mutually exclusive")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def safe_component(value: str) -> str:
    # Windows device names remain reserved even with an extension.
    stem = value.split(".")[0].upper()
    if (
        value.endswith(".")
        or stem in {"CON", "PRN", "AUX", "NUL"}
        or re.fullmatch(r"(?:COM|LPT)[0-9]", stem)
    ):
        raise ValueError("identifier is a reserved Windows path component")
    return value


class JobPlan(StrictModel):
    id: Identifier
    provider: Provider
    prompt: Nonblank
    depends_on: list[Identifier] = Field(default_factory=list)
    timeout: Timeout = 180
    operation: Operation = "ask"
    modes: Modes = Field(default_factory=dict)
    chat_url: str | None = None

    _safe_id = field_validator("id")(safe_component)

    @model_validator(mode="after")
    def validate_modes(self) -> Self:
        check_mode_conflicts(self.provider, self.modes)
        if self.chat_url is not None:
            url = saved_chat_url(self.provider, self.chat_url)
            if url is None:
                raise ValueError("chat_url must point to a saved chat of the selected provider")
            self.chat_url = url
        return self


class EditorPlan(StrictModel):
    provider: Provider
    prompt: Nonblank
    timeout: Timeout = 300
    modes: Modes = Field(default_factory=dict)
    chat_url: str | None = None

    @model_validator(mode="after")
    def validate_modes(self) -> Self:
        check_mode_conflicts(self.provider, self.modes)
        if self.chat_url is not None:
            url = saved_chat_url(self.provider, self.chat_url)
            if url is None:
                raise ValueError("chat_url must point to a saved chat of the selected provider")
            self.chat_url = url
        return self


OutputFormat = Literal["txt", "md", "markdown", "ipynb", "json", "html"]
OUTPUT_EXTENSIONS: dict[OutputFormat, str] = {
    "txt": ".txt",
    "md": ".md",
    "markdown": ".md",
    "ipynb": ".ipynb",
    "json": ".json",
    "html": ".html",
}


class OutputPlan(StrictModel):
    format: OutputFormat
    path: Nonblank


class Plan(StrictModel):
    task_id: Identifier
    objective: Nonblank
    jobs: list[JobPlan] = Field(min_length=1, max_length=200)
    editor: EditorPlan | None = None
    output: OutputPlan

    _safe_id = field_validator("task_id")(safe_component)

    @model_validator(mode="after")
    def validate_dag(self) -> Self:
        ids = [job.id for job in self.jobs]
        if len({value.casefold() for value in ids}) != len(ids):
            raise ValueError("duplicate job IDs")
        graph = {job.id: job.depends_on for job in self.jobs}
        for job in self.jobs:
            if len(set(job.depends_on)) != len(job.depends_on):
                raise ValueError(f"duplicate dependencies in job {job.id}")
            if set(job.depends_on) - graph.keys():
                raise ValueError(f"unknown dependency in job {job.id}")
        done: set[str] = set()
        while len(done) < len(graph):
            ready = {key for key, deps in graph.items() if key not in done and set(deps) <= done}
            if not ready:
                raise ValueError("job dependencies contain a cycle")
            done.update(ready)
        return self


class Cell(StrictModel):
    cell_type: Literal["markdown", "code"]
    source: str


class CellDocument(StrictModel):
    cells: list[Cell] = Field(min_length=1, max_length=10000)


class NativeResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: Literal["result"]
    request_id: str = Field(min_length=1, max_length=80)
    status: ResultStatus
    text: str = ""
    conversation_url: str | None = None
    error: str | None = None
