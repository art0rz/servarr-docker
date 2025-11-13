"""Cross-Seed configuration helpers."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable

from rich.console import Console


class CrossSeedError(RuntimeError):
    """Raised when Cross-Seed configuration fails."""


TEMPLATE = """"use strict";
module.exports = {
    apiKey: undefined,
    torznab: [],
    sonarr: [],
    radarr: [],
    torrentClients: [],
    useClientTorrents: true,
    delay: 30,
    linkCategory: "cross-seed-link",
    linkDirs: [],
    linkType: "hardlink",
    flatLinking: false,
    matchMode: "partial",
    seasonFromEpisodes: null,
};
"""


class CrossSeedConfigurator:
    def __init__(self, root_dir: Path, console: Console, dry_run: bool, link_dir: Path) -> None:
        self.root_dir = root_dir
        self.console = console
        self.dry_run = dry_run
        self.config_path = self.root_dir / "config" / "cross-seed" / "config.js"
        self.link_dir = link_dir

    def ensure_config(
        self,
        torznab_urls: Iterable[str],
        sonarr_urls: Iterable[str],
        radarr_urls: Iterable[str],
        torrent_clients: Iterable[str],
    ) -> None:
        contents = self._read_config()
        updated = False
        updated |= self._replace_array(contents, "torznab", torznab_urls)
        updated |= self._replace_array(contents, "sonarr", sonarr_urls)
        updated |= self._replace_array(contents, "radarr", radarr_urls)
        updated |= self._replace_array(contents, "torrentClients", torrent_clients)
        link_dir = torznab_urls and torznab_urls[0]
        updated |= self._replace_array(contents, "linkDirs", [self.link_dir])
        contents["text"], change = self._replace_scalar(contents["text"], "seasonFromEpisodes", "null")
        updated |= change

        if not updated:
            self.console.print("[green]Cross-Seed:[/] Configuration already up to date")
            return

        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] Cross-Seed: would update config.js")
            return

        text = contents["text"]
        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            self.config_path.write_text(text, encoding="utf-8")
        except PermissionError:
            self.console.print("[yellow]Cross-Seed:[/] Host config not writable; updating via docker cp")
            self._write_via_docker(text)
        self.console.print("[green]Cross-Seed:[/] Updated config.js")

    def _read_config(self) -> dict:
        if not self.config_path.exists():
            return {"text": TEMPLATE}
        return {"text": self.config_path.read_text(encoding="utf-8")}

    def _replace_array(self, state: dict, key: str, values: Iterable[str]) -> bool:
        values = [v for v in values if v]
        formatted = self._format_array(values)
        pattern = rf"({key}\s*:\s*\[)(.*?)(\](,?))"
        replacement = rf"\1{formatted}\3"
        new_text, count = re.subn(pattern, replacement, state["text"], flags=re.S)
        if count == 0:
            return False
        state["text"] = new_text
        return True

    def _replace_scalar(self, text: str, key: str, value: str) -> tuple[str, bool]:
        pattern = rf"({key}\s*:\s*)(.*?)(,)"
        new_text, count = re.subn(pattern, rf"\1{value}\3", text)
        return new_text, count > 0

    def _format_array(self, values: Iterable[str]) -> str:
        vals = list(values)
        if not vals:
            return ""
        inner = ",\n".join(f"        \"{v}\"" for v in vals)
        return f"\n{inner}\n    "

    def _write_via_docker(self, text: str) -> None:
        with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as tmp:
            tmp.write(text)
            tmp_path = tmp.name
        try:
            subprocess.run(
                ["docker", "cp", tmp_path, "cross-seed:/config/config.js"],
                check=True,
                capture_output=True,
            )
        except subprocess.CalledProcessError as exc:
            raise CrossSeedError(f"Failed to update Cross-Seed via docker cp: {exc.stderr}") from exc
        finally:
            os.remove(tmp_path)
