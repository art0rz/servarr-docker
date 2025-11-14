"""Rich-based progress helper for console workflows."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, Iterable, Optional

from rich.console import Console
from rich.live import Live
from rich.table import Table


@dataclass
class ProgressStep:
    key: str
    label: str
    details: str = "Waiting"
    status: str = "pending"  # pending, running, done, skipped, failed
    style_map: Dict[str, str] = field(default_factory=lambda: {
        "pending": "dim",
        "running": "cyan",
        "done": "green",
        "skipped": "yellow",
        "failed": "red",
    })

    def render_row(self) -> tuple[str, str, str]:
        style = self.style_map.get(self.status, "white")
        return (
            self.label,
            f"[{style}]{self.status.capitalize()}[/{style}]",
            self.details,
        )


class ProgressTracker:
    """Controls a Rich Live table showing step-by-step progress."""

    def __init__(self, title: str, steps: Iterable[ProgressStep], console: Optional[Console] = None) -> None:
        self.title = title
        self.console = console or Console()
        self.steps: "OrderedDict[str, ProgressStep]" = OrderedDict((step.key, step) for step in steps)
        self._live: Optional[Live] = None

    def __enter__(self) -> "ProgressTracker":
        self._live = Live(self._render_table(), refresh_per_second=4, console=self.console)
        self._live.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._live:
            self._live.__exit__(exc_type, exc, tb)
            self._live = None

    def update(self, key: str, *, status: Optional[str] = None, details: Optional[str] = None) -> None:
        step = self.steps.get(key)
        if not step:
            return
        if status:
            step.status = status
        if details is not None:
            step.details = details
        self._refresh()

    def _refresh(self) -> None:
        if self._live:
            self._live.update(self._render_table())

    def _render_table(self) -> Table:
        table = Table(title=self.title)
        table.add_column("Step", style="bold")
        table.add_column("Status")
        table.add_column("Details")
        for step in self.steps.values():
            table.add_row(*step.render_row())
        return table
