"""Container setup tasks: directories, permissions, and docker compose operations."""

from __future__ import annotations

import logging
import os
import stat
import subprocess
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

import requests
from rich.console import Console
from rich.live import Live
from rich.table import Table

from .cleaner import CommandRunner, run_command
from .config import RuntimeContext
from .sanity import SERVICE_PROBES, ServiceProbe
from .utils.progress import ProgressStep, ProgressTracker

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
START_STATUS_STYLES = {
    "pending": "dim",
    "running": "cyan",
    "done": "green",
    "skipped": "yellow",
    "failed": "red",
}


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
    created: List[str] = []
    for directory in CONFIG_DIRECTORIES:
        path = config_root / directory
        if path.exists():
            continue
        LOGGER.info("Creating config directory %s", path)
        if not dry_run:
            path.mkdir(parents=True, exist_ok=True)
        created.append(str(path))
    if created:
        count = len(created)
        console.print(f"[cyan]Config:[/] {'[dry-run] ' if dry_run else ''}Created {count} director{'ies' if count != 1 else 'y'}")
        LOGGER.debug("Created config directories: %s", ", ".join(created))


def _ensure_media_dirs(media_dir: Path, console: Console, dry_run: bool) -> None:
    created: List[str] = []
    for relative in MEDIA_DIRECTORIES:
        target = media_dir / relative
        if target.exists():
            continue
        LOGGER.info("Creating media directory %s", target)
        if not dry_run:
            target.mkdir(parents=True, exist_ok=True)
        created.append(str(target))
    if created:
        count = len(created)
        console.print(f"[cyan]Media:[/] {'[dry-run] ' if dry_run else ''}Created {count} director{'ies' if count != 1 else 'y'}")
        LOGGER.debug("Created media directories: %s", ", ".join(created))


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

    skipped_roots: List[Path] = []

    for target in _iter_permission_targets(media_dir):
        _set_owner_and_mode(target, uid, gid, console, skipped_roots)


def _apply_config_permissions(config_root: Path, puid: Optional[str], pgid: Optional[str], console: Console, dry_run: bool) -> None:
    if not puid or not pgid:
        return
    try:
        uid = int(puid)
        gid = int(pgid)
    except ValueError:
        return
    if dry_run:
        return
    LOGGER.info("Ensuring config ownership %s:%s", uid, gid)
    skipped: List[Path] = []
    try:
        for root, dirs, files in os.walk(config_root):
            root_path = Path(root)
            _set_owner_and_mode(root_path, uid, gid, console, skipped)
            for name in files:
                _set_owner_and_mode(root_path / name, uid, gid, console, skipped)
    except PermissionError:
        if not _chown_with_docker(config_root, uid, gid):
            LOGGER.warning(
                "Permission denied while chowning %s. Consider running `docker run --rm -v %s:/target"
                " alpine chown -R %s:%s /target` manually.",
                config_root,
                config_root,
                uid,
                gid,
            )
        else:
            _set_rw_recursive(config_root)
            return
    _set_rw_recursive(config_root)


def _chown_with_docker(path: Path, uid: int, gid: int) -> bool:
    try:
        subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "-v",
                f"{path}:/target",
                "alpine:3.20",
                "sh",
                "-c",
                f"chown -R {uid}:{gid} /target",
            ],
            check=True,
            capture_output=True,
        )
        LOGGER.info("Adjusted ownership of %s via docker helper", path)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def _iter_permission_targets(media_dir: Path) -> Iterable[Path]:
    yield media_dir
    for root, dirs, _files in os.walk(media_dir):
        for entry in dirs:
            yield Path(root) / entry


def _set_owner_and_mode(
    path: Path,
    uid: int,
    gid: int,
    console: Console | None,
    skipped: List[Path],
) -> None:
    try:
        os.chown(path, uid, gid)
    except PermissionError:
        _record_skip(path, skipped, console, hint=f"sudo chown -R {uid}:{gid} '{path}'")
        return
    except FileNotFoundError:
        return
    _ensure_rw_access(path, console, skipped)


def _record_skip(path: Path, skipped: List[Path], console: Console | None, hint: Optional[str] = None) -> None:
    candidate = path if path.is_dir() else path.parent
    for root in skipped:
        try:
            candidate.relative_to(root)
            return
        except ValueError:
            continue
    skipped.append(candidate)
    if console:
        message = f"[yellow]Permissions:[/] Skipping read-only path {candidate}"
        if hint:
            message += f" (run `{hint}` to fix)"
        console.print(message)
    LOGGER.debug("Permission denied while updating %s; skipping. Hint: %s", candidate, hint)


def _ensure_rw_access(path: Path, console: Console | None, skipped: List[Path]) -> None:
    try:
        mode = path.stat().st_mode
    except FileNotFoundError:
        return
    desired = mode | (0o770 if path.is_dir() else 0o660)
    if path.is_dir():
        desired |= 0o110
    try:
        os.chmod(path, desired)
    except PermissionError:
        _record_skip(path, skipped, console, hint=f"sudo chmod {oct(desired)} '{path}'")


def _set_rw_recursive(root: Path) -> None:
    _ensure_rw_access(root, None, [])
    for current_root, dirs, files in os.walk(root):
        base = Path(current_root)
        for name in dirs + files:
            target = base / name
            try:
                mode = target.stat().st_mode
            except FileNotFoundError:
                continue
            desired = mode | (0o770 if target.is_dir() else 0o660)
            if target.is_dir():
                desired |= 0o110
            try:
                os.chmod(target, desired)
            except PermissionError:
                continue


def _init_start_steps(profile: str) -> OrderedDict[str, Dict[str, str]]:
    return OrderedDict(
        [
            ("down_vpn", {"label": "Stop VPN profile", "status": "pending", "details": "Waiting"}),
            ("down_no_vpn", {"label": "Stop no-vpn profile", "status": "pending", "details": "Waiting"}),
            ("down_orphans", {"label": "Remove orphans", "status": "pending", "details": "Waiting"}),
            ("build_health", {"label": "Build health service", "status": "pending", "details": "Waiting"}),
            ("pull_profile", {"label": f"Pull ({profile})", "status": "pending", "details": "Waiting"}),
            ("up_profile", {"label": f"Start ({profile})", "status": "pending", "details": "Waiting"}),
        ]
    )


def _render_start_table(steps: OrderedDict[str, Dict[str, str]]) -> Table:
    table = Table(title="Docker Progress")
    table.add_column("Step", style="bold")
    table.add_column("Status")
    table.add_column("Details")
    for data in steps.values():
        status = data["status"]
        color = START_STATUS_STYLES.get(status, "white")
        table.add_row(data["label"], f"[{color}]{status.capitalize()}[/{color}]", data["details"])
    return table


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

    def run(cmd: list[str], env_profile: Optional[str] = None) -> None:
        env = os.environ.copy()
        if env_profile:
            env["COMPOSE_PROFILES"] = env_profile
        run_command(cmd, cwd=root_dir, dry_run=dry_run, runner=command_runner, env=env)

    start_steps = [
        ProgressStep("down_vpn", "Stop VPN profile"),
        ProgressStep("down_no_vpn", "Stop no-VPN profile"),
        ProgressStep("down_orphans", "Remove orphans"),
        ProgressStep("build_health", "Build health service"),
        ProgressStep("pull_profile", f"Pull ({profile})"),
        ProgressStep("up_profile", f"Start ({profile})"),
    ]

    commands = [
        ("down_vpn", ["docker", "compose", "down"], "Stopping VPN profile", "vpn"),
        ("down_no_vpn", ["docker", "compose", "down"], "Stopping no-VPN profile", "no-vpn"),
        ("down_orphans", ["docker", "compose", "down", "--remove-orphans"], "Removing orphan containers", None),
        ("build_health", ["docker", "compose", "build", "health-server"], "Building health service", None),
        ("pull_profile", ["docker", "compose", "pull"], f"Pulling images for {profile}", profile),
        ("up_profile", ["docker", "compose", "up", "-d"], f"Starting services ({profile})", profile),
    ]

    if dry_run:
        console.print(f"[cyan]Docker:[/] [dry-run] Would execute compose workflow for '{profile}' profile")
        return

    with ProgressTracker("Docker Progress", start_steps, console=console) as tracker:
        for step_key, cmd, detail, env_profile in commands:
            tracker.update(step_key, status="running", details=detail)
            try:
                run(cmd, env_profile=env_profile)
            except Exception as exc:
                tracker.update(step_key, status="failed", details=str(exc))
                raise SetupError(f"Docker command failed ({' '.join(cmd)}): {exc}") from exc
            else:
                tracker.update(step_key, status="done", details="Completed")

    LOGGER.info("Docker services started with %s profile", logger_prefix)

    if wait and not dry_run:
        readiness = _wait_for_services(runtime, console)
        failures = {name: detail for name, (status, detail) in readiness.items() if status != "ready"}
        if failures:
            summary = "; ".join(f"{name}: {detail}" for name, detail in failures.items())
            raise SetupError(f"Service readiness failed: {summary}")


def _wait_for_services(runtime: RuntimeContext, console: Console) -> Dict[str, tuple[str, str]]:
    env = runtime.env.merged
    statuses: Dict[str, str] = {probe.name: "waiting" for probe in SERVICE_PROBES}
    attempt_counts: Dict[str, int] = {probe.name: 0 for probe in SERVICE_PROBES}
    details: Dict[str, str] = {probe.name: "Waiting for response" for probe in SERVICE_PROBES}
    max_attempts = 20
    interval = 3

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
            current_attempt = attempt_counts[probe.name]
            table.add_row(
                probe.name,
                f"[{style}]{status}[/] ({current_attempt}/{max_attempts})",
                details[probe.name],
            )
        return table

    def check_once(probe: ServiceProbe) -> tuple[bool, str]:
        port_value = env.get(probe.env_port_key)
        try:
            port = int(port_value) if port_value else probe.default_port
        except ValueError:
            return False, f"Invalid port '{port_value}'"

        url = f"http://127.0.0.1:{port}{probe.path}"
        try:
            response = requests.get(url, timeout=3)
            if 200 <= response.status_code < 400:
                return True, f"Reachable at {url}"
            return False, f"HTTP {response.status_code} from {url}"
        except requests.RequestException as exc:
            LOGGER.debug("Probe failed for %s: %s", url, exc)
            return False, str(exc)

    with Live(render_table(), refresh_per_second=4, console=console) as live:
        for attempt in range(1, max_attempts + 1):
            for probe in SERVICE_PROBES:
                name = probe.name
                if statuses[name] == "ready":
                    continue
                success, detail = check_once(probe)
                attempt_counts[name] = attempt
                if success:
                    statuses[name] = "ready"
                    details[name] = detail
                else:
                    details[name] = f"Waiting (last error: {detail})"
                    if attempt == max_attempts:
                        statuses[name] = "error"
                        details[name] = "No response after waiting ~1 minute"
                live.update(render_table())
            if all(status == "ready" for status in statuses.values()):
                break
            time.sleep(interval)
    return {name: (statuses[name], details[name]) for name in statuses}
