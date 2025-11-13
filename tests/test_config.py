import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from servarr_bootstrap.config import (
    RuntimeOptions,
    build_runtime_context,
    detect_ci,
    load_environment_data,
)


class ConfigTests(unittest.TestCase):
    def test_detect_ci_true_for_common_vars(self):
        self.assertTrue(detect_ci({"CI": "true"}))
        self.assertTrue(detect_ci({"GITHUB_ACTIONS": "1"}))

    def test_detect_ci_false_when_not_set(self):
        self.assertFalse(detect_ci({}))

    def test_load_environment_merges_env_vars(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_file = root / ".env"
            env_file.write_text("FOO=bar\nSERVARR_USERNAME=file_user\n")
            env_data = load_environment_data(root, env={"FOO": "override", "BAR": "baz"})
            self.assertEqual(env_data.file_values["FOO"], "bar")
            self.assertEqual(env_data.merged["FOO"], "override")
            self.assertEqual(env_data.merged["BAR"], "baz")
            self.assertEqual(env_data.env_file, env_file)

    def test_build_runtime_context_prefers_env_values(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text("SERVARR_USERNAME=file_user\n")
            env = {
                "SERVARR_USERNAME": "ci-user",
                "SERVARR_PASSWORD": "supersecret",
                "CI": "true",
            }
            options = RuntimeOptions(dry_run=True, non_interactive=True, verbose=False)
            ctx = build_runtime_context(root, options, env=env)
            self.assertTrue(ctx.ci)
            self.assertEqual(ctx.credentials.username, "ci-user")
            self.assertEqual(ctx.credentials.password, "supersecret")
            self.assertTrue(ctx.options.non_interactive)


if __name__ == "__main__":
    unittest.main()
