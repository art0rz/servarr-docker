from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from servarr_bootstrap.services.api_keys import (
    ApiKeyError,
    read_arr_api_key,
    read_prowlarr_api_key,
    read_bazarr_api_key,
)


class ApiKeyTests(unittest.TestCase):
    def test_reads_key(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_dir = root / "config" / "sonarr"
            config_dir.mkdir(parents=True)
            (config_dir / "config.xml").write_text("<Config><ApiKey>abc123</ApiKey></Config>")
            key = read_arr_api_key(root, "sonarr")
            self.assertEqual(key, "abc123")

    def test_missing_config(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ApiKeyError):
                read_arr_api_key(root, "sonarr")

    def test_read_prowlarr_key(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = root / "config" / "prowlarr"
            cfg.mkdir(parents=True)
            (cfg / "config.xml").write_text("<Config><ApiKey>prowlarr</ApiKey></Config>")
            self.assertEqual(read_prowlarr_api_key(root), "prowlarr")

    def test_read_bazarr_key(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = root / "config" / "bazarr" / "config"
            cfg.mkdir(parents=True)
            cfg_file = cfg / "config.yaml"
            cfg_file.write_text("---\nauth:\n  apikey: bazarr-key\n  username: ''\n  password: ''\n")
            self.assertEqual(read_bazarr_api_key(root), "bazarr-key")


if __name__ == "__main__":
    unittest.main()
