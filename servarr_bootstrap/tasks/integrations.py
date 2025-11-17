"""High-level integration tasks connecting services together."""

from __future__ import annotations

import logging
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

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


@dataclass
class IntegrationContext:
    root_dir: Path
    runtime: RuntimeContext
    console: Console
    silent_console: Console = field(default_factory=SilentConsole)
    env: Dict[str, str] = field(init=False)

    def __post_init__(self) -> None:
        self.env = dict(self.runtime.env.merged)


@dataclass
class IntegrationState:
    arr_api_keys: Dict[str, str] = field(default_factory=dict)
    prowlarr_client: Optional[ProwlarrClient] = None


IntegrationHandler = Callable[[IntegrationContext, IntegrationState], Tuple[str, str]]


def run_integration_tasks(root_dir: Path, runtime: RuntimeContext, console: Console) -> None:
    ctx = IntegrationContext(root_dir, runtime, console)
    state = IntegrationState()
    handlers: List[tuple[str, str, IntegrationHandler]] = [
        ("qbittorrent", "qBittorrent", _configure_qbittorrent),
        ("arr", "Sonarr/Radarr", _configure_arr_clients),
        ("prowlarr", "Prowlarr", _configure_prowlarr_applications),
        ("bazarr", "Bazarr", _configure_bazarr),
        ("recyclarr", "Recyclarr", _configure_recyclarr),
        ("cross_seed", "Cross-Seed", _configure_cross_seed),
        ("auth", "UI credentials", _configure_service_auth),
    ]
    steps = [ProgressStep(key, label, "Waiting") for key, label, _ in handlers]
    with ProgressTracker("Integrations", steps, console=console) as tracker:
        for key, label, handler in handlers:
            tracker.update(key, status="running", details=f"Configuring {label}")
            try:
                status, detail = handler(ctx, state)
            except IntegrationError as exc:
                tracker.update(key, status="failed", details=str(exc))
                raise
            final_status = status if status in {"done", "skipped"} else "done"
            detail_text = detail or ("Skipped" if final_status == "skipped" else "Completed")
            tracker.update(key, status=final_status, details=detail_text)


def _configure_qbittorrent(ctx: IntegrationContext, state: IntegrationState) -> tuple[str, str]:
    base_url = f"http://127.0.0.1:{_int_env(ctx, 'QBIT_WEBUI', 8080)}"
    lan_subnet = ctx.env.get("LAN_SUBNET")
    container_name = ctx.env.get("QBIT_CONTAINER_NAME", "qbittorrent")
    client = QbitClient(base_url, ctx.silent_console, ctx.runtime.options.dry_run, container_name=container_name)
    media_dir_value = ctx.env.get("MEDIA_DIR")

    def apply_credentials() -> bool:
        return client.ensure_credentials(
            desired_username=ctx.runtime.credentials.username,
            desired_password=ctx.runtime.credentials.password,
            lan_subnet=lan_subnet,
        )

    try:
        configured = _retry(ctx, "qBittorrent credentials", apply_credentials, exceptions=(QbitClientError,))
        if configured and media_dir_value:
            _retry(
                ctx,
                "qBittorrent storage layout",
                lambda: client.ensure_storage_layout(Path(media_dir_value)),
                exceptions=(QbitClientError,),
            )
        pf_status, pf_detail = ("skipped", "")
        if configured:
            pf_status, pf_detail = _sync_forwarded_port(ctx, client)
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

def _configure_arr_clients(ctx: IntegrationContext, state: IntegrationState) -> tuple[str, str]:
    use_vpn = _use_vpn(ctx.env)
    qbit_host = "gluetun" if use_vpn else "qbittorrent"
    qbit_port = _int_env(ctx, "QBIT_WEBUI", 8080)
    media_root = Path(ctx.env.get("MEDIA_DIR", "/mnt/media"))

    for target in ARR_TARGETS:
        try:
            api_key = read_arr_api_key(ctx.root_dir, target.service_key)
        except ApiKeyError as exc:
            raise IntegrationError(str(exc)) from exc
        state.arr_api_keys[target.service_key] = api_key

        port = _int_env(ctx, target.port_env, 0)
        base_url = f"http://127.0.0.1:{port}" if port else f"http://{target.service_key}:80"
        category = ctx.env.get(target.category_env, target.default_category)
        arr_client = ArrClient(
            target.name,
            base_url,
            api_key,
            ctx.silent_console,
            ctx.runtime.options.dry_run,
        )

        qb_config = QbittorrentConfig(
            host=qbit_host,
            port=qbit_port,
            username=ctx.runtime.credentials.username or "",
            password=ctx.runtime.credentials.password or "",
            category=category,
        )
        try:
            _retry(
                ctx,
                f"{target.name} download client",
                lambda: arr_client.ensure_qbittorrent_download_client(qb_config),
                exceptions=(ArrClientError,),
            )
            _retry(
                ctx,
                f"{target.name} root folder",
                lambda: arr_client.ensure_root_folder(media_root / target.media_subdir),
                exceptions=(ArrClientError,),
            )
        except ArrClientError as exc:
            raise IntegrationError(str(exc)) from exc
    return "done", "Download clients and root folders updated"


def _configure_prowlarr_applications(ctx: IntegrationContext, state: IntegrationState) -> tuple[str, str]:
    try:
        prowlarr_key = read_prowlarr_api_key(ctx.root_dir)
    except ApiKeyError as exc:
        raise IntegrationError(str(exc)) from exc

    prowlarr_port = _int_env(ctx, "PROWLARR_PORT", 9696)
    prowlarr_url_internal = f"http://prowlarr:{prowlarr_port}"
    client = ProwlarrClient(
        base_url=f"http://127.0.0.1:{prowlarr_port}",
        api_key=prowlarr_key,
        console=ctx.silent_console,
        dry_run=ctx.runtime.options.dry_run,
    )

    for target in ARR_TARGETS:
        try:
            api_key = read_arr_api_key(ctx.root_dir, target.service_key)
        except ApiKeyError as exc:
            raise IntegrationError(str(exc)) from exc

        arr_port = _int_env(ctx, target.port_env, target.default_port())
        arr_internal_url = f"http://{target.service_key}:{arr_port}"
        fields = {
            "prowlarrUrl": prowlarr_url_internal,
            "baseUrl": arr_internal_url,
            "apiKey": api_key,
        }
        try:
            _retry(
                ctx,
                f"Prowlarr {target.name} application",
                lambda: client.ensure_application(target.prowlarr_implementation(), fields, name=target.name),
                exceptions=(ProwlarrClientError,),
            )
        except ProwlarrClientError as exc:
            raise IntegrationError(str(exc)) from exc

    state.prowlarr_client = client

    flaresolverr_url = ctx.env.get("FLARESOLVERR_URL")
    if not flaresolverr_url:
        port = _int_env(ctx, "FLARESOLVERR_PORT", 8191)
        flaresolverr_url = f"http://flaresolverr:{port}/"
    flaresolverr_note = ""
    try:
        client.ensure_flaresolverr_proxy(flaresolverr_url)
    except ProwlarrClientError as exc:
        LOGGER.warning("Prowlarr proxy configuration skipped: %s", exc)
        flaresolverr_note = f" (FlareSolverr proxy skipped: {exc})"
    return "done", f"Applications synchronized{flaresolverr_note}"


def _configure_bazarr(ctx: IntegrationContext, state: IntegrationState) -> tuple[str, str]:
    try:
        bazarr_key = read_bazarr_api_key(ctx.root_dir)
    except ApiKeyError as exc:
        raise IntegrationError(str(exc)) from exc

    base_url = f"http://127.0.0.1:{_int_env(ctx, 'BAZARR_PORT', 6767)}"
    client = BazarrClient(base_url, bazarr_key, ctx.silent_console, ctx.runtime.options.dry_run)

    sonarr_key = state.arr_api_keys.get("sonarr")
    radarr_key = state.arr_api_keys.get("radarr")
    if not sonarr_key or not radarr_key:
        raise IntegrationError("Arr API keys not available for Bazarr integration")

    sonarr_cfg = BazarrArrConfig(
        host="sonarr",
        port=_int_env(ctx, "SONARR_PORT", 8989),
        api_key=sonarr_key,
        base_url=ctx.env.get("SONARR_BASE_URL", ""),
        use_ssl=False,
    )
    radarr_cfg = BazarrArrConfig(
        host="radarr",
        port=_int_env(ctx, "RADARR_PORT", 7878),
        api_key=radarr_key,
        base_url=ctx.env.get("RADARR_BASE_URL", ""),
        use_ssl=False,
    )

    creds = None
    if ctx.runtime.credentials.username and ctx.runtime.credentials.password:
        creds = (ctx.runtime.credentials.username, ctx.runtime.credentials.password)

    try:
        _retry(
            ctx,
            "Bazarr integrations",
            lambda: client.ensure_arr_integrations(sonarr_cfg, radarr_cfg, credentials=creds),
            exceptions=(BazarrClientError,),
        )
        _retry(
            ctx,
            "Bazarr language prefs",
            lambda: client.ensure_language_preferences(),
            exceptions=(BazarrClientError,),
        )
    except BazarrClientError as exc:
        raise IntegrationError(str(exc)) from exc
    return "done", "Bazarr linked to Sonarr/Radarr"


def _configure_service_auth(ctx: IntegrationContext, state: IntegrationState) -> tuple[str, str]:
    username = ctx.runtime.credentials.username
    password = ctx.runtime.credentials.password
    if not username or not password:
        return "skipped", "Credentials not provided"

    for target in ARR_TARGETS:
        try:
            api_key = read_arr_api_key(ctx.root_dir, target.service_key)
        except ApiKeyError as exc:
            raise IntegrationError(str(exc)) from exc

        arr_port = _int_env(ctx, target.port_env, target.default_port())
        arr_client = ArrClient(
            target.name,
            f"http://127.0.0.1:{arr_port}",
            api_key,
            ctx.silent_console,
            ctx.runtime.options.dry_run,
        )
        try:
            _retry(
                ctx,
                f"{target.name} UI credentials",
                lambda: arr_client.ensure_ui_credentials(username, password),
                exceptions=(ArrClientError,),
            )
        except ArrClientError as exc:
            raise IntegrationError(str(exc)) from exc

    if state.prowlarr_client:
        try:
            _retry(
                ctx,
                "Prowlarr UI credentials",
                lambda: state.prowlarr_client.ensure_ui_credentials(username, password),
                exceptions=(ProwlarrClientError,),
            )
        except ProwlarrClientError as exc:
            raise IntegrationError(str(exc)) from exc
    return "done", "UI credentials applied"


def _configure_recyclarr(ctx: IntegrationContext, state: IntegrationState) -> tuple[str, str]:
    manager = RecyclarrManager(ctx.root_dir, ctx.silent_console, ctx.runtime.options.dry_run)
    sonarr_key = state.arr_api_keys.get("sonarr")
    radarr_key = state.arr_api_keys.get("radarr")
    if not sonarr_key or not radarr_key:
        raise IntegrationError("Arr API keys not available for Recyclarr configuration")
    try:
        _retry(
            ctx,
            "Recyclarr config",
            lambda: manager.ensure_config(sonarr_key, radarr_key),
            exceptions=(RecyclarrError,),
        )
        _retry(
            ctx,
            "Recyclarr sync",
            lambda: manager.run_sync(),
            exceptions=(RecyclarrError,),
        )
    except RecyclarrError as exc:
        raise IntegrationError(str(exc)) from exc
    return "done", "Recyclarr config synced"


def _configure_cross_seed(ctx: IntegrationContext, state: IntegrationState) -> tuple[str, str]:
    username = ctx.runtime.credentials.username
    password = ctx.runtime.credentials.password
    torznab_urls: List[str] = []
    if state.prowlarr_client:
        try:
            indexers = state.prowlarr_client.list_indexers()
            torznab_urls = [
                f"http://prowlarr:9696/{idx['id']}/api?apikey={state.prowlarr_client.api_key}"
                for idx in indexers
                if idx.get("enable")
            ]
        except ProwlarrClientError as exc:
            raise IntegrationError(str(exc)) from exc

    torrent_clients: List[str] = []
    client_note = ""
    qbit_host = "gluetun" if _use_vpn(ctx.env) else "qbittorrent"
    if username and password:
        from urllib.parse import quote

        encoded = f"http://{quote(username)}:{quote(password)}@{qbit_host}:{_int_env(ctx, 'QBIT_WEBUI', 8080)}"
        torrent_clients.append(f"qbittorrent:{encoded}")
    else:
        client_note = " (torrent client skipped; no credentials)"

    media_dir = Path(ctx.env.get("MEDIA_DIR", "/mnt/media"))
    link_dir = media_dir / "downloads" / "cross-seeds"
    configurator = CrossSeedConfigurator(
        ctx.root_dir, ctx.silent_console, ctx.runtime.options.dry_run, link_dir=link_dir
    )

    def apply_cross_seed() -> None:
        configurator.ensure_config(
            torznab_urls=torznab_urls,
            sonarr_urls=[f"http://sonarr:8989?apikey={state.arr_api_keys.get('sonarr', '')}"],
            radarr_urls=[f"http://radarr:7878?apikey={state.arr_api_keys.get('radarr', '')}"],
            torrent_clients=torrent_clients,
        )

    try:
        _retry(ctx, "Cross-Seed config", apply_cross_seed, exceptions=(CrossSeedError,))
    except CrossSeedError as exc:
        raise IntegrationError(str(exc)) from exc
    return "done", f"Cross-Seed config updated{client_note}"


def _int_env(ctx: IntegrationContext, key: str, default: int) -> int:
    value = ctx.env.get(key)
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        ctx.console.print(f"[yellow]Invalid integer for {key}: {value}. Using default {default}[/yellow]")
        return default


def _sync_forwarded_port(ctx: IntegrationContext, client: QbitClient) -> tuple[str, str]:
    if not _use_vpn(ctx.env):
        return "skipped", ""
    if not _port_forwarding_enabled(ctx.env):
        return "skipped", "Port forwarding disabled"
    port = _await_forwarded_port(ctx, timeout=60, interval=5)
    if port is None:
        return "skipped", "Forwarded port not available"
    try:
        client.ensure_listen_port(port)
        return "done", f"Listen port set to {port}"
    except QbitClientError as exc:
        LOGGER.warning("Failed to synchronize qBittorrent listen port: %s", exc)
        return "skipped", f"Listen port update failed ({exc})"


def _await_forwarded_port(ctx: IntegrationContext, timeout: int, interval: int) -> Optional[int]:
    end = time.time() + timeout
    while time.time() < end:
        port = _read_forwarded_port()
        if port:
            return port
        if ctx.runtime.options.dry_run:
            break
        time.sleep(interval)
    return None


def _read_forwarded_port() -> Optional[int]:
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


def _use_vpn(env: Dict[str, str]) -> bool:
    return env.get("USE_VPN", "true").strip().lower() not in {"false", "0", "no", "off"}


def _port_forwarding_enabled(env: Dict[str, str]) -> bool:
    flag = env.get("VPN_PORT_FORWARDING_ENABLED")
    if flag:
        normalized = flag.strip().lower()
        return normalized in {"y", "yes", "true", "1"}
    compose_flag = env.get("VPN_PORT_FORWARDING")
    if compose_flag:
        return compose_flag.strip().lower() not in {"off", "false", "0", "no"}
    provider = env.get("PORT_FORWARDING_PROVIDER", "")
    return bool(provider.strip())


def _retry(
    ctx: IntegrationContext,
    label: str,
    func,
    *,
    attempts: int = 5,
    delay: float = 3.0,
    exceptions: tuple = (Exception,),
) -> any:
    last_exc = None
    for attempt in range(1, attempts + 1):
        try:
            return func()
        except exceptions as exc:
            last_exc = exc
            if attempt == attempts or ctx.runtime.options.dry_run:
                break
            LOGGER.warning("%s failed (attempt %s/%s): %s", label, attempt, attempts, exc)
            time.sleep(delay)
    if last_exc:
        raise last_exc
