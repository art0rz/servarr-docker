"""High-level integration tasks connecting services together."""

from __future__ import annotations

import logging
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

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
from ..utils.progress import ProgressStep, ProgressTracker

LOGGER = logging.getLogger("servarr.bootstrap.integrations")


class SilentConsole:
    """Console shim that drops all output."""

    def print(self, *args, **kwargs) -> None:  # pragma: no cover - trivial forwarding
        return


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


INTEGRATION_STEPS = [
    ("qbittorrent", "qBittorrent"),
    ("arr", "Sonarr/Radarr"),
    ("prowlarr", "Prowlarr"),
    ("bazarr", "Bazarr"),
    ("recyclarr", "Recyclarr"),
    ("cross_seed", "Cross-Seed"),
    ("auth", "UI credentials"),
]


def run_integration_tasks(root_dir: Path, runtime: RuntimeContext, console: Console) -> None:
    runner = IntegrationRunner(root_dir, runtime, console)
    steps = [ProgressStep(key, label, "Waiting") for key, label in INTEGRATION_STEPS]
    with ProgressTracker("Integrations", steps, console=console) as tracker:
        def run_step(key: str, label: str, func) -> None:
            tracker.update(key, status="running", details=f"Configuring {label}")
            try:
                status, detail = func()
            except IntegrationError as exc:
                tracker.update(key, status="failed", details=str(exc))
                raise
            final_status = status if status in {"done", "skipped"} else "done"
            detail_text = detail or ("Skipped" if final_status == "skipped" else "Completed")
            tracker.update(key, status=final_status, details=detail_text)

        run_step("qbittorrent", "qBittorrent", runner.configure_qbittorrent)
        run_step("arr", "Sonarr/Radarr", runner.configure_arr_clients)
        run_step("prowlarr", "Prowlarr", runner.configure_prowlarr_applications)
        run_step("bazarr", "Bazarr", runner.configure_bazarr)
        run_step("recyclarr", "Recyclarr", runner.configure_recyclarr)
        run_step("cross_seed", "Cross-Seed", runner.configure_cross_seed)
        run_step("auth", "UI credentials", runner.configure_service_auth)


class IntegrationRunner:
    def __init__(self, root_dir: Path, runtime: RuntimeContext, console: Console) -> None:
        self.root_dir = root_dir
        self.runtime = runtime
        self.console = console
        self.env = runtime.env.merged
        self.arr_api_keys: Dict[str, str] = {}
        self._silent_console = SilentConsole()

    def configure_qbittorrent(self) -> tuple[str, str]:
        base_url = f"http://127.0.0.1:{self._int_env('QBIT_WEBUI', 8080)}"
        lan_subnet = self.env.get("LAN_SUBNET")
        container_name = self.env.get("QBIT_CONTAINER_NAME", "qbittorrent")
        client = QbitClient(base_url, self._silent_console, self.runtime.options.dry_run, container_name=container_name)
        media_dir_value = self.env.get("MEDIA_DIR")
        try:
            configured = client.ensure_credentials(
                desired_username=self.runtime.credentials.username,
                desired_password=self.runtime.credentials.password,
                lan_subnet=lan_subnet,
            )
            if configured and media_dir_value:
                client.ensure_storage_layout(Path(media_dir_value))
            pf_status, pf_detail = ("skipped", "")
            if configured:
                pf_status, pf_detail = self._sync_forwarded_port(client)
        except QbitClientError as exc:
            LOGGER.warning("qBittorrent configuration skipped: %s", exc)
            return "skipped", f"Skipped: {exc}"

        detail_parts: List[str] = []
        if configured and media_dir_value:
            detail_parts.append("Credentials + storage layout updated")
        elif configured:
            detail_parts.append("Credentials synchronized")
        else:
            detail_parts.append("Skipped credential sync (credentials missing)")
        if pf_detail:
            detail_parts.append(pf_detail)
        status = "done" if configured else "skipped"
        return status, "; ".join(detail_parts)

    def configure_arr_clients(self) -> tuple[str, str]:
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
            arr_client = ArrClient(
                target.name,
                base_url,
                api_key,
                self._silent_console,
                self.runtime.options.dry_run,
            )

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
        return "done", "Download clients and root folders updated"

    def configure_prowlarr_applications(self) -> tuple[str, str]:
        try:
            prowlarr_key = read_prowlarr_api_key(self.root_dir)
        except ApiKeyError as exc:
            raise IntegrationError(str(exc)) from exc

        prowlarr_port = self._int_env("PROWLARR_PORT", 9696)
        prowlarr_url_internal = f"http://prowlarr:{prowlarr_port}"
        client = ProwlarrClient(
            base_url=f"http://127.0.0.1:{prowlarr_port}",
            api_key=prowlarr_key,
            console=self._silent_console,
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
        flaresolverr_note = ""
        try:
            client.ensure_flaresolverr_proxy(flaresolverr_url)
        except ProwlarrClientError as exc:
            LOGGER.warning("Prowlarr proxy configuration skipped: %s", exc)
            flaresolverr_note = f" (FlareSolverr proxy skipped: {exc})"
        return "done", f"Applications synchronized{flaresolverr_note}"

    def configure_bazarr(self) -> tuple[str, str]:
        try:
            bazarr_key = read_bazarr_api_key(self.root_dir)
        except ApiKeyError as exc:
            raise IntegrationError(str(exc)) from exc

        base_url = f"http://127.0.0.1:{self._int_env('BAZARR_PORT', 6767)}"
        client = BazarrClient(base_url, bazarr_key, self._silent_console, self.runtime.options.dry_run)

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
        return "done", "Bazarr linked to Sonarr/Radarr"

    def configure_service_auth(self) -> tuple[str, str]:
        username = self.runtime.credentials.username
        password = self.runtime.credentials.password
        if not username or not password:
            return "skipped", "Credentials not provided"

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
                self._silent_console,
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
        return "done", "UI credentials applied"

    def configure_recyclarr(self) -> tuple[str, str]:
        manager = RecyclarrManager(self.root_dir, self._silent_console, self.runtime.options.dry_run)
        sonarr_key = self.arr_api_keys.get("sonarr")
        radarr_key = self.arr_api_keys.get("radarr")
        if not sonarr_key or not radarr_key:
            raise IntegrationError("Arr API keys not available for Recyclarr configuration")
        try:
            manager.ensure_config(sonarr_key, radarr_key)
            manager.run_sync()
        except RecyclarrError as exc:
            raise IntegrationError(str(exc)) from exc
        return "done", "Recyclarr config synced"

    def configure_cross_seed(self) -> tuple[str, str]:
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
        client_note = ""
        if username and password:
            from urllib.parse import quote

            encoded = (
                f"http://{quote(username)}:{quote(password)}@{qbit_host}:{self._int_env('QBIT_WEBUI', 8080)}"
            )
            torrent_clients.append(f"qbittorrent:{encoded}")
        else:
            client_note = " (torrent client skipped; no credentials)"

        media_dir = Path(self.env.get("MEDIA_DIR", "/mnt/media"))
        link_dir = media_dir / "downloads" / "cross-seeds"
        configurator = CrossSeedConfigurator(
            self.root_dir, self._silent_console, self.runtime.options.dry_run, link_dir=link_dir
        )
        try:
            configurator.ensure_config(
                torznab_urls=torznab_urls,
                sonarr_urls=[f"http://sonarr:8989?apikey={self.arr_api_keys.get('sonarr', '')}"],
                radarr_urls=[f"http://radarr:7878?apikey={self.arr_api_keys.get('radarr', '')}"],
                torrent_clients=torrent_clients,
            )
        except CrossSeedError as exc:
            raise IntegrationError(str(exc)) from exc
        return "done", f"Cross-Seed config updated{client_note}"

    def _int_env(self, key: str, default: int) -> int:
        value = self.env.get(key)
        if not value:
            return default
        try:
            return int(value)
        except ValueError:
            self.console.print(f"[yellow]Invalid integer for {key}: {value}. Using default {default}[/yellow]")
            return default

    def _sync_forwarded_port(self, client: QbitClient) -> tuple[str, str]:
        if not self._use_vpn():
            return "skipped", ""
        if not self._port_forwarding_enabled():
            return "skipped", "Port forwarding disabled"
        port = self._await_forwarded_port(timeout=60, interval=5)
        if port is None:
            return "skipped", "Forwarded port not available"
        try:
            client.ensure_listen_port(port)
            return "done", f"Listen port set to {port}"
        except QbitClientError as exc:
            LOGGER.warning("Failed to synchronize qBittorrent listen port: %s", exc)
            return "skipped", f"Listen port update failed ({exc})"

    def _await_forwarded_port(self, timeout: int, interval: int) -> Optional[int]:
        end = time.time() + timeout
        while time.time() < end:
            port = self._read_forwarded_port()
            if port:
                return port
            time.sleep(interval)
        return None

    def _read_forwarded_port(self) -> Optional[int]:
        try:
            result = subprocess.run(
                ["docker", "exec", "gluetun", "sh", "-c", "cat /tmp/gluetun/forwarded_port 2>/dev/null || true"],
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            LOGGER.debug("Docker CLI not available for forwarded port sync")
            return None
        if result.returncode != 0:
            return None
        value = result.stdout.strip()
        return int(value) if value.isdigit() else None

    def _use_vpn(self) -> bool:
        return self.env.get("USE_VPN", "true").strip().lower() not in {"false", "0", "no", "off"}

    def _port_forwarding_enabled(self) -> bool:
        flag = self.env.get("VPN_PORT_FORWARDING_ENABLED")
        if flag:
            normalized = flag.strip().lower()
            return normalized in {"y", "yes", "true", "1"}
        compose_flag = self.env.get("VPN_PORT_FORWARDING")
        if compose_flag:
            return compose_flag.strip().lower() not in {"off", "false", "0", "no"}
        provider = self.env.get("PORT_FORWARDING_PROVIDER", "")
        return bool(provider.strip())
