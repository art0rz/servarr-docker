"""Implements the clean/reset workflow."""

from __future__ import annotations

import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional, Sequence

from .config import RuntimeContext

LOGGER = logging.getLogger("servarr.bootstrap.clean")
CommandRunner = Callable[[Sequence[str], Optional[Path]], None]


class CleanError(RuntimeError):
    """Raised when the clean workflow cannot complete."""


@dataclass(frozen=True)
class CleanPlan:
    remove_logs: bool = False
    remove_venv: bool = False


def perform_clean(
    root_dir: Path,
    log_dir: Path,
    runtime: RuntimeContext,
    plan: CleanPlan,
    *,
    current_log: Optional[Path] = None,
    command_runner: Optional[CommandRunner] = None,
) -> None:
    """Execute the clean workflow."""

    dry_run = runtime.options.dry_run
    LOGGER.info("Starting clean workflow (dry_run=%s, remove_logs=%s, remove_venv=%s)", dry_run, plan.remove_logs, plan.remove_venv)

    docker_compose_down(root_dir, dry_run=dry_run, runner=command_runner)
    remove_config_directories(root_dir / "config", dry_run=dry_run)
    remove_state_files(root_dir, dry_run=dry_run)

    if plan.remove_logs:
        remove_logs(log_dir, dry_run=dry_run, current_log=current_log)

    if plan.remove_venv:
        remove_virtualenv(root_dir / ".venv", dry_run=dry_run)

    LOGGER.info("Clean workflow completed")


def docker_compose_down(root_dir: Path, *, dry_run: bool, runner: Optional[CommandRunner]) -> None:
    compose_file = root_dir / "docker-compose.yml"
    if not compose_file.exists():
        LOGGER.warning("docker-compose.yml not found at %s; skipping docker compose down", compose_file)
        return
    cmd = ["docker", "compose", "-f", str(compose_file), "down", "--remove-orphans", "-v"]
    run_command(cmd, cwd=root_dir, dry_run=dry_run, runner=runner)


def remove_config_directories(config_root: Path, *, dry_run: bool) -> None:
    if not config_root.exists():
        LOGGER.info("Config directory %s does not exist; skipping removal", config_root)
        return
    for entry in sorted(config_root.iterdir()):
        if entry.is_dir():
            LOGGER.info("Removing %s", entry)
            if dry_run:
                continue
            shutil.rmtree(entry, ignore_errors=True)
        elif entry.is_file():
            LOGGER.info("Removing file %s", entry)
            if dry_run:
                continue
            entry.unlink(missing_ok=True)


def remove_state_files(root_dir: Path, *, dry_run: bool) -> None:
    candidate_files: Iterable[Path] = [root_dir / "bootstrap_state.json"]
    for path in candidate_files:
        if path.exists():
            LOGGER.info("Removing %s", path)
            if dry_run:
                continue
            path.unlink()


def remove_logs(log_dir: Path, *, dry_run: bool, current_log: Optional[Path]) -> None:
    if not log_dir.exists():
        LOGGER.info("Log directory %s does not exist; skipping", log_dir)
        return
    for entry in sorted(log_dir.iterdir()):
        if current_log and entry.resolve() == Path(current_log).resolve():
            LOGGER.info("Skipping current log file %s", entry)
            continue
        LOGGER.info("Removing log %s", entry)
        if dry_run:
            continue
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)

    latest_symlink = log_dir / "bootstrap-latest.log"
    if latest_symlink.exists() or latest_symlink.is_symlink():
        LOGGER.info("Removing symlink %s", latest_symlink)
        if not dry_run:
            latest_symlink.unlink(missing_ok=True)


def remove_virtualenv(venv_path: Path, *, dry_run: bool) -> None:
    if not venv_path.exists():
        LOGGER.info("Virtualenv %s not found; skipping", venv_path)
        return
    LOGGER.info("Removing virtualenv at %s", venv_path)
    if dry_run:
        return
    shutil.rmtree(venv_path, ignore_errors=True)


def run_command(cmd: Sequence[str], *, cwd: Optional[Path], dry_run: bool, runner: Optional[CommandRunner]) -> None:
    rendered = " ".join(cmd)
    LOGGER.info("Running command: %s", rendered)
    if dry_run:
        LOGGER.info("[dry-run] Skipping command execution")
        return
    if runner is not None:
        runner(cmd, cwd)
        return
    try:
        completed = subprocess.run(
            cmd,
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
        )
        if completed.stdout:
            LOGGER.debug(completed.stdout.strip())
        if completed.stderr:
            LOGGER.debug(completed.stderr.strip())
    except subprocess.CalledProcessError as exc:
        raise CleanError(f"Command failed ({rendered}): {exc.stderr.strip()}" if exc.stderr else f"Command failed: {rendered}") from exc
