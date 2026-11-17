"""Validate editor data and assemble artifacts, without evaluating any source."""

from __future__ import annotations

import re
from pathlib import Path

import nbformat

from .files import atomic_text
from .models import Cell, CellDocument

CELL_INSTRUCTION = (
    'Return ONLY a JSON object {"cells":[{"cell_type":"markdown|code","source":"..."}]}. '
    "Use one of markdown or code as each cell_type. Source must be a string. "
    "Include at least one cell. Do not include outputs, execution counts or extra keys. "
    "The consumer will assemble a notebook without executing the code."
)


def parse_cells(raw: str) -> CellDocument:
    text = raw.strip()
    fence = re.fullmatch(r"```(?:json)?\s*\n(.*?)\n```", text, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        text = fence.group(1)
    return CellDocument.model_validate_json(text)


def write_artifact(document: CellDocument, path: Path, output_format: str) -> None:
    if output_format == "ipynb":
        cells = [
            nbformat.v4.new_markdown_cell(cell.source)
            if cell.cell_type == "markdown"
            else nbformat.v4.new_code_cell(cell.source, execution_count=None, outputs=[])
            for cell in document.cells
        ]
        notebook = nbformat.v4.new_notebook(
            cells=cells,
            metadata={"language_info": {"name": "python"}},
        )
        nbformat.validate(notebook)
        atomic_text(path, nbformat.writes(notebook))
    elif output_format == "markdown":
        sections = []
        for cell in document.cells:
            # Longer delimiters preserve source containing triple backticks.
            fence = "`" * max(
                3, max((len(x) + 1 for x in re.findall(r"`+", cell.source)), default=3)
            )
            sections.append(
                cell.source
                if cell.cell_type == "markdown"
                else f"{fence}python\n{cell.source}\n{fence}"
            )
        atomic_text(path, "\n\n".join(sections) + "\n")
    else:
        raise ValueError("unsupported output format")


def author_document(outputs: list[tuple[str, str]]) -> CellDocument:
    """Without an editor, retain author prose as markdown, never guess code boundaries."""
    return CellDocument(
        cells=[
            Cell(cell_type="markdown", source=f"## {job_id}\n\n{text}") for job_id, text in outputs
        ]
    )
