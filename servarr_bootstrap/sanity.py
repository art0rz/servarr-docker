"""Sanity scan routines for the Servarr bootstrapper."""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Sequence

from rich.console import Console
from rich.table import Table

from .config import RuntimeContext

LOGGER = logging.getLogger("servarr.bootstrap.sanity")
ConsoleRenderable = Callable[[Table], None]
REQUIRED_CONFIG_DIRS: Sequence[str] = (
    "bazarr",
    "cross-seed",
    "prowlarr",
    "qbittorrent",
    "radarr",
    "recyclarr",
    "sonarr",
)
REQUIRED_ENV_KEYS: Sequence[str] = ("MEDIA_DIR", "PUID", "PGID")


class SanityStatus(str, Enum):
    OK = "ok"
    WARN = "warn"
    ERROR = "error"


@dataclass(frozen=True)
class SanityItem:
    name: str
    status: SanityStatus
    detail: str
    remediation: str | None = None


@dataclass(frozen=True)
class SanityReport:
    items: List[SanityItem]

    @property
    def counts(self) -> Dict[SanityStatus, int]:
        summary: Dict[SanityStatus, int] = {SanityStatus.OK: 0, SanityStatus.WARN: 0, SanityStatus.ERROR: 0}
        for item in self.items:
            summary[item.status] += 1
        return summary

    @property
    def has_errors(self) -> bool:
        return any(item.status == SanityStatus.ERROR for item in self.items)


def run_sanity_scan(root_dir: Path, runtime: RuntimeContext) -> SanityReport:
    """Execute sanity checks and collect results."""
    items: List[SanityItem] = []
    items.append(_check_docker_cli())
    items.append(_check_compose_file(root_dir))
    items.append(_check_config_directories(root_dir / "config"))
    items.append(_check_env_settings(runtime))
    return SanityReport(items=[item for item in items if item is not None])


def _check_docker_cli() -> SanityItem:
    docker_path = shutil.which("docker")
    if not docker_path:
        return SanityItem(
            name="Docker CLI",
            status=SanityStatus.ERROR,
            detail="`docker` executable not found in PATH.",
            remediation="Install Docker and ensure the CLI is available.",
        )
    return SanityItem(
        name="Docker CLI",
        status=SanityStatus.OK,
        detail=f"Found docker executable at {docker_path}",
    )


def _check_compose_file(root_dir: Path) -> SanityItem:
    compose_file = root_dir / "docker-compose.yml"
    if compose_file.exists():
        return SanityItem(
            name="docker-compose.yml",
            status=SanityStatus.OK,
            detail=f"Found compose file at {compose_file}",
        )
    return SanityItem(
        name="docker-compose.yml",
        status=SanityStatus.ERROR,
        detail="Missing docker-compose.yml in repo root.",
        remediation="Restore the compose file before running the bootstrapper.",
    )


def _check_config_directories(config_root: Path) -> SanityItem:
    missing: List[str] = []
    for directory in REQUIRED_CONFIG_DIRS:
        if not (config_root / directory).exists():
            missing.append(directory)
    if not missing:
        return SanityItem(
            name="Config directories",
            status=SanityStatus.OK,
            detail=f"All required directories exist under {config_root}",
        )
    return SanityItem(
        name="Config directories",
        status=SanityStatus.WARN,
        detail=f"Missing directories: {', '.join(missing)}",
        remediation="They will be created automatically, but ensure storage paths are correct.",
    )


def _check_env_settings(runtime: RuntimeContext) -> SanityItem:
    env = runtime.env.merged
    missing = [key for key in REQUIRED_ENV_KEYS if not env.get(key)]
    if missing:
        return SanityItem(
            name="Environment values",
            status=SanityStatus.WARN,
            detail=f"Unset required env keys: {', '.join(missing)}",
            remediation="Populate the values in .env or export them before running non-interactively.",
        )
    return SanityItem(
        name="Environment values",
        status=SanityStatus.OK,
        detail="Core environment variables are set.",
    )


def render_report(report: SanityReport, console: Console) -> None:
    """Render sanity findings to the terminal using Rich."""
    table = Table(title="Sanity Scan", show_lines=False)
    table.add_column("Check", style="bold")
    table.add_column("Status")
    table.add_column("Details")

    status_styles = {
        SanityStatus.OK: "[green]OK[/green]",
        SanityStatus.WARN: "[yellow]WARN[/yellow]",
        SanityStatus.ERROR: "[red]ERROR[/red]",
    }

    for item in report.items:
        status_text = status_styles[item.status]
        detail = item.detail
        if item.remediation:
            detail = f"{detail}\n[i]{item.remediation}[/i]"
        table.add_row(item.name, status_text, detail)

    console.print(table)
    summary = report.counts
    console.print(
        f"[bold]Summary:[/bold] "
        f"OK={summary[SanityStatus.OK]}, "
        f"WARN={summary[SanityStatus.WARN]}, "
        f"ERROR={summary[SanityStatus.ERROR]}",
    )

    if report.has_errors:
        console.print("[red]Resolve the errors above before continuing.[/red]")
