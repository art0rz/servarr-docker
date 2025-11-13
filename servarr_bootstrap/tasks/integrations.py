"""High-level integration tasks connecting services together."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List

from rich.console import Console

from ..config import RuntimeContext
from ..services.api_keys import (
    ApiKeyError,
    read_arr_api_key,
    read_prowlarr_api_key,
    read_bazarr_api_key,
)
from ..services.arr import ArrClient, ArrClientError, QbittorrentConfig
from ..services.bazarr import BazarrArrConfig, BazarrClient, BazarrClientError
from ..services.cross_seed import CrossSeedConfigurator, CrossSeedError
from ..services.prowlarr import ProwlarrClient, ProwlarrClientError
from ..services.qbittorrent import QbitClient, QbitClientError
from ..services.recyclarr import RecyclarrManager, RecyclarrError

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
    media_subdir: str

    def default_port(self) -> int:
        return 8989 if self.service_key == "sonarr" else 7878

    def prowlarr_implementation(self) -> str:
        return self.name


ARR_TARGETS: List[ArrTarget] = [
    ArrTarget(
        name="Sonarr",
        service_key="sonarr",
        port_env="SONARR_PORT",
        category_env="SONARR_QBIT_CATEGORY",
        default_category="sonarr-tv",
        media_subdir="tv",
    ),
    ArrTarget(
        name="Radarr",
        service_key="radarr",
        port_env="RADARR_PORT",
        category_env="RADARR_QBIT_CATEGORY",
        default_category="radarr-movies",
        media_subdir="movies",
    ),
]


def run_integration_tasks(root_dir: Path, runtime: RuntimeContext, console: Console) -> None:
        runner = IntegrationRunner(root_dir, runtime, console)
        runner.configure_qbittorrent()
        runner.configure_arr_clients()
        runner.configure_prowlarr_applications()
        runner.configure_bazarr()
        runner.configure_recyclarr()
        runner.configure_cross_seed()
        runner.configure_service_auth()


class IntegrationRunner:
    def __init__(self, root_dir: Path, runtime: RuntimeContext, console: Console) -> None:
        self.root_dir = root_dir
        self.runtime = runtime
        self.console = console
        self.env = runtime.env.merged
        self.arr_api_keys: Dict[str, str] = {}

    def configure_qbittorrent(self) -> None:
        base_url = f"http://127.0.0.1:{self._int_env('QBIT_WEBUI', 8080)}"
        lan_subnet = self.env.get("LAN_SUBNET")
        container_name = self.env.get("QBIT_CONTAINER_NAME", "qbittorrent")
        client = QbitClient(base_url, self.console, self.runtime.options.dry_run, container_name=container_name)
        media_dir_value = self.env.get("MEDIA_DIR")
        try:
            configured = client.ensure_credentials(
                desired_username=self.runtime.credentials.username,
                desired_password=self.runtime.credentials.password,
                lan_subnet=lan_subnet,
            )
            if configured and media_dir_value:
                client.ensure_storage_layout(Path(media_dir_value))
        except QbitClientError as exc:
            self.console.print(f"[yellow]qBittorrent configuration skipped:[/] {exc}")
            LOGGER.warning("qBittorrent configuration skipped: %s", exc)

    def configure_arr_clients(self) -> None:
        use_vpn = self.env.get("USE_VPN", "true").strip().lower() not in {"false", "0", "no", "off"}
        qbit_host = "gluetun" if use_vpn else "qbittorrent"
        qbit_port = self._int_env("QBIT_WEBUI", 8080)
        media_root = Path(self.env.get("MEDIA_DIR", "/mnt/media"))

        for target in ARR_TARGETS:
            try:
                api_key = read_arr_api_key(self.root_dir, target.service_key)
            except ApiKeyError as exc:
                raise IntegrationError(str(exc)) from exc
            self.arr_api_keys[target.service_key] = api_key

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
                arr_client.ensure_root_folder(media_root / target.media_subdir)
            except ArrClientError as exc:
                raise IntegrationError(str(exc)) from exc

    def configure_prowlarr_applications(self) -> None:
        try:
            prowlarr_key = read_prowlarr_api_key(self.root_dir)
        except ApiKeyError as exc:
            raise IntegrationError(str(exc)) from exc

        prowlarr_url_internal = f"http://prowlarr:{self._int_env('PROWLARR_PORT', 9696)}"
        client = ProwlarrClient(
            base_url=f"http://127.0.0.1:{self._int_env('PROWLARR_PORT', 9696)}",
            api_key=prowlarr_key,
            console=self.console,
            dry_run=self.runtime.options.dry_run,
        )

        for target in ARR_TARGETS:
            try:
                api_key = read_arr_api_key(self.root_dir, target.service_key)
            except ApiKeyError as exc:
                raise IntegrationError(str(exc)) from exc

            arr_port = self._int_env(target.port_env, target.default_port())
            arr_internal_url = f"http://{target.service_key}:{arr_port}"
            fields = {
                "prowlarrUrl": prowlarr_url_internal,
                "baseUrl": arr_internal_url,
                "apiKey": api_key,
            }
            try:
                client.ensure_application(target.prowlarr_implementation(), fields, name=target.name)
            except ProwlarrClientError as exc:
                raise IntegrationError(str(exc)) from exc

        self.prowlarr_client = client

        flaresolverr_url = self.env.get("FLARESOLVERR_URL")
        if not flaresolverr_url:
            port = self._int_env("FLARESOLVERR_PORT", 8191)
            flaresolverr_url = f"http://flaresolverr:{port}/"
        try:
            client.ensure_flaresolverr_proxy(flaresolverr_url)
        except ProwlarrClientError as exc:
            self.console.print(f"[yellow]Prowlarr proxy skipped:[/] {exc}")
            LOGGER.warning("Prowlarr proxy configuration skipped: %s", exc)

    def configure_bazarr(self) -> None:
        try:
            bazarr_key = read_bazarr_api_key(self.root_dir)
        except ApiKeyError as exc:
            raise IntegrationError(str(exc)) from exc

        base_url = f"http://127.0.0.1:{self._int_env('BAZARR_PORT', 6767)}"
        client = BazarrClient(base_url, bazarr_key, self.console, self.runtime.options.dry_run)

        sonarr_key = self.arr_api_keys.get("sonarr")
        radarr_key = self.arr_api_keys.get("radarr")
        if not sonarr_key or not radarr_key:
            raise IntegrationError("Arr API keys not available for Bazarr integration")

        sonarr_cfg = BazarrArrConfig(
            host="sonarr",
            port=self._int_env("SONARR_PORT", 8989),
            api_key=sonarr_key,
            base_url=self.env.get("SONARR_BASE_URL", ""),
            use_ssl=False,
        )
        radarr_cfg = BazarrArrConfig(
            host="radarr",
            port=self._int_env("RADARR_PORT", 7878),
            api_key=radarr_key,
            base_url=self.env.get("RADARR_BASE_URL", ""),
            use_ssl=False,
        )

        creds = None
        if self.runtime.credentials.username and self.runtime.credentials.password:
            creds = (self.runtime.credentials.username, self.runtime.credentials.password)

        try:
            client.ensure_arr_integrations(sonarr_cfg, radarr_cfg, credentials=creds)
            client.ensure_language_preferences()
        except BazarrClientError as exc:
            raise IntegrationError(str(exc)) from exc

    def configure_service_auth(self) -> None:
        username = self.runtime.credentials.username
        password = self.runtime.credentials.password
        if not username or not password:
            return

        for target in ARR_TARGETS:
            try:
                api_key = read_arr_api_key(self.root_dir, target.service_key)
            except ApiKeyError as exc:
                raise IntegrationError(str(exc)) from exc

            arr_port = self._int_env(target.port_env, target.default_port())
            arr_client = ArrClient(
                target.name,
                f"http://127.0.0.1:{arr_port}",
                api_key,
                self.console,
                self.runtime.options.dry_run,
            )
            try:
                arr_client.ensure_ui_credentials(username, password)
            except ArrClientError as exc:
                raise IntegrationError(str(exc)) from exc

        if hasattr(self, "prowlarr_client"):
            try:
                self.prowlarr_client.ensure_ui_credentials(username, password)
            except ProwlarrClientError as exc:
                raise IntegrationError(str(exc)) from exc

    def configure_recyclarr(self) -> None:
        manager = RecyclarrManager(self.root_dir, self.console, self.runtime.options.dry_run)
        sonarr_key = self.arr_api_keys.get("sonarr")
        radarr_key = self.arr_api_keys.get("radarr")
        if not sonarr_key or not radarr_key:
            raise IntegrationError("Arr API keys not available for Recyclarr configuration")
        try:
            manager.ensure_config(sonarr_key, radarr_key)
            manager.run_sync()
        except RecyclarrError as exc:
            raise IntegrationError(str(exc)) from exc

    def configure_cross_seed(self) -> None:
        username = self.runtime.credentials.username
        password = self.runtime.credentials.password
        torznab_urls = []
        if hasattr(self, "prowlarr_client"):
            try:
                indexers = self.prowlarr_client.list_indexers()
                torznab_urls = [
                    f"http://prowlarr:9696/{idx['id']}/api?apikey={self.prowlarr_client.api_key}"
                    for idx in indexers
                    if idx.get("enable")
                ]
            except ProwlarrClientError as exc:
                raise IntegrationError(str(exc)) from exc

        torrent_clients = []
        qbit_host = "gluetun" if self.env.get("USE_VPN", "true").strip().lower() not in {"false", "0", "no", "off"} else "qbittorrent"
        if username and password:
            from urllib.parse import quote

            encoded = (
                f"http://{quote(username)}:{quote(password)}@{qbit_host}:{self._int_env('QBIT_WEBUI', 8080)}"
            )
            torrent_clients.append(f"qbittorrent:{encoded}")
        else:
            self.console.print("[yellow]Cross-Seed:[/] Skipping torrent client config (no credentials)")

        media_dir = Path(self.env.get("MEDIA_DIR", "/mnt/media"))
        link_dir = media_dir / "downloads" / "cross-seeds"
        configurator = CrossSeedConfigurator(self.root_dir, self.console, self.runtime.options.dry_run, link_dir=link_dir)
        try:
            configurator.ensure_config(
                torznab_urls=torznab_urls,
                sonarr_urls=[f"http://sonarr:8989?apikey={self.arr_api_keys.get('sonarr', '')}"],
                radarr_urls=[f"http://radarr:7878?apikey={self.arr_api_keys.get('radarr', '')}"],
                torrent_clients=torrent_clients,
            )
        except CrossSeedError as exc:
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
