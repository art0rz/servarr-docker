"""Bazarr API integration helpers."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import requests
from requests import ConnectionError as RequestsConnectionError
from rich.console import Console

LOGGER = logging.getLogger("servarr.bootstrap.bazarr")

LANGUAGE_PROFILE_TAG = "servarr-english-default"
LANGUAGE_PROFILE_NAME = "English (auto)"
ANY_CUTOFF = 65535
DataPayload = Union[Dict[str, str], Sequence[Tuple[str, str]]]


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
            payload["settings-auth-type"] = "form"
        else:
            payload["settings-auth-type"] = "none"

        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] Would POST Bazarr settings payload")
            return

        self._post_settings(payload)
        self.console.print("[green]Bazarr:[/] Sonarr/Radarr integrations configured")

    def ensure_language_preferences(self) -> None:
        """Configure language defaults to guarantee English subtitles."""
        self.console.print("[cyan]Bazarr:[/] configuring English subtitle defaults")
        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] Would sync language profile + defaults")
            return

        profiles = self._get_language_profiles()
        target_profile = self._build_english_profile(profiles)

        updated_profiles: List[Dict[str, Any]] = []
        replaced = False
        for profile in profiles:
            if profile.get("profileId") == target_profile["profileId"] or profile.get("tag") == LANGUAGE_PROFILE_TAG:
                updated_profiles.append(target_profile)
                replaced = True
            else:
                updated_profiles.append(profile)

        if not replaced:
            updated_profiles.append(target_profile)

        enabled_languages = set(self._get_enabled_languages())
        enabled_languages.add("en")

        payload: List[Tuple[str, str]] = []
        for code in sorted(enabled_languages):
            payload.append(("languages-enabled", code))

        payload.append(("languages-profiles", json.dumps(updated_profiles)))

        profile_id_str = str(target_profile["profileId"])
        payload.extend(
            [
                ("settings-general-serie_default_enabled", _format_bool(True)),
                ("settings-general-serie_default_profile", profile_id_str),
                ("settings-general-movie_default_enabled", _format_bool(True)),
                ("settings-general-movie_default_profile", profile_id_str),
                ("settings-general-embedded_subs_show_desired", _format_bool(True)),
                ("settings-general-use_embedded_subs", _format_bool(True)),
            ]
        )

        self._post_settings(payload)
        self.console.print("[green]Bazarr:[/] English subtitle defaults configured")

    def _post_settings(self, payload: DataPayload) -> None:
        url = f"{self.base_url}/api/system/settings"
        for attempt in range(1, 4):
            try:
                response = self.session.post(url, data=payload, timeout=15)
                if response.status_code >= 400:
                    raise BazarrClientError(
                        f"Failed to apply Bazarr settings: {response.status_code} {response.text}"
                    )
                return
            except (RequestsConnectionError, BazarrClientError) as exc:
                if attempt == 3:
                    raise BazarrClientError(f"Bazarr settings request failed: {exc}") from exc
                LOGGER.warning("Bazarr settings request failed (attempt %s): %s", attempt, exc)
                time.sleep(2)

    def _get_enabled_languages(self) -> List[str]:
        url = f"{self.base_url}/api/system/languages"
        try:
            response = self.session.get(url, timeout=10)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise BazarrClientError(f"Unable to read Bazarr languages: {exc}") from exc

        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise BazarrClientError("Unexpected response when reading Bazarr languages") from exc

        codes: List[str] = []
        for entry in data or []:
            if entry.get("enabled") and entry.get("code2"):
                codes.append(entry["code2"])
        return codes

    def _get_language_profiles(self) -> List[Dict[str, Any]]:
        url = f"{self.base_url}/api/system/languages/profiles"
        try:
            response = self.session.get(url, timeout=10)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise BazarrClientError(f"Unable to read Bazarr language profiles: {exc}") from exc

        try:
            profiles = response.json()
        except json.JSONDecodeError as exc:
            raise BazarrClientError("Unexpected response when reading Bazarr language profiles") from exc

        if not isinstance(profiles, list):
            raise BazarrClientError("Bazarr language profile response is not a list")
        return profiles

    def _build_english_profile(self, existing: List[Dict[str, Any]]) -> Dict[str, Any]:
        profile_id = self._select_profile_id(existing)
        return {
            "profileId": profile_id,
            "name": LANGUAGE_PROFILE_NAME,
            "cutoff": ANY_CUTOFF,
            "items": [
                {
                    "id": 1,
                    "language": "en",
                    "audio_exclude": "False",
                    "audio_only_include": "False",
                    "hi": "False",
                    "forced": "False",
                },
                {
                    "id": 2,
                    "language": "en",
                    "audio_exclude": "False",
                    "audio_only_include": "False",
                    "hi": "True",
                    "forced": "False",
                },
            ],
            "mustContain": [],
            "mustNotContain": [],
            "originalFormat": False,
            "tag": LANGUAGE_PROFILE_TAG,
        }

    def _select_profile_id(self, existing: List[Dict[str, Any]]) -> int:
        for profile in existing:
            if profile.get("tag") == LANGUAGE_PROFILE_TAG:
                return int(profile["profileId"])
        if not existing:
            return 1
        return max(int(profile.get("profileId", 0)) for profile in existing) + 1


def _format_bool(value: bool) -> str:
    return "true" if value else "false"
