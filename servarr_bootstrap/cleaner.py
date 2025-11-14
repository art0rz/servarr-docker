"""Implements the clean/reset workflow."""

from __future__ import annotations

import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, Optional, Sequence

from .config import RuntimeContext

LOGGER = logging.getLogger("servarr.bootstrap.clean")
CommandRunner = Callable[[Sequence[str], Optional[Path], Optional[Dict[str, str]]], None]


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
    status_callback: Optional[Callable[[str, str, str], None]] = None,
    command_env: Optional[Dict[str, str]] = None,
) -> None:
    """Execute the clean workflow."""

    dry_run = runtime.options.dry_run
    LOGGER.info("Starting clean workflow (dry_run=%s, remove_logs=%s, remove_venv=%s)", dry_run, plan.remove_logs, plan.remove_venv)

    def update(step: str, state: str, detail: str = "") -> None:
        if status_callback:
            status_callback(step, state, detail)

    update("docker", "running", "Stopping containers and tearing down volumes")
    try:
        docker_compose_down(root_dir, dry_run=dry_run, runner=command_runner, env=command_env)
    except CleanError:
        update("docker", "failed", "docker compose down failed")
        raise
    else:
        update("docker", "done", "Containers stopped")

    update("configs", "running", "Removing config directories")
    try:
        remove_config_directories(root_dir / "config", dry_run=dry_run)
    except Exception as exc:
        update("configs", "failed", "Failed to remove config directories")
        raise CleanError(f"Failed to remove config directories: {exc}") from exc
    else:
        update("configs", "done", "Config directories removed")

    update("state", "running", "Removing bootstrap state files")
    try:
        remove_state_files(root_dir, dry_run=dry_run)
    except Exception as exc:
        update("state", "failed", "Failed to remove state files")
        raise CleanError(f"Failed to remove state files: {exc}") from exc
    else:
        update("state", "done", "State files removed")

    if plan.remove_logs:
        update("logs", "running", "Removing log files")
        try:
            remove_logs(log_dir, dry_run=dry_run, current_log=current_log)
        except Exception as exc:
            update("logs", "failed", "Failed to remove log files")
            raise CleanError(f"Failed to remove log files: {exc}") from exc
        else:
            update("logs", "done", "Logs removed")
    else:
        update("logs", "skipped", "Not requested")

    if plan.remove_venv:
        update("venv", "running", "Removing virtualenv")
        try:
            remove_virtualenv(root_dir / ".venv", dry_run=dry_run)
        except Exception as exc:
            update("venv", "failed", "Failed to remove virtualenv")
            raise CleanError(f"Failed to remove virtualenv: {exc}") from exc
        else:
            update("venv", "done", "Virtualenv removed")
    else:
        update("venv", "skipped", "Not requested")

    LOGGER.info("Clean workflow completed")


def docker_compose_down(root_dir: Path, *, dry_run: bool, runner: Optional[CommandRunner], env: Optional[Dict[str, str]]) -> None:
    compose_file = root_dir / "docker-compose.yml"
    if not compose_file.exists():
        LOGGER.warning("docker-compose.yml not found at %s; skipping docker compose down", compose_file)
        return
    cmd = ["docker", "compose", "-f", str(compose_file), "down", "--remove-orphans", "-v"]
    run_command(cmd, cwd=root_dir, dry_run=dry_run, runner=runner, env=env)


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


def run_command(
    cmd: Sequence[str],
    *,
    cwd: Optional[Path],
    dry_run: bool,
    runner: Optional[CommandRunner],
    env: Optional[Dict[str, str]] = None,
) -> None:
    rendered = " ".join(cmd)
    LOGGER.info("Running command: %s", rendered)
    if dry_run:
        LOGGER.info("[dry-run] Skipping command execution")
        return
    if runner is not None:
        runner(cmd, cwd, env)
        return
    try:
        completed = subprocess.run(
            cmd,
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
        if completed.stdout:
            LOGGER.debug(completed.stdout.strip())
        if completed.stderr:
            LOGGER.debug(completed.stderr.strip())
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() if exc.stderr else ""
        if stderr:
            LOGGER.error("Command failed (%s): %s", rendered, stderr)
        raise CleanError(f"Command failed: {rendered}. See log for details.") from exc
