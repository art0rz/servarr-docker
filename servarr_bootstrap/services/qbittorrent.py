"""qBittorrent API helper."""

from __future__ import annotations

import json
import logging
from typing import Optional

import requests
from rich.console import Console

LOGGER = logging.getLogger("servarr.bootstrap.qbittorrent")


class QbitClientError(RuntimeError):
    """Raised for qBittorrent API failures."""


class QbitClient:
    def __init__(self, base_url: str, console: Console, dry_run: bool) -> None:
        self.base_url = base_url.rstrip("/")
        self.console = console
        self.dry_run = dry_run
        self.session = requests.Session()

    def ensure_credentials(
        self,
        desired_username: Optional[str],
        desired_password: Optional[str],
        lan_subnet: Optional[str],
    ) -> None:
        """Ensure qBittorrent is configured with the provided credentials and bypass settings."""
        if not desired_username or not desired_password:
            self.console.print("[yellow]Skipping qBittorrent credential sync (no username/password provided).[/yellow]")
            return

        login_success = self._attempt_login(desired_username, desired_password)
        current_label = "bootstrap credentials" if login_success else None

        if not login_success:
            login_success = self._attempt_login("admin", "adminadmin")
            current_label = "default credentials" if login_success else None

        if not login_success:
            raise QbitClientError("Unable to authenticate with qBittorrent; cannot configure preferences.")

        if current_label != "bootstrap credentials":
            self.console.print("[cyan]qBittorrent:[/] Updating WebUI credentials to bootstrap user")
            self._set_preferences(
                {
                    "web_ui_username": desired_username,
                    "web_ui_password": desired_password,
                }
            )
            # Re-authenticate using the desired credentials to refresh the session.
            self._attempt_login(desired_username, desired_password)
        else:
            self.console.print("[green]qBittorrent:[/] Credentials already match bootstrap user")

        subnet_whitelist = "127.0.0.1/32\n172.18.0.0/16\n172.19.0.0/16"
        if lan_subnet:
            subnet_whitelist += f"\n{lan_subnet}"

        self._set_preferences(
            {
                "web_ui_address": "*",
                "web_ui_host_header_validation_enabled": False,
                "bypass_local_auth": True,
                "bypass_auth_subnet_whitelist_enabled": True,
                "bypass_auth_subnet_whitelist": subnet_whitelist,
            }
        )
        self.console.print("[green]qBittorrent:[/] Authentication bypass configured for LAN + Docker networks")

    def _attempt_login(self, username: str, password: str) -> bool:
        if self.dry_run:
            return True
        try:
            response = self.session.post(
                f"{self.base_url}/api/v2/auth/login",
                data={"username": username, "password": password},
                timeout=5,
            )
            success = response.text.strip().lower() == "ok."
            if not success:
                LOGGER.debug("Login attempt failed for user %s: %s", username, response.text)
            return success
        except requests.RequestException as exc:
            LOGGER.debug("Login request failed: %s", exc)
            return False

    def _set_preferences(self, preferences: dict) -> None:
        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] Would update qBittorrent preferences")
            return
        payload = {"json": json.dumps(preferences)}
        try:
            response = self.session.post(
                f"{self.base_url}/api/v2/app/setPreferences",
                data=payload,
                timeout=5,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise QbitClientError(f"Failed to update qBittorrent preferences: {exc}") from exc
