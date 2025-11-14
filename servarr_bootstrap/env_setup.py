"""Interactive .env helper."""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

try:  # pragma: no cover - only triggered in limited environments
    import typer
except ImportError:  # pragma: no cover
    class _TyperShim:
        def prompt(self, *args, **kwargs):
            raise RuntimeError("Typer is required for interactive prompts. Install it in your environment.")

    typer = _TyperShim()

from dotenv import dotenv_values
from rich.console import Console

@dataclass(frozen=True)
class EnvPrompt:
    key: str
    message: str
    default: str = ""
    secret: bool = False
    required: bool = True
    persist: bool = True


@dataclass(frozen=True)
class PromptSection:
    title: str
    description: str
    prompts: List[EnvPrompt]


def _default_uid() -> str:
    try:
        return str(os.getuid())
    except AttributeError:
        return "1000"


def _default_gid() -> str:
    try:
        return str(os.getgid())
    except AttributeError:
        return "1000"


VPN_FILTER_FLAG = "VPN_FILTERS_ENABLED"
VPN_HOSTNAME_FLAG = "VPN_HOSTNAME_FILTERS_ENABLED"
VPN_PORT_FORWARD_FLAG = "VPN_PORT_FORWARDING_ENABLED"
WIREGUARD_ADVANCED_FLAG = "WIREGUARD_ADVANCED_ENABLED"
VPN_LOCATION_EXTRA_FLAG = "VPN_LOCATION_EXTRA_ENABLED"

PROMPT_SECTIONS: List[PromptSection] = [
    PromptSection(
        "Storage & Network",
        "Where media lives and how containers reach your LAN.",
        [
            EnvPrompt("MEDIA_DIR", "Media directory for downloads and library", "/mnt/media"),
            EnvPrompt("PUID", "Container user ID (PUID)", _default_uid()),
            EnvPrompt("PGID", "Container group ID (PGID)", _default_gid()),
            EnvPrompt("LAN_SUBNET", "LAN subnet (CIDR) for allowlists", "192.168.1.0/24"),
            EnvPrompt("TZ", "System timezone", "", required=True),
        ],
    ),
    PromptSection(
        "Unified Credentials",
        "Shared username/password applied to Sonarr, Radarr, Prowlarr, Bazarr, and qBittorrent.",
        [
            EnvPrompt("SERVARR_USERNAME", "Username for Sonarr/Radarr/Prowlarr/qBittorrent/Bazarr", "servarr"),
            EnvPrompt("SERVARR_PASSWORD", "Password for Sonarr/Radarr/Prowlarr/qBittorrent/Bazarr", secret=True),
        ],
    ),
    PromptSection(
        "VPN Basics",
        "Pick your VPN provider and protocol.",
        [
            EnvPrompt("USE_VPN", "Use VPN tunnel? (true/false)", "true"),
            EnvPrompt("VPN_SERVICE_PROVIDER", "VPN provider (gluetun supported value)", ""),
            EnvPrompt("VPN_TYPE", "VPN protocol (wireguard/openvpn)", "wireguard"),
        ],
    ),
    PromptSection(
        "WireGuard Keys",
        "Required when VPN protocol is WireGuard.",
        [
            EnvPrompt("WIREGUARD_PRIVATE_KEY", "WireGuard private key", secret=True),
            EnvPrompt("WIREGUARD_ADDRESSES", "WireGuard interface addresses (CIDR)", ""),
            EnvPrompt(
                WIREGUARD_ADVANCED_FLAG,
                "Configure advanced WireGuard options? (y/n)",
                "n",
                required=False,
            ),
            EnvPrompt("WIREGUARD_PUBLIC_KEY", "WireGuard server public key override", required=False, secret=True),
            EnvPrompt("WIREGUARD_ENDPOINT_IP", "WireGuard endpoint IP override", required=False),
            EnvPrompt("WIREGUARD_ENDPOINT_PORT", "WireGuard endpoint port override", required=False),
            EnvPrompt("WIREGUARD_PRESHARED_KEY", "WireGuard pre-shared key", required=False, secret=True),
            EnvPrompt("WIREGUARD_ALLOWED_IPS", "WireGuard allowed IPs override", required=False),
            EnvPrompt("WIREGUARD_IMPLEMENTATION", "WireGuard implementation override", required=False),
            EnvPrompt("WIREGUARD_MTU", "WireGuard MTU override", required=False),
            EnvPrompt(
                "WIREGUARD_PERSISTENT_KEEPALIVE_INTERVAL",
                "WireGuard persistent keepalive interval",
                required=False,
            ),
        ],
    ),
    PromptSection(
        "VPN Location Filters",
        "Optional filters to pin VPN connections to specific regions.",
        [
            EnvPrompt(
                VPN_FILTER_FLAG,
                "Restrict VPN servers by country/region? (y/n)",
                "n",
                required=False,
            ),
            EnvPrompt("SERVER_COUNTRIES", "Preferred VPN countries", required=False),
            EnvPrompt(
                VPN_LOCATION_EXTRA_FLAG,
                "Add region/city filters without a country? (y/n)",
                "n",
                required=False,
            ),
            EnvPrompt("SERVER_REGIONS", "Preferred VPN regions", required=False),
            EnvPrompt("SERVER_CITIES", "Preferred VPN cities", required=False),
        ],
    ),
    PromptSection(
        "Hostnames & Port Forwarding",
        "Advanced VPN options (rarely needed).",
        [
            EnvPrompt(
                VPN_HOSTNAME_FLAG,
                "Restrict VPN servers to specific hostnames? (y/n)",
                "n",
                required=False,
            ),
            EnvPrompt("SERVER_HOSTNAMES", "Specific VPN hostnames", required=False),
            EnvPrompt("SERVER_NAMES", "Specific VPN server names", required=False),
            EnvPrompt(
                VPN_PORT_FORWARD_FLAG,
                "Enable VPN port forwarding? (y/n)",
                "n",
                required=False,
            ),
            EnvPrompt("PORT_FORWARDING_PROVIDER", "Port forwarding provider", required=False),
        ],
    ),
    PromptSection(
        "Application Ports",
        "Expose the container UIs on your host.",
        [
            EnvPrompt("QBIT_WEBUI", "qBittorrent WebUI port", "8080"),
            EnvPrompt("PROWLARR_PORT", "Prowlarr port", "9696"),
            EnvPrompt("SONARR_PORT", "Sonarr port", "8989"),
            EnvPrompt("RADARR_PORT", "Radarr port", "7878"),
            EnvPrompt("BAZARR_PORT", "Bazarr port", "6767"),
            EnvPrompt("FLARESOLVERR_PORT", "FlareSolverr port", "8191"),
            EnvPrompt("CROSS_SEED_PORT", "Cross-seed port", "2468"),
            EnvPrompt("HEALTH_PORT", "Health server port", "3000"),
        ],
    ),
]

VPN_DEPENDENT_KEYS = {
    "VPN_SERVICE_PROVIDER",
    "VPN_TYPE",
    "WIREGUARD_PRIVATE_KEY",
    "WIREGUARD_ADDRESSES",
    WIREGUARD_ADVANCED_FLAG,
    "WIREGUARD_PUBLIC_KEY",
    "WIREGUARD_ENDPOINT_IP",
    "WIREGUARD_ENDPOINT_PORT",
    "WIREGUARD_PRESHARED_KEY",
    "WIREGUARD_ALLOWED_IPS",
    "WIREGUARD_IMPLEMENTATION",
    "WIREGUARD_MTU",
    "WIREGUARD_PERSISTENT_KEEPALIVE_INTERVAL",
    VPN_FILTER_FLAG,
    VPN_LOCATION_EXTRA_FLAG,
    VPN_HOSTNAME_FLAG,
    VPN_PORT_FORWARD_FLAG,
    "SERVER_COUNTRIES",
    "SERVER_REGIONS",
    "SERVER_CITIES",
    "SERVER_HOSTNAMES",
    "SERVER_NAMES",
    "PORT_FORWARDING_PROVIDER",
}

VPN_COUNTRY_CITY_KEYS = {"SERVER_COUNTRIES", "SERVER_REGIONS", "SERVER_CITIES"}
VPN_REGION_CITY_AFTER_COUNTRY = {"SERVER_REGIONS", "SERVER_CITIES"}
VPN_HOST_KEYS = {"SERVER_HOSTNAMES", "SERVER_NAMES"}
WIREGUARD_REQUIRED_KEYS = {"WIREGUARD_PRIVATE_KEY", "WIREGUARD_ADDRESSES"}
WIREGUARD_ADVANCED_KEYS = {
    "WIREGUARD_PUBLIC_KEY",
    "WIREGUARD_ENDPOINT_IP",
    "WIREGUARD_ENDPOINT_PORT",
    "WIREGUARD_PRESHARED_KEY",
    "WIREGUARD_ALLOWED_IPS",
    "WIREGUARD_IMPLEMENTATION",
    "WIREGUARD_MTU",
    "WIREGUARD_PERSISTENT_KEEPALIVE_INTERVAL",
}


def interactive_env_setup(root_dir: Path, console: Console) -> None:
    """Ensure required values exist in .env, prompting when interactive."""

    env_path = root_dir / ".env"
    if not env_path.exists():
        env_path.touch()

    existing: Dict[str, str] = {
        k: v for k, v in dotenv_values(env_path).items() if v is not None
    }

    tz_default = detect_timezone()
    sections = _with_timezone_default(PROMPT_SECTIONS, tz_default or "UTC")
    flattened_prompts = [prompt for section in sections for prompt in section.prompts]

    missing_prompts = [prompt for prompt in flattened_prompts if prompt.key not in existing]
    if not missing_prompts:
        return

    new_entries: List[tuple[str, str]] = []
    collected = existing.copy()
    console.print("[cyan].env:[/] Missing configuration detected. We'll go step by step.")
    for section in sections:
        section_has_prompt = False
        for prompt in section.prompts:
            if prompt.key in existing:
                continue
            if not _should_prompt(prompt.key, collected):
                continue
            if not section_has_prompt:
                console.print()
                console.print(f"[cyan bold]{section.title}[/cyan bold]")
                if section.description:
                    console.print(f"[bold]{section.description}[/bold]")
                section_has_prompt = True
            value = _prompt_value(prompt, console)
            if prompt.persist:
                new_entries.append((prompt.key, value))
            collected[prompt.key] = value

    if new_entries:
        with env_path.open("a", encoding="utf-8") as env_file:
            if env_path.stat().st_size > 0:
                env_file.write("\n")
            for key, value in new_entries:
                env_file.write(f"{key}={value}\n")
        console.print(f"[green]Updated {env_path} with {len(new_entries)} value(s).[/green]")


def _prompt_value(prompt: EnvPrompt, console: Console) -> str:
    if prompt.default:
        default = prompt.default
        show_default = True
    elif prompt.required:
        default = None
        show_default = False
    else:
        default = ""
        show_default = False
    while True:
        value = typer.prompt(
            prompt.message,
            default=default,
            show_default=show_default,
            hide_input=prompt.secret,
        ).strip()
        if value or not prompt.required:
            return value
        console.print("[red]A value is required.[/red]")


def _should_prompt(key: str, values: Dict[str, str]) -> bool:
    if key not in VPN_DEPENDENT_KEYS:
        return True

    wants_vpn = _wants_vpn(values)
    if not wants_vpn:
        return False

    wants_wireguard = _wants_wireguard(values)

    if key in {"VPN_SERVICE_PROVIDER", "VPN_TYPE"}:
        return wants_vpn
    if key in WIREGUARD_REQUIRED_KEYS:
        return wants_wireguard
    if key == WIREGUARD_ADVANCED_FLAG:
        return wants_wireguard
    if key in WIREGUARD_ADVANCED_KEYS:
        return wants_wireguard and _flag_truthy(values.get(WIREGUARD_ADVANCED_FLAG, "n"))
    if key == VPN_FILTER_FLAG:
        return wants_vpn
    if key == "SERVER_COUNTRIES":
        return _flag_truthy(values.get(VPN_FILTER_FLAG, "n"))
    if key == VPN_LOCATION_EXTRA_FLAG:
        return _flag_truthy(values.get(VPN_FILTER_FLAG, "n")) and not values.get("SERVER_COUNTRIES", "").strip()
    if key in {"SERVER_REGIONS", "SERVER_CITIES"}:
        if not _flag_truthy(values.get(VPN_FILTER_FLAG, "n")):
            return False
        country = values.get("SERVER_COUNTRIES", "").strip()
        if country:
            return True
        return _flag_truthy(values.get(VPN_LOCATION_EXTRA_FLAG, "n"))
    if key == VPN_HOSTNAME_FLAG:
        return _flag_truthy(values.get(VPN_FILTER_FLAG, "n"))
    if key in VPN_HOST_KEYS:
        return _flag_truthy(values.get(VPN_FILTER_FLAG, "n")) and _flag_truthy(values.get(VPN_HOSTNAME_FLAG, "n"))
    if key == VPN_PORT_FORWARD_FLAG:
        return wants_vpn
    if key == "PORT_FORWARDING_PROVIDER":
        return _flag_truthy(values.get(VPN_PORT_FORWARD_FLAG, "n"))
    return True


def _wants_vpn(values: Dict[str, str]) -> bool:
    value = values.get("USE_VPN")
    if value is None:
        return True
    return _flag_truthy(value)


def _wants_wireguard(values: Dict[str, str]) -> bool:
    if not _wants_vpn(values):
        return False
    vpn_type = values.get("VPN_TYPE")
    if vpn_type is None:
        return True
    normalized = vpn_type.strip().lower()
    return normalized in {"wireguard", "wg"}


def _with_timezone_default(sections: List[PromptSection], tz: str) -> List[PromptSection]:
    updated: List[PromptSection] = []
    for section in sections:
        prompts: List[EnvPrompt] = []
        for prompt in section.prompts:
            if prompt.key == "TZ":
                prompts.append(replace(prompt, default=tz))
            else:
                prompts.append(prompt)
        updated.append(PromptSection(section.title, section.description, prompts))
    return updated

def _flag_truthy(value: Optional[str]) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "y"}


def detect_timezone() -> Optional[str]:
    tz = os.environ.get("TZ")
    if tz:
        return tz
    timezone_file = Path("/etc/timezone")
    if timezone_file.exists():
        data = timezone_file.read_text().strip()
        if data:
            return data
    localtime = Path("/etc/localtime")
    if localtime.exists():
        try:
            resolved = localtime.resolve()
            parts = resolved.as_posix().split("/zoneinfo/")
            if len(parts) == 2:
                return parts[1]
        except Exception:
            pass
    try:
        tzinfo = datetime.now().astimezone().tzinfo
        if tzinfo and tzinfo.tzname(None):
            return tzinfo.tzname(None)
    except Exception:
        pass
    return None
