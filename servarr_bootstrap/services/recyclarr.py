"\"\"\"Recyclarr configuration helpers.\"\"\""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Dict

from ruamel.yaml import YAML
from rich.console import Console

LOGGER = logging.getLogger("servarr.bootstrap.recyclarr")


class RecyclarrError(RuntimeError):
    """Raised when Recyclarr configuration fails."""


YAML_SCHEMA_HEADER = "# yaml-language-server: $schema=https://raw.githubusercontent.com/recyclarr/recyclarr/master/schemas/config-schema.json"


class RecyclarrManager:
    def __init__(self, root_dir: Path, console: Console, dry_run: bool) -> None:
        self.root_dir = root_dir
        self.console = console
        self.dry_run = dry_run
        self.config_path = self.root_dir / "config" / "recyclarr" / "recyclarr.yml"
        self.yaml = YAML()
        self.yaml.indent(sequence=2, offset=2)

    def ensure_config(self, sonarr_api: str, radarr_api: str) -> None:
        config = self._load_config()
        changed = False

        sonarr_entry = {
            "base_url": "http://sonarr:8989",
            "api_key": sonarr_api,
            "quality_definition": {"type": "series"},
        }
        radarr_entry = {
            "base_url": "http://radarr:7878",
            "api_key": radarr_api,
            "quality_definition": {"type": "movie"},
        }

        changed |= self._merge_instance(config, "sonarr", "sonarr", sonarr_entry)
        changed |= self._merge_instance(config, "radarr", "radarr", radarr_entry)

        if changed:
            if self.dry_run:
                self.console.print("[magenta][dry-run][/magenta] Recyclarr: would update recyclarr.yml")
            else:
                self.config_path.parent.mkdir(parents=True, exist_ok=True)
                with self.config_path.open("w", encoding="utf-8") as fh:
                    fh.write(f"{YAML_SCHEMA_HEADER}\n")
                    self.yaml.dump(config, fh)
                self.console.print("[green]Recyclarr:[/] Updated recyclarr.yml")
        else:
            self.console.print("[green]Recyclarr:[/] Configuration already up to date")

    def run_sync(self) -> None:
        if self.dry_run:
            self.console.print("[magenta][dry-run][/magenta] Recyclarr: would run `recyclarr sync`")
            return
        try:
            subprocess.run(
                ["docker", "exec", "recyclarr", "recyclarr", "sync"],
                check=True,
                capture_output=True,
                text=True,
            )
            self.console.print("[green]Recyclarr:[/] Sync completed")
        except subprocess.CalledProcessError as exc:
            LOGGER.error("Recyclarr sync failed: %s", exc.stderr.strip() if exc.stderr else exc)
            raise RecyclarrError("Recyclarr sync failed; check logs for details") from exc

    def _load_config(self) -> Dict:
        if not self.config_path.exists():
            return {"sonarr": {}, "radarr": {}}
        try:
            text = self.config_path.read_text(encoding="utf-8")
            if text.startswith("# yaml-language-server"):
                text = "\n".join(text.splitlines()[1:])
            data = self.yaml.load(text) or {}
            data.setdefault("sonarr", {})
            data.setdefault("radarr", {})
            return data
        except Exception as exc:
            raise RecyclarrError(f"Failed to parse {self.config_path}: {exc}") from exc

    def _merge_instance(self, data: Dict, section: str, name: str, settings: Dict) -> bool:
        data.setdefault(section, {})
        section_data = data[section]
        instance = section_data.get(name, {})
        updated = False
        for key, value in settings.items():
            if instance.get(key) != value:
                instance[key] = value
                updated = True
        section_data[name] = instance
        return updated
