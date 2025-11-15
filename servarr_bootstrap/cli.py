"""Typer-based CLI entrypoint for the Servarr bootstrapper."""

from __future__ import annotations

import logging
import shutil
import subprocess
from datetime import datetime
from collections import OrderedDict
from pathlib import Path
from dataclasses import replace
from typing import Any, Dict, Optional

import typer
from rich.console import Console
from rich.logging import RichHandler
from rich.live import Live
from rich.panel import Panel
from rich.table import Table

from .cleaner import CleanError, CleanPlan, perform_clean
from .config import ConfigError, RuntimeContext, RuntimeOptions, build_runtime_context
from .env_setup import default_env_values, interactive_env_setup, ensure_quickstart_env
from .sanity import render_report, run_sanity_scan
from .setup_tasks import SetupError, perform_setup
from .tasks.integrations import IntegrationError, run_integration_tasks
from .utils.progress import ProgressStep, ProgressTracker

APP = typer.Typer(add_completion=False, invoke_without_command=True, help="Servarr bootstrapper (under construction)")
CONSOLE = Console()
LOGGER_NAME = "servarr.bootstrap"
LOGGER = logging.getLogger(LOGGER_NAME)
ROOT_DIR = Path(__file__).resolve().parents[1]
LOG_DIR = ROOT_DIR / "logs"
CLEAN_STATUS_STYLES = {
    "pending": "dim",
    "running": "cyan",
    "done": "green",
    "skipped": "yellow",
    "failed": "red",
}
ERROR_HINTS = [
    ("Config file not found", "Start the Sonarr/Radarr/Prowlarr containers once so config.xml is created, then rerun bootstrap."),
    ("Unable to authenticate with qBittorrent", "Give qBittorrent a few more seconds to start and ensure the WebUI port isn't in use."),
    ("docker compose", "Verify the Docker daemon is running and that you have permission to run docker commands (try `docker ps`)."),
]


def configure_logging(verbose: bool) -> Path:
    """Configure file + console logging and return the log file path."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_file = LOG_DIR / f"bootstrap-{timestamp}.log"

    file_handler = logging.FileHandler(log_file)
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s | %(levelname)-8s | %(name)s | %(message)s")
    )

    logging.basicConfig(level=logging.DEBUG, handlers=[file_handler], force=True)
    if verbose:
        console_handler = RichHandler(
            console=CONSOLE,
            show_time=False,
            show_path=False,
            rich_tracebacks=False,
        )
        console_handler.setLevel(logging.DEBUG)
        logging.getLogger().addHandler(console_handler)

    if not verbose:
        for noisy in ("urllib3", "requests", "docker"):
            logging.getLogger(noisy).setLevel(logging.WARNING)

    latest_link = LOG_DIR / "bootstrap-latest.log"
    try:
        if latest_link.is_symlink() or latest_link.exists():
            latest_link.unlink()
        latest_link.symlink_to(log_file.name)
    except OSError:
        LOGGER.debug("Unable to update latest log symlink", exc_info=True)

    LOGGER.debug("Logging initialized at %s", log_file)
    return log_file


def _store_context(ctx: typer.Context, **kwargs: Any) -> Dict[str, Any]:
    ctx.obj = ctx.obj or {}
    ctx.obj.update(kwargs)
    return ctx.obj


def _initial_clean_steps(plan: CleanPlan) -> OrderedDict[str, Dict[str, str]]:
    steps = OrderedDict(
        [
            ("docker", {"label": "Stop containers", "status": "pending", "details": "Waiting"}),
            ("configs", {"label": "Remove config directories", "status": "pending", "details": "Waiting"}),
            ("state", {"label": "Remove bootstrap state", "status": "pending", "details": "Waiting"}),
            ("logs", {"label": "Remove bootstrap logs", "status": "pending", "details": "Waiting"}),
            ("venv", {"label": "Remove virtualenv", "status": "pending", "details": "Waiting"}),
        ]
    )
    if not plan.remove_logs:
        steps["logs"]["status"] = "skipped"
        steps["logs"]["details"] = "Not requested"
    if not plan.remove_venv:
        steps["venv"]["status"] = "skipped"
        steps["venv"]["details"] = "Not requested"
    return steps


def _render_clean_table(steps: OrderedDict[str, Dict[str, str]]) -> Table:
    table = Table(title="Clean Progress")
    table.add_column("Step", style="bold")
    table.add_column("Status")
    table.add_column("Details")
    for data in steps.values():
        status = data["status"]
        color = CLEAN_STATUS_STYLES.get(status, "white")
        table.add_row(data["label"], f"[{color}]{status.capitalize()}[/{color}]", data["details"])
    return table




@APP.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    dry_run: bool = typer.Option(False, "--dry-run", help="Run without applying changes."),
    non_interactive: bool = typer.Option(False, "--non-interactive", help="Disable interactive prompts."),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show debug logs in the terminal."),
    quickstart: bool = typer.Option(False, "--quickstart", help="Apply default configuration values for unattended runs."),
) -> None:
    """Bootstrapper entrypoint; defaults to the run command when no subcommand is provided."""
    log_path = configure_logging(verbose)
    options = RuntimeOptions(
        dry_run=dry_run,
        non_interactive=non_interactive,
        verbose=verbose,
        quickstart=quickstart,
    )
    context = _store_context(ctx, options=options, log_path=log_path)

    LOGGER.info("Logs written to %s", log_path)

    if ctx.invoked_subcommand is None:
        runtime = _ensure_runtime_context(ctx, require_credentials=True)
        _execute_bootstrap_flow(runtime, ctx.obj.get("log_path"))
        raise typer.Exit(code=0)


def _ensure_runtime_context(ctx: typer.Context, *, require_credentials: bool) -> RuntimeContext:
    """Build (or rebuild) the runtime context using current options."""
    context = ctx.ensure_object(dict)
    options: RuntimeOptions = context.get("options", RuntimeOptions())
    if options.quickstart and not context.get("_quickstart_applied"):
        ensure_quickstart_env(ROOT_DIR, CONSOLE)
        context["_env_configured"] = True
        context["_quickstart_applied"] = True
    elif require_credentials and not options.non_interactive and not context.get("_env_configured"):
        interactive_env_setup(ROOT_DIR, CONSOLE)
        context["_env_configured"] = True
    try:
        runtime = build_runtime_context(
            ROOT_DIR,
            options,
            require_credentials=require_credentials,
        )
    except ConfigError as exc:
        CONSOLE.print(f"[bold red]Configuration error:[/bold red] {exc}")
        raise typer.Exit(code=1) from exc
    context["runtime"] = runtime
    context["options"] = runtime.options
    return runtime


@APP.command()
def run(
    ctx: typer.Context,
    dry_run: bool = typer.Option(False, "--dry-run", help="Run without applying changes."),
    non_interactive: bool = typer.Option(False, "--non-interactive", help="Disable interactive prompts."),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show debug logs in the terminal."),
    quickstart: bool = typer.Option(False, "--quickstart", help="Apply default configuration values for unattended runs."),
) -> None:
    """Execute the bootstrap workflow (currently stubbed)."""
    context = ctx.ensure_object(dict)
    stored_options: RuntimeOptions = context.get("options", RuntimeOptions())
    merged_options = RuntimeOptions(
        dry_run=stored_options.dry_run or dry_run,
        non_interactive=stored_options.non_interactive or non_interactive,
        verbose=stored_options.verbose or verbose,
        quickstart=stored_options.quickstart or quickstart,
    )
    context["options"] = merged_options
    runtime = _ensure_runtime_context(ctx, require_credentials=True)
    _execute_bootstrap_flow(runtime, ctx.obj.get("log_path"))


@APP.command()
def check(
    ctx: typer.Context,
    dry_run: bool = typer.Option(False, "--dry-run", help="(Ignored) maintained for CLI parity."),
    non_interactive: bool = typer.Option(False, "--non-interactive", help="Disable interactive prompts."),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show debug logs in the terminal."),
    quickstart: bool = typer.Option(False, "--quickstart", help="Apply default configuration values before running the sanity check."),
) -> None:
    """Run the sanity scan without provisioning services."""
    context = ctx.ensure_object(dict)
    stored_options: RuntimeOptions = context.get("options", RuntimeOptions())
    merged_options = RuntimeOptions(
        dry_run=stored_options.dry_run or dry_run,
        non_interactive=stored_options.non_interactive or non_interactive,
        verbose=stored_options.verbose or verbose,
        quickstart=stored_options.quickstart or quickstart,
    )
    context["options"] = merged_options
    runtime = _ensure_runtime_context(ctx, require_credentials=False)
    LOGGER.info("Running standalone sanity check")
    if merged_options.dry_run:
        CONSOLE.print("[cyan]Sanity:[/] Skipped (dry-run)")
    else:
        _validate_dependencies(require_docker=True)
        _run_sanity_phase(runtime, ctx.obj.get("log_path"))


@APP.command()
def clean(
    ctx: typer.Context,
    force: bool = typer.Option(
        False,
        "--force",
        "-f",
        "--yes",
        "-y",
        help="Skip confirmation prompts (auto-answer yes).",
    ),
    purge_logs: bool = typer.Option(False, "--purge-logs", help="Remove bootstrap log files."),
    purge_venv: bool = typer.Option(False, "--purge-venv", help="Delete the Python virtual environment (.venv)."),
) -> None:
    """Reset container configs and stop services (placeholder)."""
    context = ctx.ensure_object(dict)
    stored_options: RuntimeOptions = context.get("options", RuntimeOptions())
    merged_options = RuntimeOptions(
        dry_run=stored_options.dry_run,
        non_interactive=stored_options.non_interactive,
        verbose=stored_options.verbose,
        quickstart=stored_options.quickstart,
    )
    context["options"] = merged_options
    runtime = _ensure_runtime_context(ctx, require_credentials=False)
    run_mode = "non-interactive" if runtime.options.non_interactive else "interactive"
    logger = logging.getLogger(LOGGER_NAME)
    logger.info("Clean command invoked (force=%s, mode=%s)", force, run_mode)

    if runtime.options.non_interactive and not force:
        CONSOLE.print("[bold red]Non-interactive clean requires --force.[/bold red]")
        raise typer.Exit(code=2)

    # Confirm destructive action unless forced.
    proceed = True
    if not force:
        proceed = typer.confirm(
            "This will stop containers and delete config directories under config/. Continue?",
            default=False,
        )
    if not proceed:
        CONSOLE.print("[yellow]Clean aborted.[/yellow]")
        return

    remove_logs = purge_logs
    remove_venv = purge_venv
    if not purge_logs and not runtime.options.non_interactive and not force:
        remove_logs = typer.confirm("Remove bootstrap log files?", default=False)
    if not purge_venv and not runtime.options.non_interactive and not force:
        remove_venv = typer.confirm("Remove the Python virtual environment (.venv)?", default=False)

    plan = CleanPlan(remove_logs=remove_logs, remove_venv=remove_venv)

    clean_env = dict(runtime.env.merged)
    for key, default in default_env_values().items():
        clean_env.setdefault(key, default)

    _validate_dependencies(require_docker=not runtime.options.dry_run)

    clean_error: Optional[Exception] = None
    steps = [
        ProgressStep("docker", "Stop containers", "Waiting"),
        ProgressStep("configs", "Remove config directories", "Waiting"),
        ProgressStep("state", "Remove bootstrap state", "Waiting"),
        ProgressStep("logs", "Remove bootstrap logs", "Skipped" if not plan.remove_logs else "Waiting"),
        ProgressStep("venv", "Remove virtualenv", "Skipped" if not plan.remove_venv else "Waiting"),
    ]

    with ProgressTracker("Clean Progress", steps, console=CONSOLE) as tracker:
        def update_and_render(step: str, status: str, detail: str = "") -> None:
            tracker.update(step, status=status, details=detail or tracker.steps[step].details)

        try:
            perform_clean(
                root_dir=ROOT_DIR,
                log_dir=LOG_DIR,
                runtime=runtime,
                plan=plan,
                current_log=context.get("log_path"),
                status_callback=update_and_render,
                command_env=clean_env,
            )
        except CleanError as exc:
            clean_error = exc

    if clean_error:
        CONSOLE.print(f"[bold red]Clean failed:[/bold red] {clean_error}")
        raise typer.Exit(code=1) from clean_error

    CONSOLE.print(
        Panel(
            "Clean completed. Containers stopped and configuration directories reset.",
            title="Clean",
            border_style="green",
        )
    )


def run_app() -> None:
    """Serve as the entrypoint callable for `python -m servarr_bootstrap`."""
    try:
        APP()
    except typer.Exit:
        raise
    except Exception as exc:  # pragma: no cover - safeguard
        LOGGER.exception("Unhandled bootstrap error")
        log_hint = LOG_DIR / "bootstrap-latest.log"
        CONSOLE.print(
            f"[bold red]Unexpected error:[/bold red] {exc}\n"
            f"[dim]See {log_hint} for the full stack trace.[/dim]"
        )
        raise typer.Exit(code=1) from exc


def _execute_bootstrap_flow(runtime: RuntimeContext, log_path: Optional[str]) -> None:
    """Execute setup/integration flow followed by the final sanity scan."""
    _validate_dependencies(require_docker=not runtime.options.dry_run)
    try:
        perform_setup(ROOT_DIR, runtime, CONSOLE)
        if runtime.options.dry_run:
            CONSOLE.print("[cyan]Integrations:[/] Skipped (dry-run)")
        else:
            run_integration_tasks(ROOT_DIR, runtime, CONSOLE)
    except (SetupError, IntegrationError) as exc:
        LOGGER.exception("Setup failed")
        CONSOLE.print(f"[bold red]Setup failed:[/bold red] {exc}")
        hint = _hint_for_exception(exc)
        if hint:
            CONSOLE.print(f"[yellow]Hint:[/] {hint}")
        CONSOLE.print(f"[dim]See {LOG_DIR / 'bootstrap-latest.log'} for details.[/dim]")
        raise typer.Exit(code=1) from exc
    if runtime.options.dry_run:
        CONSOLE.print("[cyan]Sanity:[/] Skipped (dry-run)")
    else:
        _run_sanity_phase(runtime, log_path)
    _print_completion(runtime, log_path)


def _print_completion(runtime: RuntimeContext, log_path: Optional[str]) -> None:
    summary_table = Table(title="Bootstrap Summary", show_header=False, box=None)
    summary_table.add_row("Mode", "DRY RUN" if runtime.options.dry_run else "Live run")
    summary_table.add_row("Non-interactive", "Yes" if runtime.options.non_interactive else "No")
    env_file_display = runtime.env.env_file.as_posix() if runtime.env.env_file else "Not found"
    summary_table.add_row(".env path", env_file_display)
    summary_table.add_row("Log file", str(log_path or (LOG_DIR / "bootstrap-latest.log")))
    CONSOLE.print(summary_table)
    CONSOLE.print(
        Panel(
            "Setup finished. Review the log for detailed actions.",
            border_style="green",
        )
    )
    if runtime.options.quickstart:
        CONSOLE.print("[cyan]Quickstart credentials:[/] servarr / servarr")


def _validate_dependencies(require_docker: bool) -> None:
    issues: list[str] = []
    if require_docker:
        if shutil.which("docker") is None:
            issues.append("Docker CLI not found. Install Docker and ensure it is in PATH.")
        else:
            try:
                subprocess.run(["docker", "compose", "version"], check=True, capture_output=True, text=True)
            except subprocess.CalledProcessError:
                issues.append("`docker compose` failed. Upgrade Docker Compose or install the compose plugin.")
            except FileNotFoundError:
                issues.append("`docker compose` is unavailable. Install Docker Compose or use Docker 20.10+ with the compose plugin.")
    if issues:
        for issue in issues:
            CONSOLE.print(f"[bold red]Dependency error:[/bold red] {issue}")
        raise typer.Exit(code=2)


def _hint_for_exception(exc: Exception) -> Optional[str]:
    message = str(exc)
    for needle, hint in ERROR_HINTS:
        if needle in message:
            return hint
    return None
def _run_sanity_phase(runtime: RuntimeContext, log_path: Optional[str]) -> None:
    """Execute the sanity scan and render results, handling failures uniformly."""
    try:
        report = run_sanity_scan(ROOT_DIR, runtime)
        render_report(report, CONSOLE)
    except Exception as exc:
        LOGGER.exception("Sanity check failed")
        log_hint = log_path or (LOG_DIR / "bootstrap-latest.log")
        CONSOLE.print(f"[bold red]Sanity check failed:[/bold red] {exc}")
        hint = _hint_for_exception(exc)
        if hint:
            CONSOLE.print(f"[yellow]Hint:[/] {hint}")
        CONSOLE.print(f"[dim]See {log_hint} for details.[/dim]")
        raise typer.Exit(code=1) from exc
