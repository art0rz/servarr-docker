"""Arr API client helpers."""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from rich.console import Console

LOGGER = logging.getLogger("servarr.bootstrap.arr")


class ArrClientError(RuntimeError):
    """Raised for API errors while configuring Arr services."""


@dataclass
class QbittorrentConfig:
    host: str
    port: int
    username: str
    password: str
    category: str


def _normalize_path(path: str | Path) -> str:
    return Path(path).as_posix().rstrip("/") or "/"


class ArrClient:
    """Minimal Arr API wrapper used for automation tasks."""

    def __init__(self, name: str, base_url: str, api_key: str, console: Console, dry_run: bool) -> None:
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.console = console
        self.dry_run = dry_run
        self.session = requests.Session()
        self.session.headers.update({"X-Api-Key": api_key})

    def ensure_qbittorrent_download_client(self, config: QbittorrentConfig) -> None:
        """Ensure qBittorrent is configured as a download client."""
        if self.dry_run:
            self.console.print(f"[magenta][dry-run][/magenta] {self.name}: would ensure qBittorrent download client")
            return

        clients = self._request("GET", "/api/v3/downloadclient").json()
        existing = self._find_qbit_client(clients, config)
        payload = self._build_qbit_payload(config)

        if existing:
            payload["id"] = existing["id"]
            self._request("PUT", f"/api/v3/downloadclient/{existing['id']}", json=payload)
        else:
            self._request("POST", "/api/v3/downloadclient", json=payload)
        self.console.print(f"[green]{self.name}:[/] qBittorrent download client synchronized")

    def ensure_ui_credentials(self, username: Optional[str], password: Optional[str]) -> None:
        """Ensure the Arr UI requires login with the shared credentials."""
        if not username or not password:
            self.console.print(f"[yellow]{self.name}:[/] Skipping auth configuration (no username/password)")
            return

        if self.dry_run:
            self.console.print(f"[magenta][dry-run][/magenta] Would configure UI credentials for {self.name}")
            return

        host_config = self._request("GET", "/api/v3/config/host").json()
        needs_update = (
            host_config.get("authenticationMethod") != "forms"
            or host_config.get("username") != username
        )
        if not needs_update:
            return

        payload = host_config.copy()
        payload.update(
            {
                "authenticationMethod": "forms",
                "authenticationRequired": "enabled",
                "username": username,
                "password": password,
                "passwordConfirmation": password,
            }
        )
        self._request("PUT", "/api/v3/config/host", json=payload)
        self.console.print(f"[green]{self.name}:[/] UI credentials configured")

    def ensure_root_folder(self, path: Path | str) -> None:
        target = _normalize_path(path)

        if self.dry_run:
            self.console.print(f"[magenta][dry-run][/magenta] {self.name}: would ensure root folder {target}")
            return

        folders = self._request("GET", "/api/v3/rootfolder").json()
        for folder in folders:
            existing = folder.get("path")
            if existing and _normalize_path(existing) == target:
                return

        self._request("POST", "/api/v3/rootfolder", json={"path": target})
        self.console.print(f"[green]{self.name}:[/] Root folder registered at {target}")

    def _request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        url = f"{self.base_url}{path}"
        try:
            response = self.session.request(method, url, timeout=10, **kwargs)
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            raise ArrClientError(f"{self.name}: API request failed ({method} {path}): {exc}") from exc

    def _fetch_qbit_schema(self) -> Dict[str, Any]:
        schemas = self._request("GET", "/api/v3/downloadclient/schema").json()
        for schema in schemas:
            if schema.get("implementation") == "QBittorrent":
                return copy.deepcopy(schema)
        raise ArrClientError(f"{self.name}: qBittorrent schema not found")

    def _build_qbit_payload(self, config: QbittorrentConfig) -> Dict[str, Any]:
        schema = self._fetch_qbit_schema()
        fields = {field["name"]: field for field in schema.get("fields", [])}

        def set_field(name: str, value: Any) -> None:
            if name in fields:
                fields[name]["value"] = value
            else:
                fields[name] = {"name": name, "value": value}

        set_field("host", config.host)
        set_field("port", config.port)
        set_field("username", config.username)
        set_field("password", config.password)
        set_field("category", config.category)
        set_field("useSsl", False)
        set_field("urlBase", "")
        set_field("tlsCertPath", "")
        set_field("tlsKeyPath", "")
        set_field("addPaused", False)
        set_field("initialState", 0)
        set_field("autoTmm", False)

        schema["fields"] = list(fields.values())
        schema.update(
            {
                "name": "qBittorrent",
                "enable": True,
                "protocol": "torrent",
                "priority": 1,
                "removeCompletedDownloads": False,
                "removeFailedDownloads": False,
            }
        )
        return schema

    def _find_qbit_client(self, clients: List[Dict[str, Any]], config: QbittorrentConfig) -> Optional[Dict[str, Any]]:
        fallback = None
        for client in clients:
            if client.get("implementation") != "QBittorrent":
                continue
            fields = {field["name"]: field.get("value") for field in client.get("fields", [])}
            host = fields.get("host")
            category = fields.get("category")
            if host == config.host and category == config.category:
                return client
            if fallback is None:
                fallback = client
        return fallback
