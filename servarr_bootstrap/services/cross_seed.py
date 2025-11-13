"""Cross-Seed configuration helpers."""

from __future__ import annotations

import re
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
};
"""


class CrossSeedConfigurator:
    def __init__(self, root_dir: Path, console: Console, dry_run: bool) -> None:
        self.root_dir = root_dir
        self.console = console
        self.dry_run = dry_run
        self.config_path = self.root_dir / "config" / "cross-seed" / "config.js"

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

        if not updated:
            self.console.print("[green]Cross-Seed:[/] Configuration already up to date")
            return

        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] Cross-Seed: would update config.js")
            return

        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(contents["text"], encoding="utf-8")
        self.console.print("[green]Cross-Seed:[/] Updated config.js")

    def _read_config(self) -> dict:
        if not self.config_path.exists():
            return {"text": TEMPLATE}
        return {"text": self.config_path.read_text(encoding="utf-8")}

    def _replace_array(self, state: dict, key: str, values: Iterable[str]) -> bool:
        values = [v for v in values if v]
        formatted = self._format_array(values)
        pattern = rf"({key}\\s*:\\s*\\[)(.*?)(\\],)"
        new_text, count = re.subn(pattern, rf"\\1{formatted}\\3", state["text"], flags=re.S)
        if count == 0:
            return False
        state["text"] = new_text
        return True

    def _format_array(self, values: Iterable[str]) -> str:
        vals = list(values)
        if not vals:
            return ""
        inner = ",\n".join(f"        \"{v}\"" for v in vals)
        return f"\n{inner}\n    "
