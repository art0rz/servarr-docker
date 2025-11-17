import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Dict
from unittest.mock import MagicMock, patch

from rich.console import Console

from servarr_bootstrap.config import Credentials, EnvironmentData, RuntimeContext, RuntimeOptions
from servarr_bootstrap.tasks.integrations import (
    IntegrationContext,
    IntegrationState,
    _configure_arr_clients,
    _configure_cross_seed,
    _configure_qbittorrent,
)


def build_context(root: Path, env_overrides: Dict[str, str] | None = None) -> IntegrationContext:
    base_env = {
        "MEDIA_DIR": "/data",
        "SONARR_PORT": "8989",
        "RADARR_PORT": "7878",
        "QBIT_WEBUI": "8080",
        "USE_VPN": "false",
    }
    if env_overrides:
        base_env.update(env_overrides)

    env = EnvironmentData(env_file=None, file_values={}, merged=base_env)
    runtime = RuntimeContext(
        options=RuntimeOptions(),
        ci=False,
        env=env,
        credentials=Credentials(username="user", password="pass"),
    )
    return IntegrationContext(root, runtime, Console(record=True))


class IntegrationConfigureTests(unittest.TestCase):
    def test_configure_arr_clients_populates_api_keys_and_calls_retry(self) -> None:
        with TemporaryDirectory() as tmp:
            ctx = build_context(Path(tmp))
            state = IntegrationState()

            with (
                patch("servarr_bootstrap.tasks.integrations.read_arr_api_key", side_effect=["sonarr", "radarr"]),
                patch("servarr_bootstrap.tasks.integrations.ArrClient") as arr_client,
                patch("servarr_bootstrap.tasks.integrations._retry") as retry,
            ):
                retry.side_effect = lambda ctx_arg, label, func, **kwargs: func()
                result = _configure_arr_clients(ctx, state)

            self.assertEqual(result, ("done", "Download clients and root folders updated"))
            self.assertEqual(state.arr_api_keys["sonarr"], "sonarr")
            self.assertEqual(state.arr_api_keys["radarr"], "radarr")
            self.assertEqual(retry.call_count, 4)
            arr_client.assert_called()

    def test_configure_qbittorrent_runs_credential_sync_and_port_forward(self) -> None:
        with TemporaryDirectory() as tmp:
            ctx = build_context(Path(tmp), {"MEDIA_DIR": "/data/media"})
            state = IntegrationState()

            with (
                patch("servarr_bootstrap.tasks.integrations.QbitClient") as qbit_cls,
                patch("servarr_bootstrap.tasks.integrations._retry") as retry,
                patch(
                    "servarr_bootstrap.tasks.integrations._sync_forwarded_port",
                    return_value=("done", "Port")
                ) as sync,
            ):
                instance = MagicMock()
                instance.ensure_credentials.return_value = True
                qbit_cls.return_value = instance
                retry.side_effect = lambda ctx_arg, label, func, **kwargs: func()
                status, detail = _configure_qbittorrent(ctx, state)

            self.assertEqual(status, "done")
            self.assertIn("Credentials", detail)
            self.assertTrue(instance.ensure_credentials.called)
            self.assertTrue(instance.ensure_storage_layout.called)
            sync.assert_called_once()
            self.assertEqual(retry.call_count, 2)

    def test_configure_cross_seed_builds_torrent_client_url_from_env(self) -> None:
        with TemporaryDirectory() as tmp:
            ctx = build_context(Path(tmp), {"USE_VPN": "false"})
            state = IntegrationState(arr_api_keys={"sonarr": "s-key", "radarr": "r-key"})

            with patch("servarr_bootstrap.tasks.integrations.CrossSeedConfigurator") as configurator:
                status, detail = _configure_cross_seed(ctx, state)

            self.assertEqual(status, "done")
            self.assertIn("Cross-Seed", detail)
            args, kwargs = configurator.return_value.ensure_config.call_args
            self.assertIn(
                "qbittorrent:http://user:pass@qbittorrent:8080",
                kwargs["torrent_clients"],
            )
            self.assertEqual(kwargs["sonarr_urls"], ["http://sonarr:8989?apikey=s-key"])
            self.assertEqual(kwargs["radarr_urls"], ["http://radarr:7878?apikey=r-key"])


if __name__ == "__main__":
    unittest.main()
