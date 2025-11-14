"""Typer-based CLI entrypoint for the Servarr bootstrapper."""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from dataclasses import replace
from typing import Any, Dict, Optional

import typer
from rich.console import Console
from rich.logging import RichHandler
from rich.panel import Panel
from rich.table import Table

from .cleaner import CleanError, CleanPlan, perform_clean
from .config import ConfigError, RuntimeContext, RuntimeOptions, build_runtime_context
from .env_setup import interactive_env_setup
from .sanity import run_sanity_scan, render_report
from .setup_tasks import SetupError, perform_setup
from .tasks.integrations import IntegrationError, run_integration_tasks

APP = typer.Typer(add_completion=False, invoke_without_command=True, help="Servarr bootstrapper (under construction)")
CONSOLE = Console()
LOGGER_NAME = "servarr.bootstrap"
LOGGER = logging.getLogger(LOGGER_NAME)
ROOT_DIR = Path(__file__).resolve().parents[1]
LOG_DIR = ROOT_DIR / "logs"


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

    console_handler = RichHandler(
        console=CONSOLE,
        show_time=False,
        show_path=False,
        rich_tracebacks=False,
    )
    console_handler.setLevel(logging.DEBUG if verbose else logging.INFO)

    logging.basicConfig(
        level=logging.DEBUG,
        handlers=[file_handler, console_handler],
        force=True,
    )

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


@APP.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    dry_run: bool = typer.Option(False, "--dry-run", help="Run without applying changes."),
    non_interactive: bool = typer.Option(False, "--non-interactive", help="Disable interactive prompts."),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show debug logs in the terminal."),
) -> None:
    """Bootstrapper entrypoint; defaults to the run command when no subcommand is provided."""
    log_path = configure_logging(verbose)
    options = RuntimeOptions(dry_run=dry_run, non_interactive=non_interactive, verbose=verbose)
    context = _store_context(ctx, options=options, log_path=log_path)

    LOGGER.info("Logs written to %s", log_path)

    if ctx.invoked_subcommand is None:
        runtime = _ensure_runtime_context(ctx, require_credentials=True)
        _execute_sanity_and_stub(runtime, ctx.obj.get("log_path"))
        raise typer.Exit(code=0)


def _ensure_runtime_context(ctx: typer.Context, *, require_credentials: bool) -> RuntimeContext:
    """Build (or rebuild) the runtime context using current options."""
    context = ctx.ensure_object(dict)
    options: RuntimeOptions = context.get("options", RuntimeOptions())
    if not options.non_interactive and not context.get("_env_configured"):
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
) -> None:
    """Execute the bootstrap workflow (currently stubbed)."""
    context = ctx.ensure_object(dict)
    stored_options: RuntimeOptions = context.get("options", RuntimeOptions())
    merged_options = RuntimeOptions(
        dry_run=stored_options.dry_run or dry_run,
        non_interactive=stored_options.non_interactive or non_interactive,
        verbose=stored_options.verbose or verbose,
    )
    context["options"] = merged_options
    runtime = _ensure_runtime_context(ctx, require_credentials=True)
    _execute_sanity_and_stub(runtime, ctx.obj.get("log_path"))


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

    try:
        perform_clean(
            root_dir=ROOT_DIR,
            log_dir=LOG_DIR,
            runtime=runtime,
            plan=plan,
            current_log=context.get("log_path"),
        )
    except CleanError as exc:
        CONSOLE.print(f"[bold red]Clean failed:[/bold red] {exc}")
        raise typer.Exit(code=1) from exc

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


def _execute_sanity_and_stub(runtime: RuntimeContext, log_path: Optional[str]) -> None:
    """Run the sanity scan before executing the placeholder workflow."""
    try:
        report = run_sanity_scan(ROOT_DIR, runtime)
        render_report(report, CONSOLE)
    except Exception as exc:
        LOGGER.exception("Environment check failed")
        CONSOLE.print(f"[bold red]Environment check failed:[/bold red] {exc}")
        CONSOLE.print(f"[dim]See {LOG_DIR / 'bootstrap-latest.log'} for details.[/dim]")
        raise typer.Exit(code=1) from exc
    try:
        perform_setup(ROOT_DIR, runtime, CONSOLE)
        run_integration_tasks(ROOT_DIR, runtime, CONSOLE)
    except (SetupError, IntegrationError) as exc:
        LOGGER.exception("Setup failed")
        CONSOLE.print(f"[bold red]Setup failed:[/bold red] {exc}")
        CONSOLE.print(f"[dim]See {LOG_DIR / 'bootstrap-latest.log'} for details.[/dim]")
        raise typer.Exit(code=1) from exc
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
