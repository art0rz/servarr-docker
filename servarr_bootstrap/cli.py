"""Typer-based CLI entrypoint for the Servarr bootstrapper."""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from dataclasses import replace
from typing import Any, Dict

import typer
from rich.console import Console
from rich.logging import RichHandler
from rich.panel import Panel
from rich.table import Table

from .cleaner import CleanError, CleanPlan, perform_clean
from .config import ConfigError, RuntimeContext, RuntimeOptions, build_runtime_context
from .sanity import run_sanity_scan, render_report

APP = typer.Typer(add_completion=False, invoke_without_command=True, help="Servarr bootstrapper (under construction)")
CONSOLE = Console()
LOGGER_NAME = "servarr.bootstrap"
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
        rich_tracebacks=True,
    )
    console_handler.setLevel(logging.DEBUG if verbose else logging.INFO)

    logging.basicConfig(
        level=logging.DEBUG,
        handlers=[file_handler, console_handler],
        force=True,
    )

    latest_link = LOG_DIR / "bootstrap-latest.log"
    try:
        if latest_link.is_symlink() or latest_link.exists():
            latest_link.unlink()
        latest_link.symlink_to(log_file.name)
    except OSError:
        logging.getLogger(LOGGER_NAME).debug("Unable to update latest log symlink", exc_info=True)

    logging.getLogger(LOGGER_NAME).debug("Logging initialized at %s", log_file)
    return log_file


def run_stub(runtime: RuntimeContext) -> None:
    """Temporary placeholder until the real bootstrap tasks are implemented."""
    logger = logging.getLogger(LOGGER_NAME)
    table = Table(title="Bootstrap Context", show_header=False, box=None)
    table.add_row("Dry run", str(runtime.options.dry_run))
    table.add_row("Non-interactive", str(runtime.options.non_interactive))
    table.add_row("CI mode detected", str(runtime.ci))
    env_file_display = runtime.env.env_file.as_posix() if runtime.env.env_file else "Not found"
    table.add_row(".env path", env_file_display)
    table.add_row("Username", runtime.credentials.username or "<not set>")
    table.add_row("Password provided", "Yes" if runtime.credentials.password else "No")
    CONSOLE.print(table)
    CONSOLE.print(
        Panel(
            "The new Python bootstrapper is under active development.\n"
            "Use `./bootstrap.sh legacy` for the current production workflow.",
            title="Status",
            border_style="yellow",
        )
    )
    logger.info(
        "Python bootstrap stub executed (dry_run=%s, non_interactive=%s)",
        runtime.options.dry_run,
        runtime.options.non_interactive,
    )


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

    logging.getLogger(LOGGER_NAME).info("Logs written to %s", log_path)

    if ctx.invoked_subcommand is None:
        runtime = _ensure_runtime_context(ctx, require_credentials=True)
        _execute_sanity_and_stub(runtime)
        raise typer.Exit(code=0)


def _ensure_runtime_context(ctx: typer.Context, *, require_credentials: bool) -> RuntimeContext:
    """Build (or rebuild) the runtime context using current options."""
    context = ctx.ensure_object(dict)
    options: RuntimeOptions = context.get("options", RuntimeOptions())
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
    _execute_sanity_and_stub(runtime)


@APP.command()
def clean(
    ctx: typer.Context,
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation prompts."),
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
    APP()


def _execute_sanity_and_stub(runtime: RuntimeContext) -> None:
    """Run the sanity scan before executing the placeholder workflow."""
    report = run_sanity_scan(ROOT_DIR, runtime)
    render_report(report, CONSOLE)
    run_stub(runtime)
