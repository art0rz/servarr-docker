"""Module entrypoint allowing `python -m servarr_bootstrap`."""

from .cli import run_app


def main() -> None:
    """Execute the Typer CLI."""
    run_app()


if __name__ == "__main__":
    main()
