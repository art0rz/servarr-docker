import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner

import servarr_bootstrap.cli as cli
from servarr_bootstrap.config import Credentials, EnvironmentData, RuntimeContext, RuntimeOptions


class CliCheckCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = CliRunner()
        self.runtime = RuntimeContext(
            options=RuntimeOptions(),
            ci=False,
            env=EnvironmentData(env_file=None, file_values={}, merged={}),
            credentials=Credentials(username=None, password=None),
        )

    def test_check_command_runs_sanity_scan(self) -> None:
        """`./bootstrap.sh check` should hydrate runtime without prompts and run the sanity scan."""
        with patch("servarr_bootstrap.cli.configure_logging", return_value=Path("dummy.log")), patch(
            "servarr_bootstrap.cli._ensure_runtime_context", return_value=self.runtime
        ) as ensure_ctx, patch("servarr_bootstrap.cli.run_sanity_scan", return_value=MagicMock()) as run_scan, patch(
            "servarr_bootstrap.cli.render_report"
        ) as render_report:
            result = self.runner.invoke(cli.APP, ["check"])

        self.assertEqual(result.exit_code, 0)
        ensure_ctx.assert_called_once()
        _, kwargs = ensure_ctx.call_args
        self.assertFalse(kwargs.get("require_credentials", True))
        run_scan.assert_called_once_with(cli.ROOT_DIR, self.runtime)
        render_report.assert_called_once()


if __name__ == "__main__":
    unittest.main()
