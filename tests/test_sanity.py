import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import requests

from servarr_bootstrap.config import Credentials, EnvironmentData, RuntimeContext, RuntimeOptions
from servarr_bootstrap.sanity import SanityStatus, run_sanity_scan


def make_runtime(env_values: dict[str, str] | None = None) -> RuntimeContext:
    env_values = env_values or {}
    env = EnvironmentData(env_file=None, file_values={}, merged=env_values)
    creds = Credentials(username="user", password="pass")
    return RuntimeContext(options=RuntimeOptions(), ci=False, env=env, credentials=creds)


def make_completed(stdout: str) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["test"], returncode=0, stdout=stdout, stderr="")


class SanityTests(unittest.TestCase):
    def _setup_dirs(self, root: Path) -> None:
        (root / "docker-compose.yml").write_text("version: '3.9'\n")
        config_root = root / "config"
        config_root.mkdir()
        for name in ("bazarr", "cross-seed", "prowlarr", "qbittorrent", "radarr", "recyclarr", "sonarr"):
            (config_root / name).mkdir()

    def test_missing_docker_reports_error(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._setup_dirs(root)
            runtime = make_runtime({"MEDIA_DIR": "/data", "PUID": "1000", "PGID": "1000"})

            with patch("shutil.which", return_value=None), patch(
                "servarr_bootstrap.sanity._run_subprocess",
                side_effect=subprocess.SubprocessError("docker unavailable"),
            ), patch("requests.get", side_effect=requests.RequestException("conn refused")):
                report = run_sanity_scan(root, runtime)

        self.assertTrue(report.has_errors)
        self.assertEqual(report.items[0].name, "Docker CLI")
        self.assertEqual(report.items[0].status, SanityStatus.ERROR)

    def test_all_good_reports_ok(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._setup_dirs(root)
            runtime = make_runtime({"MEDIA_DIR": "/data", "PUID": "1000", "PGID": "1000"})

            def fake_run(cmd):
                if "config" in cmd:
                    return make_completed("sonarr\nradarr\n")
                if "ps" in cmd:
                    data = '[{"Service": "sonarr", "State": "running"}, {"Service": "radarr", "State": "running"}]'
                    return make_completed(data)
                return make_completed("")

            mock_response = requests.Response()
            mock_response.status_code = 200

            with patch("shutil.which", return_value="/usr/bin/docker"), patch(
                "servarr_bootstrap.sanity._run_subprocess",
                side_effect=fake_run,
            ), patch("requests.get", return_value=mock_response):
                report = run_sanity_scan(root, runtime)

        self.assertFalse(report.has_errors)
        statuses = {item.status for item in report.items}
        self.assertIn(SanityStatus.OK, statuses)
        self.assertNotIn(SanityStatus.ERROR, statuses)


if __name__ == "__main__":
    unittest.main()
