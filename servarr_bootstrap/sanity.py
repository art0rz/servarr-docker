"""Sanity scan routines for the Servarr bootstrapper."""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Dict, List, Sequence

import requests
from rich.console import Console
from rich.table import Table

from .config import RuntimeContext
from .env_setup import default_env_values

LOGGER = logging.getLogger("servarr.bootstrap.sanity")
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


@dataclass(frozen=True)
class ServiceProbe:
    name: str
    env_port_key: str
    default_port: int
    path: str = "/"


SERVICE_PROBES: Sequence[ServiceProbe] = (
    ServiceProbe("Prowlarr", "PROWLARR_PORT", 9696),
    ServiceProbe("Sonarr", "SONARR_PORT", 8989),
    ServiceProbe("Radarr", "RADARR_PORT", 7878),
    ServiceProbe("Bazarr", "BAZARR_PORT", 6767),
    ServiceProbe("qBittorrent", "QBIT_WEBUI", 8080),
)


def run_sanity_scan(root_dir: Path, runtime: RuntimeContext) -> SanityReport:
    """Execute sanity checks and collect results."""
    items: List[SanityItem] = []
    items.append(_check_docker_cli())
    items.append(_check_docker_daemon())
    items.append(_check_compose_file(root_dir))
    items.append(_check_compose_services(root_dir, runtime))
    items.append(_check_config_directories(root_dir / "config"))
    items.append(_check_env_settings(runtime))
    items.extend(_check_service_apis(runtime))
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


def _check_docker_daemon() -> SanityItem:
    try:
        _run_subprocess(("docker", "info"))
    except (subprocess.SubprocessError, FileNotFoundError) as exc:
        return SanityItem(
            name="Docker daemon",
            status=SanityStatus.ERROR,
            detail="Unable to communicate with Docker daemon.",
            remediation=f"Ensure Docker is running and accessible. ({exc})",
        )
    return SanityItem(
        name="Docker daemon",
        status=SanityStatus.OK,
        detail="Docker daemon is reachable.",
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


def _check_compose_services(root_dir: Path, runtime: RuntimeContext) -> SanityItem:
    compose_env = _compose_env(runtime)
    services_cmd = ("docker", "compose", "--project-directory", str(root_dir), "config", "--services")
    try:
        services_result = _run_subprocess(services_cmd, env=compose_env)
        services = [line.strip() for line in services_result.stdout.splitlines() if line.strip()]
    except subprocess.SubprocessError as exc:
        return SanityItem(
            name="Compose services",
            status=SanityStatus.WARN,
            detail="Unable to list services via `docker compose config --services`.",
            remediation=f"Check docker compose configuration ({exc}).",
        )

    if not services:
        return SanityItem(
            name="Compose services",
            status=SanityStatus.WARN,
            detail="No services defined in docker compose file.",
            remediation="Ensure docker-compose.yml declares the Servarr stack.",
        )

    ps_cmd = ("docker", "compose", "--project-directory", str(root_dir), "ps", "--format", "{{json .}}")
    try:
        ps_result = _run_subprocess(ps_cmd, env=compose_env)
        container_rows: List[dict] = []
        for idx, line in enumerate(ps_result.stdout.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as exc:
                return SanityItem(
                    name="Compose services",
                    status=SanityStatus.WARN,
                    detail=f"Failed to parse docker compose status output on line {idx}: {exc}",
                    remediation="Ensure your Docker Compose version supports templated --format output.",
                )
            if isinstance(parsed, dict):
                container_rows.append(parsed)
    except subprocess.SubprocessError as exc:
        return SanityItem(
            name="Compose services",
            status=SanityStatus.WARN,
            detail=f"Unable to inspect container status ({exc}).",
            remediation="Run `docker compose up -d` before continuing.",
        )
    running = sum(1 for row in container_rows if isinstance(row, dict) and row.get("State") == "running")
    total_defined = len(services)
    detail = f"{running}/{total_defined} services running."
    if running == total_defined and total_defined > 0:
        return SanityItem(name="Compose services", status=SanityStatus.OK, detail=detail)

    return SanityItem(
        name="Compose services",
        status=SanityStatus.WARN,
        detail=detail,
        remediation="Start the stack with `docker compose up -d` to ensure APIs are reachable.",
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


def _check_service_apis(runtime: RuntimeContext) -> List[SanityItem]:
    env = runtime.env.merged
    items: List[SanityItem] = []
    for probe in SERVICE_PROBES:
        port_value = env.get(probe.env_port_key)
        try:
            port = int(port_value) if port_value else probe.default_port
        except ValueError:
            items.append(
                SanityItem(
                    name=f"{probe.name} API",
                    status=SanityStatus.WARN,
                    detail=f"Invalid port value '{port_value}' for {probe.env_port_key}.",
                    remediation="Update the port value in .env or environment variables.",
                )
            )
            continue

        url = f"http://127.0.0.1:{port}{probe.path}"
        try:
            response = requests.get(url, timeout=2)
            if 200 <= response.status_code < 400:
                items.append(
                    SanityItem(
                        name=f"{probe.name} API",
                        status=SanityStatus.OK,
                        detail=f"Reachable at {url}",
                    )
                )
            else:
                items.append(
                    SanityItem(
                        name=f"{probe.name} API",
                        status=SanityStatus.WARN,
                        detail=f"Received status {response.status_code} from {url}",
                        remediation="Ensure the container is running and not blocked by firewalls.",
                    )
                )
        except requests.RequestException as exc:
            items.append(
                SanityItem(
                    name=f"{probe.name} API",
                    status=SanityStatus.WARN,
                    detail=f"Unable to reach {url}: {exc}",
                    remediation="Start the container or verify port bindings.",
                )
            )
    return items


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


def _run_subprocess(cmd: Sequence[str], env: Dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    LOGGER.debug("Executing command: %s", " ".join(cmd))
    return subprocess.run(cmd, check=True, capture_output=True, text=True, env=env)


def _compose_env(runtime: RuntimeContext) -> Dict[str, str]:
    env = dict(runtime.env.merged)
    for key, value in default_env_values().items():
        env.setdefault(key, value)
    return env
