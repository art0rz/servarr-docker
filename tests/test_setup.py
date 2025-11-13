from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from rich.console import Console

from servarr_bootstrap.config import Credentials, EnvironmentData, RuntimeContext, RuntimeOptions
from servarr_bootstrap.setup_tasks import SetupPlan, perform_setup


def make_runtime(env_overrides: dict[str, str]) -> RuntimeContext:
    env = EnvironmentData(env_file=None, file_values={}, merged=env_overrides)
    creds = Credentials(username="user", password="pass")
    return RuntimeContext(options=RuntimeOptions(), ci=False, env=env, credentials=creds)


class SetupTasksTests(unittest.TestCase):
    def test_creates_directories(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config").mkdir()
            media = root / "media"
            env = {
                "MEDIA_DIR": str(media),
                "PUID": "1000",
                "PGID": "1000",
                "USE_VPN": "false",
            }
            runtime = make_runtime(env)
            commands = []

            def fake_runner(cmd, cwd, env):
                commands.append((tuple(cmd), cwd, env.get("COMPOSE_PROFILES") if env else None))

            plan = SetupPlan()
            perform_setup(root, runtime, Console(file=StringIO()), plan, command_runner=fake_runner)

            for name in ("qbittorrent", "prowlarr", "sonarr", "radarr", "bazarr", "cross-seed", "recyclarr"):
                self.assertTrue((root / "config" / name).exists())

            for sub in ("downloads/incomplete", "downloads/completed", "downloads/cross-seeds", "tv", "movies"):
                self.assertTrue((media / sub).exists())

            self.assertTrue(commands)  # docker commands were invoked

    def test_dry_run_skips_files(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config").mkdir()
            media = root / "media"
            env = {
                "MEDIA_DIR": str(media),
                "PUID": "1000",
                "PGID": "1000",
                "USE_VPN": "true",
            }
            runtime = RuntimeContext(
                options=RuntimeOptions(dry_run=True),
                ci=False,
                env=EnvironmentData(env_file=None, file_values={}, merged=env),
                credentials=Credentials(username="user", password="pass"),
            )

            perform_setup(root, runtime, Console(file=StringIO()), SetupPlan(), command_runner=lambda *args, **kwargs: None)

            for name in ("qbittorrent", "prowlarr", "sonarr", "radarr", "bazarr", "cross-seed", "recyclarr"):
                self.assertFalse((root / "config" / name).exists())
            self.assertFalse(media.exists())


if __name__ == "__main__":
    unittest.main()
