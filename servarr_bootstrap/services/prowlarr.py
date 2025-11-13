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

    def ensure_application(self, implementation: str, fields: Dict[str, Any]) -> None:
        """Ensure the Prowlarr application for the given implementation exists."""
        self.console.print(f"[cyan]Prowlarr:[/] ensuring {implementation} application")
        if self.dry_run:
            self.console.print(f"[magenta][dry-run][/magenta] Would configure {implementation} in Prowlarr")
            return

        existing = self._find_application(implementation)
        payload = self._build_payload(implementation, fields)

        if existing:
            payload["id"] = existing["id"]
            self._request("PUT", f"/api/v1/applications/{existing['id']}", json=payload)
            self.console.print(f"[green]Prowlarr:[/] Updated {implementation} application")
        else:
            self._request("POST", "/api/v1/applications", json=payload)
            self.console.print(f"[green]Prowlarr:[/] Created {implementation} application")

    def _request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        url = f"{self.base_url}{path}"
        try:
            response = self.session.request(method, url, timeout=10, **kwargs)
            response.raise_for_status()
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

    def _build_payload(self, implementation: str, overrides: Dict[str, Any]) -> Dict[str, Any]:
        schema = self._fetch_schema(implementation)
        fields = {field["name"]: field for field in schema.get("fields", [])}

        for name, value in overrides.items():
            if name in fields:
                fields[name]["value"] = value
            else:
                fields[name] = {"name": name, "value": value}

        schema["fields"] = list(fields.values())
        schema["enable"] = True
        schema.setdefault("tags", [])
        schema.setdefault("syncLevel", schema.get("syncLevel", "fullSync"))
        return schema
