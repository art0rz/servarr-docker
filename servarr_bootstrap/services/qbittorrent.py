"""qBittorrent API helper."""

from __future__ import annotations

import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Dict, Optional

import requests
from rich.console import Console

LOGGER = logging.getLogger("servarr.bootstrap.qbittorrent")


class QbitClientError(RuntimeError):
    """Raised for qBittorrent API failures."""


class QbitClient:
    def __init__(self, base_url: str, console: Console, dry_run: bool, container_name: str = "qbittorrent") -> None:
        self.base_url = base_url.rstrip("/")
        self.console = console
        self.dry_run = dry_run
        self.container_name = container_name
        self.session = requests.Session()

    def ensure_credentials(
        self,
        desired_username: Optional[str],
        desired_password: Optional[str],
        lan_subnet: Optional[str],
    ) -> bool:
        """Ensure qBittorrent is configured with the provided credentials and bypass settings."""
        if not desired_username or not desired_password:
            self.console.print("[yellow]qBittorrent:[/] Skipping credential sync (no username/password)")
            return False

        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] qBittorrent: would configure credentials and LAN bypass")
            return False

        login_success, current_label = self._establish_session(desired_username, desired_password)
        if not login_success:
            raise QbitClientError("Unable to authenticate with qBittorrent; cannot configure preferences.")

        if current_label != "bootstrap credentials":
            LOGGER.info("Updating qBittorrent WebUI credentials to bootstrap user")
            self._set_preferences(
                {
                    "web_ui_username": desired_username,
                    "web_ui_password": desired_password,
                }
            )
            if not self._attempt_login(desired_username, desired_password):
                raise QbitClientError("Failed to re-authenticate with qBittorrent after updating credentials.")

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
        self.console.print("[green]qBittorrent:[/] Credentials synchronized and LAN bypass configured")
        return True

    def ensure_storage_layout(self, media_dir: Path) -> None:
        """Configure standard save paths, temp paths, torrent export dirs, and categories."""
        downloads_root = media_dir / "downloads"
        incomplete_dir = downloads_root / "incomplete"
        completed_dir = downloads_root / "completed"

        preferences = {
            "save_path": str(completed_dir),
            "temp_path_enabled": True,
            "temp_path": str(incomplete_dir),
            "export_dir": str(incomplete_dir / "torrents"),
            "export_dir_fin": str(completed_dir / "torrents"),
            "auto_tmm_enabled": True,
            "category_changed_tmm_enabled": True,
            "save_path_changed_tmm_enabled": True,
            "torrent_changed_tmm_enabled": True,
            "create_subfolder_enabled": False,
            "append_label_to_save_path": False,
            "dht": False,
            "pex": False,
            "lsd": False,
        }
        category_paths = {
            "movies": completed_dir / "movies",
            "tv": completed_dir / "tv",
        }

        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] qBittorrent: would update download paths and categories")
            return

        self._set_preferences(preferences)
        self._ensure_categories(category_paths)
        self.console.print("[green]qBittorrent:[/] Download paths and categories configured")

    def ensure_listen_port(self, listen_port: int) -> None:
        """Set a specific qBittorrent listen port and disable random port selection."""
        if listen_port <= 0:
            raise QbitClientError(f"Invalid listen port: {listen_port}")
        LOGGER.info("Ensuring qBittorrent listen port is %s", listen_port)
        if self.dry_run:
            return
        self._set_preferences(
            {
                "use_random_port": False,
                "listen_port": int(listen_port),
            }
        )

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

    def _read_temp_credentials(self) -> Optional[tuple[str, str]]:
        if self.dry_run:
            return None
        try:
            result = subprocess.run(
                ["docker", "logs", self.container_name, "--tail", "200"],
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            LOGGER.debug("Docker CLI not available; cannot read qBittorrent logs for temp credentials")
            return None

        output = result.stdout
        if not output:
            return None

        user = None
        password = None
        for line in output.splitlines():
            if "The WebUI administrator username is:" in line:
                user = line.rsplit(":", 1)[-1].strip()
            if "A temporary password is provided for this session:" in line:
                password = line.rsplit(":", 1)[-1].strip()
        if user and password:
            return user, password
        return None

    def _establish_session(self, desired_username: Optional[str], desired_password: Optional[str]) -> tuple[bool, Optional[str]]:
        attempts = 10
        delay = 3
        for attempt in range(1, attempts + 1):
            credential_sources: list[tuple[str, Optional[str], Optional[str]]] = []
            if desired_username and desired_password:
                credential_sources.append(("bootstrap credentials", desired_username, desired_password))
            temp = self._read_temp_credentials()
            if temp:
                temp_user, temp_pass = temp
                LOGGER.info("Trying qBittorrent temporary credentials from container logs")
                credential_sources.append(("temporary credentials", temp_user, temp_pass))
            credential_sources.append(("default credentials", "admin", "adminadmin"))

            for label, user, password in credential_sources:
                if not user or not password:
                    continue
                if self._attempt_login(user, password):
                    return True, label

            LOGGER.warning(
                "qBittorrent login failed (attempt %s/%s). Waiting %ss before retrying...",
                attempt,
                attempts,
                delay,
            )
            time.sleep(delay)
        return False, None

    def _ensure_categories(self, category_paths: Dict[str, Path]) -> None:
        try:
            response = self.session.get(f"{self.base_url}/api/v2/torrents/categories", timeout=5)
            response.raise_for_status()
            existing = response.json() or {}
        except requests.RequestException as exc:
            raise QbitClientError(f"Failed to fetch qBittorrent categories: {exc}") from exc

        for name, path in category_paths.items():
            desired_path = str(path)
            current = existing.get(name) or {}
            if current.get("savePath") == desired_path:
                continue
            endpoint = "editCategory" if name in existing else "createCategory"
            payload = {"category": name, "savePath": desired_path, "downloadPath": desired_path}
            try:
                response = self.session.post(
                    f"{self.base_url}/api/v2/torrents/{endpoint}",
                    data=payload,
                    timeout=5,
                )
                response.raise_for_status()
            except requests.RequestException as exc:
                raise QbitClientError(f"Failed to update qBittorrent category '{name}': {exc}") from exc
