"""Helpers to extract API keys from service config files."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional


class ApiKeyError(RuntimeError):
    """Raised when we cannot read an API key."""


def read_arr_api_key(root_dir: Path, service: str) -> str:
    """Read the API key for a given Arr service from its config.xml file."""
    return _read_api_key(root_dir / "config" / service / "config.xml")


def read_prowlarr_api_key(root_dir: Path) -> str:
    """Read the API key for Prowlarr."""
    return _read_api_key(root_dir / "config" / "prowlarr" / "config.xml")


def _read_api_key(config_path: Path) -> str:
    if not config_path.exists():
        raise ApiKeyError(f"Config file not found at {config_path}")

    try:
        tree = ET.parse(config_path)
    except ET.ParseError as exc:
        raise ApiKeyError(f"Unable to parse {config_path}: {exc}") from exc

    api_key = tree.findtext("ApiKey")
    if not api_key:
        raise ApiKeyError(f"No ApiKey entry found in {config_path}")
    return api_key.strip()
