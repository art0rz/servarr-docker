"""High-level integration tasks connecting services together."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import List

from rich.console import Console

from ..config import RuntimeContext
from ..services.api_keys import ApiKeyError, read_arr_api_key
from ..services.arr import ArrClient, ArrClientError, QbittorrentConfig
from ..services.qbittorrent import QbitClient, QbitClientError

LOGGER = logging.getLogger("servarr.bootstrap.integrations")


class IntegrationError(RuntimeError):
    """Raised when an integration step fails."""


@dataclass
class ArrTarget:
    name: str
    service_key: str
    port_env: str
    category_env: str
    default_category: str


ARR_TARGETS: List[ArrTarget] = [
    ArrTarget(
        name="Sonarr",
        service_key="sonarr",
        port_env="SONARR_PORT",
        category_env="SONARR_QBIT_CATEGORY",
        default_category="sonarr-tv",
    ),
    ArrTarget(
        name="Radarr",
        service_key="radarr",
        port_env="RADARR_PORT",
        category_env="RADARR_QBIT_CATEGORY",
        default_category="radarr-movies",
    ),
]


def run_integration_tasks(root_dir: Path, runtime: RuntimeContext, console: Console) -> None:
    runner = IntegrationRunner(root_dir, runtime, console)
    runner.configure_qbittorrent()
    runner.configure_arr_clients()


class IntegrationRunner:
    def __init__(self, root_dir: Path, runtime: RuntimeContext, console: Console) -> None:
        self.root_dir = root_dir
        self.runtime = runtime
        self.console = console
        self.env = runtime.env.merged

    def configure_qbittorrent(self) -> None:
        base_url = f"http://127.0.0.1:{self._int_env('QBIT_WEBUI', 8080)}"
        lan_subnet = self.env.get("LAN_SUBNET")
        client = QbitClient(base_url, self.console, self.runtime.options.dry_run)
        try:
            client.ensure_credentials(
                desired_username=self.runtime.credentials.username,
                desired_password=self.runtime.credentials.password,
                lan_subnet=lan_subnet,
            )
        except QbitClientError as exc:
            raise IntegrationError(str(exc)) from exc

    def configure_arr_clients(self) -> None:
        use_vpn = self.env.get("USE_VPN", "true").strip().lower() not in {"false", "0", "no", "off"}
        qbit_host = "gluetun" if use_vpn else "qbittorrent"
        qbit_port = self._int_env("QBIT_WEBUI", 8080)

        for target in ARR_TARGETS:
            try:
                api_key = read_arr_api_key(self.root_dir, target.service_key)
            except ApiKeyError as exc:
                raise IntegrationError(str(exc)) from exc

            port = self._int_env(target.port_env, 0)
            base_url = f"http://127.0.0.1:{port}" if port else f"http://{target.service_key}:80"
            category = self.env.get(target.category_env, target.default_category)
            arr_client = ArrClient(target.name, base_url, api_key, self.console, self.runtime.options.dry_run)

            try:
                arr_client.ensure_qbittorrent_download_client(
                    QbittorrentConfig(
                        host=qbit_host,
                        port=qbit_port,
                        username=self.runtime.credentials.username or "",
                        password=self.runtime.credentials.password or "",
                        category=category,
                    )
                )
            except ArrClientError as exc:
                raise IntegrationError(str(exc)) from exc

    def _int_env(self, key: str, default: int) -> int:
        value = self.env.get(key)
        if not value:
            return default
        try:
            return int(value)
        except ValueError:
            self.console.print(f"[yellow]Invalid integer for {key}: {value}. Using default {default}[/yellow]")
            return default
