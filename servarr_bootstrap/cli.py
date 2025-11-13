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

from .config import (
    ConfigError,
    RuntimeContext,
    RuntimeOptions,
    build_runtime_context,
)

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
    try:
        runtime = build_runtime_context(ROOT_DIR, options)
    except ConfigError as exc:
        CONSOLE.print(f"[bold red]Configuration error:[/bold red] {exc}")
        raise typer.Exit(code=1) from exc

    _store_context(ctx, runtime=runtime, log_path=log_path)

    logging.getLogger(LOGGER_NAME).info("Logs written to %s", log_path)

    if ctx.invoked_subcommand is None:
        run_stub(runtime)
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
    runtime: RuntimeContext | None = context.get("runtime")
    if runtime is None:
        CONSOLE.print("[bold red]Runtime context unavailable. Did the callback fail?[/bold red]")
        raise typer.Exit(code=1)

    # If flags were passed to the command directly, override the stored options.
    updated = RuntimeOptions(
        dry_run=dry_run or runtime.options.dry_run,
        non_interactive=non_interactive or runtime.options.non_interactive,
        verbose=verbose or runtime.options.verbose,
    )
    runtime = RuntimeContext(
        options=updated,
        ci=runtime.ci,
        env=runtime.env,
        credentials=runtime.credentials,
    )
    context["runtime"] = runtime
    run_stub(runtime)


@APP.command()
def clean(
    ctx: typer.Context,
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation prompts."),
) -> None:
    """Reset container configs and stop services (placeholder)."""
    context = ctx.ensure_object(dict)
    runtime: RuntimeContext | None = context.get("runtime")
    run_mode = "non-interactive" if runtime and runtime.options.non_interactive else "interactive"
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
