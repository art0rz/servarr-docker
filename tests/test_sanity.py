from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from servarr_bootstrap.config import Credentials, EnvironmentData, RuntimeContext, RuntimeOptions
from servarr_bootstrap.sanity import SanityStatus, run_sanity_scan


def make_runtime(env_values: dict[str, str] | None = None) -> RuntimeContext:
    env_values = env_values or {}
    env = EnvironmentData(env_file=None, file_values={}, merged=env_values)
    creds = Credentials(username="user", password="pass")
    return RuntimeContext(options=RuntimeOptions(), ci=False, env=env, credentials=creds)


class SanityTests(unittest.TestCase):
    def test_missing_docker_reports_error(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docker-compose.yml").write_text("version: '3.9'\n")
            (root / "config").mkdir()
            for name in ("bazarr", "cross-seed", "prowlarr", "qbittorrent", "radarr", "recyclarr", "sonarr"):
                (root / "config" / name).mkdir()

            runtime = make_runtime({"MEDIA_DIR": "/data", "PUID": "1000", "PGID": "1000"})

            with patch("shutil.which", return_value=None):
                report = run_sanity_scan(root, runtime)
            self.assertTrue(report.has_errors)
            self.assertEqual(report.items[0].status, SanityStatus.ERROR)

    def test_all_good_reports_ok(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docker-compose.yml").write_text("version: '3.9'\n")
            (root / "config").mkdir()
            for name in ("bazarr", "cross-seed", "prowlarr", "qbittorrent", "radarr", "recyclarr", "sonarr"):
                (root / "config" / name).mkdir()

            runtime = make_runtime({"MEDIA_DIR": "/data", "PUID": "1000", "PGID": "1000"})

            with patch("shutil.which", return_value="/usr/bin/docker"):
                report = run_sanity_scan(root, runtime)

            self.assertFalse(report.has_errors)
            statuses = {item.status for item in report.items}
            self.assertEqual(statuses, {SanityStatus.OK})


if __name__ == "__main__":
    unittest.main()
