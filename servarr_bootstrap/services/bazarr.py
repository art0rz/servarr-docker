"""Bazarr API integration helpers."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, Optional

import requests
from rich.console import Console

LOGGER = logging.getLogger("servarr.bootstrap.bazarr")


class BazarrClientError(RuntimeError):
    """Raised when Bazarr API calls fail."""


@dataclass
class BazarrArrConfig:
    host: str
    port: int
    api_key: str
    base_url: str = ""
    use_ssl: bool = False


class BazarrClient:
    def __init__(self, base_url: str, api_key: str, console: Console, dry_run: bool) -> None:
        self.base_url = base_url.rstrip("/")
        self.console = console
        self.dry_run = dry_run
        self.session = requests.Session()
        self.session.headers.update({"X-API-KEY": api_key})

    def ensure_arr_integrations(
        self,
        sonarr_config: BazarrArrConfig,
        radarr_config: BazarrArrConfig,
        credentials: Optional[tuple[str, str]] = None,
    ) -> None:
        """Enable Sonarr/Radarr integrations with Bazarr."""
        self.console.print("[cyan]Bazarr:[/] ensuring Sonarr/Radarr integrations")

        payload: Dict[str, str] = {
            "settings-general-use_sonarr": _format_bool(True),
            "settings-sonarr-ip": sonarr_config.host,
            "settings-sonarr-port": str(sonarr_config.port),
            "settings-sonarr-ssl": _format_bool(sonarr_config.use_ssl),
            "settings-sonarr-base_url": sonarr_config.base_url or "",
            "settings-sonarr-apikey": sonarr_config.api_key,
            "settings-general-use_radarr": _format_bool(True),
            "settings-radarr-ip": radarr_config.host,
            "settings-radarr-port": str(radarr_config.port),
            "settings-radarr-ssl": _format_bool(radarr_config.use_ssl),
            "settings-radarr-base_url": radarr_config.base_url or "",
            "settings-radarr-apikey": radarr_config.api_key,
        }

        if credentials and all(credentials):
            username, password = credentials
            payload["settings-auth-username"] = username
            payload["settings-auth-password"] = password
            payload["settings-auth-type"] = "forms"

        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] Would POST Bazarr settings payload")
            return

        response = self.session.post(
            f"{self.base_url}/api/system/settings",
            data=payload,
            timeout=15,
        )
        if response.status_code >= 400:
            raise BazarrClientError(f"Failed to apply Bazarr settings: {response.status_code} {response.text}")
        self.console.print("[green]Bazarr:[/] Sonarr/Radarr integrations configured")
def _format_bool(value: bool) -> str:
    return "true" if value else "false"
