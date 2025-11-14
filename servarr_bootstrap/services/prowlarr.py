"""Prowlarr API helpers for connecting Arr applications."""

from __future__ import annotations

import copy
import logging
from typing import Any, Dict, Optional

import requests
from rich.console import Console

LOGGER = logging.getLogger("servarr.bootstrap.prowlarr")


class ProwlarrClientError(RuntimeError):
    """Raised when Prowlarr API calls fail."""


class ProwlarrClient:
    def __init__(self, base_url: str, api_key: str, console: Console, dry_run: bool) -> None:
        self.base_url = base_url.rstrip("/")
        self.console = console
        self.dry_run = dry_run
        self.session = requests.Session()
        self.session.headers.update({"X-Api-Key": api_key})
        self.api_key = api_key

    def ensure_application(self, implementation: str, fields: Dict[str, Any], name: Optional[str] = None) -> None:
        """Ensure the Prowlarr application for the given implementation exists."""
        self.console.print(f"[cyan]Prowlarr:[/] ensuring {implementation} application")
        if self.dry_run:
            self.console.print(f"[magenta][dry-run][/magenta] Would configure {implementation} in Prowlarr")
            return

        existing = self._find_application(implementation)
        payload = self._build_payload(implementation, fields, name=name or implementation)

        if existing:
            payload["id"] = existing["id"]
            self._request("PUT", f"/api/v1/applications/{existing['id']}", json=payload)
            self.console.print(f"[green]Prowlarr:[/] Updated {implementation} application")
        else:
            self._request("POST", "/api/v1/applications", json=payload)
            self.console.print(f"[green]Prowlarr:[/] Created {implementation} application")

    def ensure_flaresolverr_proxy(self, host: str) -> None:
        implementation = "FlareSolverr"
        self.console.print("[cyan]Prowlarr:[/] ensuring FlareSolverr proxy")
        if self.dry_run:
            self.console.print(f"[magenta][dry-run][/magenta] Would configure {implementation} proxy")
            return

        existing = self._find_proxy(implementation)
        proxy_host = host.rstrip('/') + '/'
        payload = self._build_proxy_payload(
            implementation,
            {"host": proxy_host},
            name="FlareSolverr",
        )

        if existing:
            payload["id"] = existing["id"]
            self._request("PUT", f"/api/v1/indexerProxy/{existing['id']}", json=payload)
            self.console.print("[green]Prowlarr:[/] Updated FlareSolverr proxy")
        else:
            self._request("POST", "/api/v1/indexerProxy", json=payload)
            self.console.print("[green]Prowlarr:[/] Created FlareSolverr proxy")

    def ensure_ui_credentials(self, username: Optional[str], password: Optional[str]) -> None:
        if not username or not password:
            self.console.print("[yellow]Prowlarr:[/] Skipping auth configuration (no username/password)")
            return

        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] Would configure UI credentials for Prowlarr")
            return

        host_config = self._request("GET", "/api/v1/config/host").json()
        needs_update = (
            host_config.get("authenticationMethod") != "forms"
            or host_config.get("username") != username
        )
        if not needs_update:
            self.console.print("[green]Prowlarr:[/] UI credentials already configured")
            return

        payload = host_config.copy()
        payload.update(
            {
                "authenticationMethod": "forms",
                "authenticationRequired": "disabledForLocalAddresses",
                "username": username,
                "password": password,
                "passwordConfirmation": password,
            }
        )
        self._request("PUT", "/api/v1/config/host", json=payload)
        self.console.print("[green]Prowlarr:[/] UI credentials configured")

    def _request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        url = f"{self.base_url}{path}"
        try:
            response = self.session.request(method, url, timeout=10, **kwargs)
            if response.status_code >= 400:
                raise requests.HTTPError(f"{response.status_code} {response.text}", response=response)
            return response
        except requests.RequestException as exc:
            raise ProwlarrClientError(f"Prowlarr API request failed ({method} {path}): {exc}") from exc

    def _fetch_schema(self, implementation: str) -> Dict[str, Any]:
        schemas = self._request("GET", "/api/v1/applications/schema").json()
        for schema in schemas:
            if schema.get("implementation") == implementation:
                return copy.deepcopy(schema)
        raise ProwlarrClientError(f"Prowlarr schema for {implementation} not found")

    def _find_application(self, implementation: str) -> Optional[Dict[str, Any]]:
        apps = self._request("GET", "/api/v1/applications").json()
        for app in apps:
            if app.get("implementation") == implementation:
                return app
        return None

    def _find_proxy(self, implementation: str) -> Optional[Dict[str, Any]]:
        proxies = self._request("GET", "/api/v1/indexerProxy").json()
        for proxy in proxies or []:
            if proxy.get("implementation") == implementation:
                return proxy
        return None

    def list_indexers(self) -> list[Dict[str, Any]]:
        return self._request("GET", "/api/v1/indexer").json()

    def _build_payload(self, implementation: str, overrides: Dict[str, Any], name: str) -> Dict[str, Any]:
        schema = self._fetch_schema(implementation)
        fields = {field["name"]: field for field in schema.get("fields", [])}

        for field_name, value in overrides.items():
            if field_name in fields:
                fields[field_name]["value"] = value
            else:
                fields[field_name] = {"name": field_name, "value": value}

        schema["fields"] = list(fields.values())
        schema["name"] = name
        schema["enable"] = True
        schema.setdefault("tags", [])
        schema.setdefault("syncLevel", schema.get("syncLevel", "fullSync"))
        return schema

    def _build_proxy_payload(self, implementation: str, overrides: Dict[str, Any], *, name: str) -> Dict[str, Any]:
        schema = self._fetch_proxy_schema(implementation)
        fields = {field["name"]: field for field in schema.get("fields", [])}

        for field_name, value in overrides.items():
            if field_name in fields:
                fields[field_name]["value"] = value
            else:
                fields[field_name] = {"name": field_name, "value": value}

        schema["fields"] = list(fields.values())
        schema.setdefault("enable", True)
        schema["name"] = name
        schema.setdefault("tags", [])
        return schema

    def _fetch_proxy_schema(self, implementation: str) -> Dict[str, Any]:
        schemas = self._request("GET", "/api/v1/indexerProxy/schema").json()
        for schema in schemas:
            if schema.get("implementation") == implementation:
                return copy.deepcopy(schema)
        raise ProwlarrClientError(f"Prowlarr proxy schema for {implementation} not found")
