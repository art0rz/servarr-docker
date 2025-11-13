"""Typer-based CLI entrypoint for the Servarr bootstrapper."""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

import typer
from rich.console import Console
from rich.logging import RichHandler
from rich.panel import Panel
from rich.table import Table

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


def run_stub(dry_run: bool, non_interactive: bool) -> None:
    """Temporary placeholder until the real bootstrap tasks are implemented."""
    logger = logging.getLogger(LOGGER_NAME)
    table = Table(title="Bootstrap Context", show_header=False, box=None)
    table.add_row("Dry run", str(dry_run))
    table.add_row("Non-interactive", str(non_interactive))
    CONSOLE.print(table)
    CONSOLE.print(
        Panel(
            "The new Python bootstrapper is under active development.\n"
            "Use `./bootstrap.sh legacy` for the current production workflow.",
            title="Status",
            border_style="yellow",
        )
    )
    logger.info("Python bootstrap stub executed (dry_run=%s, non_interactive=%s)", dry_run, non_interactive)


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
    _store_context(ctx, dry_run=dry_run, non_interactive=non_interactive, verbose=verbose, log_path=log_path)

    logging.getLogger(LOGGER_NAME).info("Logs written to %s", log_path)

    if ctx.invoked_subcommand is None:
        run_stub(dry_run=dry_run, non_interactive=non_interactive)
        raise typer.Exit(code=0)


@APP.command()
def run(
    ctx: typer.Context,
    dry_run: bool = typer.Option(False, "--dry-run", help="Run without applying changes."),
    non_interactive: bool = typer.Option(False, "--non-interactive", help="Disable interactive prompts."),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Show debug logs in the terminal."),
) -> None:
    """Execute the bootstrap workflow (currently stubbed)."""
    context = ctx.ensure_object(dict)
    # Prefer CLI args passed directly to the command; otherwise fall back to callback values.
    effective_dry_run = dry_run or context.get("dry_run", False)
    effective_non_interactive = non_interactive or context.get("non_interactive", False)
    if verbose:
        context["verbose"] = True
    run_stub(dry_run=effective_dry_run, non_interactive=effective_non_interactive)


@APP.command()
def clean(
    ctx: typer.Context,
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation prompts."),
) -> None:
    """Reset container configs and stop services (placeholder)."""
    context = ctx.ensure_object(dict)
    run_mode = "non-interactive" if context.get("non_interactive") else "interactive"
    logging.getLogger(LOGGER_NAME).info("Clean command invoked (force=%s, mode=%s)", force, run_mode)
    CONSOLE.print(
        Panel(
            "The clean/reset workflow is not yet implemented in the new bootstrapper.\n"
            "Use `./bootstrap.sh legacy` for now.",
            title="Clean",
            border_style="red",
        )
    )


def run_app() -> None:
    """Serve as the entrypoint callable for `python -m servarr_bootstrap`."""
    APP()
