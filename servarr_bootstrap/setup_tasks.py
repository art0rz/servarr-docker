"""Container setup tasks: directories, permissions, and docker compose operations."""

from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional, Sequence

import requests
from rich.console import Console
from rich.live import Live
from rich.table import Table

from .cleaner import CommandRunner, run_command
from .config import RuntimeContext
from .sanity import SERVICE_PROBES, ServiceProbe

LOGGER = logging.getLogger("servarr.bootstrap.setup")
CONFIG_DIRECTORIES = (
    "qbittorrent",
    "prowlarr",
    "sonarr",
    "radarr",
    "bazarr",
    "cross-seed",
    "recyclarr",
)
MEDIA_DIRECTORIES = (
    "downloads/incomplete",
    "downloads/completed",
    "downloads/cross-seeds",
    "tv",
    "movies",
)


class SetupError(RuntimeError):
    """Raised when setup actions cannot be completed."""


@dataclass(frozen=True)
class SetupPlan:
    create_config_dirs: bool = True
    create_media_dirs: bool = True
    fix_permissions: bool = True
    start_services: bool = True
    wait_for_services: bool = True


def perform_setup(
    root_dir: Path,
    runtime: RuntimeContext,
    console: Console,
    plan: SetupPlan | None = None,
    *,
    command_runner: CommandRunner | None = None,
) -> None:
    """Execute container setup tasks."""

    plan = plan or SetupPlan()
    dry_run = runtime.options.dry_run
    env = runtime.env.merged
    config_root = root_dir / "config"

    if plan.create_config_dirs:
        _ensure_config_dirs(config_root, console, dry_run)

    if plan.create_media_dirs or plan.fix_permissions:
        media_dir_value = env.get("MEDIA_DIR")
        if not media_dir_value:
            raise SetupError("MEDIA_DIR is not set; cannot create media directories.")
        media_dir = Path(media_dir_value)
        puid = env.get("PUID")
        pgid = env.get("PGID")
        if plan.create_media_dirs:
            _ensure_media_dirs(media_dir, console, dry_run)
        if plan.fix_permissions:
            _apply_permissions(media_dir, puid, pgid, console, dry_run)
            _apply_config_permissions(config_root, puid, pgid, console, dry_run)

    if plan.start_services:
        use_vpn_value = env.get("USE_VPN", "true").strip().lower()
        use_vpn = use_vpn_value not in {"false", "0", "no", "off"}
        _start_services(
            root_dir,
            use_vpn,
            dry_run,
            command_runner,
            console,
            runtime=runtime,
            wait=plan.wait_for_services,
        )


def _ensure_config_dirs(config_root: Path, console: Console, dry_run: bool) -> None:
    for directory in CONFIG_DIRECTORIES:
        path = config_root / directory
        if path.exists():
            continue
        LOGGER.info("Creating config directory %s", path)
        console.print(f"[cyan]Config:[/] {'[dry-run] ' if dry_run else ''}Creating {path}")
        if dry_run:
            continue
        path.mkdir(parents=True, exist_ok=True)


def _ensure_media_dirs(media_dir: Path, console: Console, dry_run: bool) -> None:
    for relative in MEDIA_DIRECTORIES:
        target = media_dir / relative
        if target.exists():
            continue
        LOGGER.info("Creating media directory %s", target)
        console.print(f"[cyan]Media:[/] {'[dry-run] ' if dry_run else ''}Creating {target}")
        if dry_run:
            continue
        target.mkdir(parents=True, exist_ok=True)


def _apply_permissions(media_dir: Path, puid: Optional[str], pgid: Optional[str], console: Console, dry_run: bool) -> None:
    if not puid or not pgid:
        console.print("[yellow]Skipping permission fix: PUID/PGID not set.[/yellow]")
        LOGGER.warning("Cannot fix permissions without PUID/PGID values.")
        return
    try:
        uid = int(puid)
        gid = int(pgid)
    except ValueError as exc:
        raise SetupError(f"Invalid PUID/PGID values: {puid}/{pgid}") from exc

    console.print(f"[cyan]Permissions:[/] {'[dry-run] ' if dry_run else ''}Applying ownership {uid}:{gid} to {media_dir}")
    LOGGER.info("Applying ownership %s:%s to %s", uid, gid, media_dir)
    if dry_run:
        return

    for target in _iter_permission_targets(media_dir):
        try:
            os.chown(target, uid, gid)
        except PermissionError:
            LOGGER.warning("Permission denied while chowning %s. Run manually with sudo if needed.", target)
        except FileNotFoundError:
            continue


def _apply_config_permissions(config_root: Path, puid: Optional[str], pgid: Optional[str], console: Console, dry_run: bool) -> None:
    if not puid or not pgid:
        return
    try:
        uid = int(puid)
        gid = int(pgid)
    except ValueError:
        return
    console.print(f"[cyan]Config:[/] {'[dry-run] ' if dry_run else ''}Ensuring ownership {uid}:{gid}")
    if dry_run:
        return
    try:
        os.chown(config_root, uid, gid)
    except PermissionError:
        LOGGER.warning("Permission denied while chowning %s. Run manually with sudo if needed.", config_root)
    for root, dirs, files in os.walk(config_root):
        for name in dirs + files:
            path = Path(root) / name
            try:
                os.chown(path, uid, gid)
            except PermissionError:
                LOGGER.warning("Permission denied while chowning %s. Run manually with sudo if needed.", path)


def _iter_permission_targets(media_dir: Path) -> Iterable[Path]:
    yield media_dir
    for root, dirs, _files in os.walk(media_dir):
        for entry in dirs:
            yield Path(root) / entry


def _start_services(
    root_dir: Path,
    use_vpn: bool,
    dry_run: bool,
    command_runner: CommandRunner | None,
    console: Console,
    *,
    runtime: RuntimeContext,
    wait: bool,
) -> None:
    profile = "vpn" if use_vpn else "no-vpn"
    logger_prefix = "VPN" if use_vpn else "no-VPN"
    console.print(f"[cyan]Docker:[/] {'[dry-run] ' if dry_run else ''}Starting services with profile '{profile}'")

    def run(cmd: list[str], env_profile: Optional[str] = None) -> None:
        env = os.environ.copy()
        if env_profile:
            env["COMPOSE_PROFILES"] = env_profile
        run_command(cmd, cwd=root_dir, dry_run=dry_run, runner=command_runner, env=env)

    # Stop existing containers for both profiles to avoid conflicts.
    for profile_name in ("vpn", "no-vpn"):
        run(["docker", "compose", "down"], env_profile=profile_name)

    run(["docker", "compose", "down", "--remove-orphans"], env_profile=None)
    run(["docker", "compose", "build", "health-server"], env_profile=None)

    run(["docker", "compose", "pull"], env_profile=profile)
    run(["docker", "compose", "up", "-d"], env_profile=profile)
    LOGGER.info("Docker services started with %s profile", logger_prefix)

    if wait and not dry_run:
        _wait_for_services(runtime, console)


def _wait_for_services(runtime: RuntimeContext, console: Console) -> None:
    env = runtime.env.merged
    statuses: Dict[str, str] = {probe.name: "waiting" for probe in SERVICE_PROBES}
    details: Dict[str, str] = {probe.name: "Waiting for response" for probe in SERVICE_PROBES}

    def render_table() -> Table:
        table = Table(title="Service Readiness", show_lines=False)
        table.add_column("Service", style="bold")
        table.add_column("Status")
        table.add_column("Details")
        for probe in SERVICE_PROBES:
            status = statuses[probe.name]
            style = "yellow"
            if status == "ready":
                style = "green"
            elif status == "error":
                style = "red"
            table.add_row(probe.name, f"[{style}]{status}[/]", details[probe.name])
        return table

    def check_probe(probe: ServiceProbe) -> tuple[str, str, str]:
        port_value = env.get(probe.env_port_key)
        try:
            port = int(port_value) if port_value else probe.default_port
        except ValueError:
            return probe.name, "error", f"Invalid port '{port_value}'"

        url = f"http://127.0.0.1:{port}{probe.path}"
        for attempt in range(1, 11):
            try:
                response = requests.get(url, timeout=3)
                if 200 <= response.status_code < 400:
                    return probe.name, "ready", f"Reachable at {url}"
            except requests.RequestException as exc:
                LOGGER.debug("Attempt %s failed for %s: %s", attempt, url, exc)
            time.sleep(3)
        return probe.name, "error", "No response after multiple attempts"

    with Live(render_table(), refresh_per_second=4, console=console) as live:
        with ThreadPoolExecutor(max_workers=len(SERVICE_PROBES)) as executor:
            futures = {executor.submit(check_probe, probe): probe for probe in SERVICE_PROBES}
            for future in as_completed(futures):
                name, status, detail = future.result()
                statuses[name] = status
                details[name] = detail
                live.update(render_table())
