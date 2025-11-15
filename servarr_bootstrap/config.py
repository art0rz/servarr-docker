"""Configuration and environment handling for the Servarr bootstrapper."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Dict, Mapping, MutableMapping, Optional

import typer
from dotenv import dotenv_values

LOGGER = logging.getLogger("servarr.bootstrap.config")
CI_ENV_VARS = ("CI", "GITHUB_ACTIONS", "BUILDKITE", "TF_BUILD", "TEAMCITY_VERSION")


@dataclass(frozen=True)
class RuntimeOptions:
    """Command-line level flags controlling overall behavior."""

    dry_run: bool = False
    non_interactive: bool = False
    verbose: bool = False
    quickstart: bool = False


@dataclass(frozen=True)
class EnvironmentData:
    """Snapshot of configuration values gathered from .env and process env."""

    env_file: Optional[Path]
    file_values: Dict[str, str]
    merged: Dict[str, str]


@dataclass(frozen=True)
class Credentials:
    """User-provided credentials shared across services."""

    username: Optional[str]
    password: Optional[str]


@dataclass(frozen=True)
class RuntimeContext:
    """Aggregated runtime settings shared across bootstrap tasks."""

    options: RuntimeOptions
    ci: bool
    env: EnvironmentData
    credentials: Credentials


class ConfigError(RuntimeError):
    """Raised when required configuration is missing in non-interactive mode."""


def detect_ci(env: Mapping[str, str] | None = None) -> bool:
    """Return True if the provided environment indicates a CI environment."""
    environment = env if env is not None else os.environ
    for key in CI_ENV_VARS:
        value = environment.get(key)
        if value and value.strip().lower() in {"1", "true", "yes", "on"}:
            return True
    return False


def load_environment_data(root_dir: Path, env: Mapping[str, str] | None = None) -> EnvironmentData:
    """Load .env (if present) and merge with the provided environment variables."""
    env_file = root_dir / ".env"
    file_values: Dict[str, str] = {}
    if env_file.exists():
        raw_values = dotenv_values(env_file)
        file_values = {k: v for k, v in raw_values.items() if v is not None}
        LOGGER.debug("Loaded %d values from %s", len(file_values), env_file)
    else:
        LOGGER.debug("No .env file found at %s", env_file)

    runtime_env: MutableMapping[str, str] = dict(env or os.environ)

    # Convert all values to str to avoid downstream surprises.
    runtime_env = {k: str(v) for k, v in runtime_env.items()}

    merged: Dict[str, str] = dict(file_values)
    merged.update(runtime_env)
    return EnvironmentData(env_file if env_file.exists() else None, file_values, merged)


def _prompt_value(prompt_text: str, *, secret: bool = False) -> str:
    """Prompt the user for input (hiding the value when secret)."""
    return typer.prompt(
        prompt_text,
        default="",
        show_default=False,
        hide_input=secret,
    ).strip()


def _require_value(
    key: str,
    env: Mapping[str, str],
    *,
    prompt_text: str,
    non_interactive: bool,
    secret: bool = False,
) -> Optional[str]:
    """Ensure a configuration value is available, prompting when interactive."""
    value = env.get(key)
    if value:
        if secret:
            LOGGER.debug("%s provided via environment (hidden)", key)
        else:
            LOGGER.debug("%s=%s provided via environment", key, value)
        return value

    if non_interactive:
        raise ConfigError(
            f"Missing required value for {key}. "
            "Provide it via environment variables when running non-interactively."
        )

    prompt_value = _prompt_value(prompt_text, secret=secret)
    if prompt_value:
        if secret:
            LOGGER.debug("%s captured via interactive prompt (hidden)", key)
        else:
            LOGGER.debug("%s captured via interactive prompt", key)
    return prompt_value or None


def _collect_credentials(env: Mapping[str, str], *, non_interactive: bool) -> Credentials:
    """Gather shared username/password credentials."""
    username = _require_value(
        "SERVARR_USERNAME",
        env,
        prompt_text="Enter the Servarr username to configure",
        non_interactive=non_interactive,
        secret=False,
    )

    password = _require_value(
        "SERVARR_PASSWORD",
        env,
        prompt_text="Enter the Servarr password to configure",
        non_interactive=non_interactive,
        secret=True,
    )

    return Credentials(username=username, password=password)


def build_runtime_context(
    root_dir: Path,
    options: RuntimeOptions,
    env: Mapping[str, str] | None = None,
    *,
    require_credentials: bool = True,
) -> RuntimeContext:
    """Load configuration and return a hydrated runtime context."""
    env_data = load_environment_data(root_dir, env=env)
    ci_mode = detect_ci(env_data.merged)

    effective_options = replace(options, non_interactive=options.non_interactive or ci_mode)
    if ci_mode and not options.non_interactive:
        LOGGER.info("CI environment detected; forcing non-interactive mode.")

    if require_credentials:
        credentials = _collect_credentials(
            env_data.merged,
            non_interactive=effective_options.non_interactive,
        )
    else:
        username = env_data.merged.get("SERVARR_USERNAME")
        password = env_data.merged.get("SERVARR_PASSWORD")
        if username:
            LOGGER.debug("SERVARR_USERNAME provided; using for clean context.")
        if password:
            LOGGER.debug("SERVARR_PASSWORD provided; using for clean context (hidden).")
        credentials = Credentials(username=username, password=password)

    return RuntimeContext(
        options=effective_options,
        ci=ci_mode,
        env=env_data,
        credentials=credentials,
    )
