from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from servarr_bootstrap.cleaner import CleanPlan, perform_clean
from servarr_bootstrap.config import Credentials, EnvironmentData, RuntimeContext, RuntimeOptions


def make_runtime(*, dry_run: bool = False) -> RuntimeContext:
    env = EnvironmentData(env_file=None, file_values={}, merged={})
    creds = Credentials(username=None, password=None)
    return RuntimeContext(options=RuntimeOptions(dry_run=dry_run), ci=False, env=env, credentials=creds)


class CleanerTests(unittest.TestCase):
    def test_perform_clean_removes_artifacts(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docker-compose.yml").write_text("version: '3.9'\n")
            config_dir = root / "config"
            (config_dir / "sonarr").mkdir(parents=True)
            (config_dir / "sonarr" / "config.xml").write_text("<xml />")
            (config_dir / "radarr").mkdir()
            state_file = root / "bootstrap_state.json"
            state_file.write_text("{}\n")
            log_dir = root / "logs"
            log_dir.mkdir()
            log_a = log_dir / "bootstrap-1.log"
            log_b = log_dir / "bootstrap-2.log"
            log_a.write_text("log")
            log_b.write_text("log")
            latest = log_dir / "bootstrap-latest.log"
            latest.symlink_to(log_a.name)
            venv = root / ".venv"
            (venv / "lib").mkdir(parents=True)

            commands = []

            def fake_runner(cmd, cwd, env):
                commands.append((tuple(cmd), cwd, env))

            runtime = make_runtime()
            plan = CleanPlan(remove_logs=True, remove_venv=True)
            perform_clean(
                root_dir=root,
                log_dir=log_dir,
                runtime=runtime,
                plan=plan,
                current_log=log_b,
                command_runner=fake_runner,
            )

            self.assertTrue(commands)
            self.assertFalse((config_dir / "sonarr").exists())
            self.assertFalse((config_dir / "radarr").exists())
            self.assertFalse(state_file.exists())
            self.assertTrue(log_dir.exists())
            self.assertFalse(log_a.exists())
            self.assertTrue(log_b.exists())  # current log preserved
            self.assertFalse(latest.exists())
            self.assertFalse(venv.exists())

    def test_perform_clean_dry_run_keeps_files(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docker-compose.yml").write_text("version: '3.9'\n")
            (root / "config" / "bazarr").mkdir(parents=True)
            (root / "logs").mkdir()
            (root / ".venv").mkdir()
            runtime = make_runtime(dry_run=True)
            plan = CleanPlan(remove_logs=True, remove_venv=True)
            perform_clean(
                root_dir=root,
                log_dir=root / "logs",
                runtime=runtime,
                plan=plan,
                current_log=None,
                command_runner=lambda cmd, cwd, env: None,
            )
            self.assertTrue((root / "config" / "bazarr").exists())
            self.assertTrue((root / "logs").exists())
            self.assertTrue((root / ".venv").exists())


if __name__ == "__main__":
    unittest.main()
