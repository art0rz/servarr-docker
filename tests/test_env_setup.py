import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from rich.console import Console

from servarr_bootstrap.env_setup import interactive_env_setup


class EnvSetupTests(unittest.TestCase):
    def test_prompts_for_missing_values(self):
        console = Console(record=True)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompt_values = [
                "/data/media",
                "2000",
                "2000",
                "10.0.0.0/24",
                "UTC",
                "admin",
                "changeme",
                "true",
                "mullvad",
                "wireguard",
                "privkey",
                "10.0.0.2/32",
                "n",  # skip advanced WireGuard prompts
                "y",  # enable server filters
                "Sweden",
                "Europe North",
                "Stockholm",
                "n",  # skip hostnames
                "n",  # skip port forwarding
                "8081",
                "9696",
                "8989",
                "7878",
                "6767",
                "8191",
                "2468",
                "3000",
            ]
            with patch("servarr_bootstrap.env_setup.typer.prompt", side_effect=prompt_values), patch("servarr_bootstrap.env_setup.detect_timezone", return_value="UTC"):
                interactive_env_setup(root, console)

            env_file = root / ".env"
            entries = dict(line.split("=", 1) for line in env_file.read_text().strip().splitlines())
            self.assertEqual(entries["MEDIA_DIR"], "/data/media")
            self.assertEqual(entries["PUID"], "2000")
            self.assertEqual(entries["PGID"], "2000")
            self.assertEqual(entries["LAN_SUBNET"], "10.0.0.0/24")
            self.assertEqual(entries["TZ"], "UTC")
            self.assertEqual(entries["SERVARR_USERNAME"], "admin")
            self.assertEqual(entries["SERVARR_PASSWORD"], "changeme")
            self.assertEqual(entries["USE_VPN"], "true")
            self.assertEqual(entries["VPN_SERVICE_PROVIDER"], "mullvad")
            self.assertEqual(entries["VPN_TYPE"], "wireguard")
            self.assertEqual(entries["WIREGUARD_PRIVATE_KEY"], "privkey")
            self.assertEqual(entries["WIREGUARD_ADDRESSES"], "10.0.0.2/32")
            self.assertEqual(entries["WIREGUARD_ADVANCED_ENABLED"], "n")
            self.assertEqual(entries["QBIT_WEBUI"], "8081")
            self.assertEqual(entries["VPN_FILTERS_ENABLED"], "y")
            self.assertEqual(entries["SERVER_COUNTRIES"], "Sweden")
            self.assertEqual(entries["SERVER_REGIONS"], "Europe North")
            self.assertEqual(entries["SERVER_CITIES"], "Stockholm")
            self.assertEqual(entries["VPN_PORT_FORWARDING_ENABLED"], "n")

    def test_skips_existing_values(self):
        console = Console(record=True)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_path = root / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "MEDIA_DIR=/data",
                        "PUID=1000",
                        "PGID=1000",
                        "LAN_SUBNET=10.0.0.0/24",
                        "TZ=UTC",
                        "SERVARR_USERNAME=user",
                        "SERVARR_PASSWORD=pass",
                        "USE_VPN=true",
                        "VPN_SERVICE_PROVIDER=mullvad",
                        "VPN_TYPE=wireguard",
                        "WIREGUARD_PRIVATE_KEY=priv",
                        "WIREGUARD_ADDRESSES=10.0.0.2/32",
                        "WIREGUARD_ADVANCED_ENABLED=n",
                        "WIREGUARD_PUBLIC_KEY=",
                        "WIREGUARD_ENDPOINT_IP=",
                        "WIREGUARD_ENDPOINT_PORT=",
                        "WIREGUARD_PRESHARED_KEY=",
                        "WIREGUARD_ALLOWED_IPS=",
                        "WIREGUARD_IMPLEMENTATION=",
                        "WIREGUARD_MTU=",
                        "WIREGUARD_PERSISTENT_KEEPALIVE_INTERVAL=",
                        "QBIT_WEBUI=8080",
                        "PROWLARR_PORT=9696",
                        "SONARR_PORT=8989",
                        "RADARR_PORT=7878",
                        "BAZARR_PORT=6767",
                        "FLARESOLVERR_PORT=8191",
                        "CROSS_SEED_PORT=2468",
                        "HEALTH_PORT=3000",
                        "VPN_FILTERS_ENABLED=n",
                        "VPN_HOSTNAME_FILTERS_ENABLED=n",
                        "SERVER_COUNTRIES=",
                        "SERVER_REGIONS=",
                        "SERVER_CITIES=",
                        "SERVER_HOSTNAMES=",
                        "SERVER_NAMES=",
                        "VPN_PORT_FORWARDING_ENABLED=n",
                        "PORT_FORWARDING_PROVIDER=",
                    ]
                )
                + "\n"
            )
            with patch("servarr_bootstrap.env_setup.typer.prompt") as mocked_prompt:
                interactive_env_setup(root, console)
            mocked_prompt.assert_not_called()

    def test_skips_vpn_fields_when_disabled(self):
        console = Console(record=True)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompt_values = [
                "/data/media",
                "2000",
                "2000",
                "10.0.0.0/24",
                "UTC",
                "admin",
                "changeme",
                "false",
                "8081",
                "9700",
                "8990",
                "7880",
                "6770",
                "8200",
                "2500",
                "3100",
            ]
            with patch("servarr_bootstrap.env_setup.typer.prompt", side_effect=prompt_values), patch(
                "servarr_bootstrap.env_setup.detect_timezone", return_value="UTC"
            ):
                interactive_env_setup(root, console)

            env_file = root / ".env"
            text = env_file.read_text()
            self.assertIn("USE_VPN=false", text)
            self.assertNotIn("VPN_SERVICE_PROVIDER", text)

    def test_skips_server_filters_unless_requested(self):
        console = Console(record=True)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompt_values = [
                "/data/media",
                "2000",
                "2000",
                "10.0.0.0/24",
                "UTC",
                "admin",
                "changeme",
                "true",
                "mullvad",
                "wireguard",
                "privkey",
                "10.0.0.2/32",
                "n",  # advanced wg
                "n",  # skip filters
                "n",  # skip port forwarding
                "8081",
                "9700",
                "8990",
                "7880",
                "6770",
                "8200",
                "2500",
                "3100",
            ]
            with patch("servarr_bootstrap.env_setup.typer.prompt", side_effect=prompt_values), patch(
                "servarr_bootstrap.env_setup.detect_timezone", return_value="UTC"
            ):
                interactive_env_setup(root, console)

            env_file = root / ".env"
            text = env_file.read_text()
            self.assertIn("USE_VPN=true", text)
            self.assertIn("VPN_SERVICE_PROVIDER=mullvad", text)
            self.assertNotIn("SERVER_COUNTRIES", text)
            self.assertNotIn("SERVER_CITIES", text)
            self.assertNotIn("SERVER_HOSTNAMES", text)

    def test_prompts_hostnames_only_when_enabled(self):
        console = Console(record=True)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompt_values = [
                "/data/media",
                "2000",
                "2000",
                "10.0.0.0/24",
                "UTC",
                "admin",
                "changeme",
                "true",
                "mullvad",
                "wireguard",
                "privkey",
                "10.0.0.2/32",
                "n",  # advanced wg
                "y",  # enable filters
                "Sweden",
                "",   # region optional
                "Stockholm",
                "y",  # enable hostname filters
                "se-sto-001",
                "se-sto",  # server name
                "n",  # skip port forwarding
                "8081",
                "9700",
                "8990",
                "7880",
                "6770",
                "8200",
                "2500",
                "3100",
            ]
            with patch("servarr_bootstrap.env_setup.typer.prompt", side_effect=prompt_values), patch(
                "servarr_bootstrap.env_setup.detect_timezone", return_value="UTC"
            ):
                interactive_env_setup(root, console)

            env_file = root / ".env"
            text = env_file.read_text()
            self.assertIn("SERVER_COUNTRIES=Sweden", text)
            self.assertIn("SERVER_REGIONS=", text)
            self.assertIn("SERVER_CITIES=Stockholm", text)
            self.assertIn("VPN_HOSTNAME_FILTERS_ENABLED=y", text)
            self.assertIn("SERVER_HOSTNAMES=se-sto-001", text)

    def test_prompts_port_forwarding_provider_only_when_enabled(self):
        console = Console(record=True)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompt_values = [
                "/data/media",
                "2000",
                "2000",
                "10.0.0.0/24",
                "UTC",
                "admin",
                "changeme",
                "true",
                "mullvad",
                "wireguard",
                "privkey",
                "10.0.0.2/32",
                "n",  # advanced wg
                "n",  # no filters
                "y",  # enable port forwarding
                "gluetun",  # provider
                "8081",
                "9700",
                "8990",
                "7880",
                "6770",
                "8200",
                "2500",
                "3100",
            ]
            with patch("servarr_bootstrap.env_setup.typer.prompt", side_effect=prompt_values), patch(
                "servarr_bootstrap.env_setup.detect_timezone", return_value="UTC"
            ):
                interactive_env_setup(root, console)

            env_file = root / ".env"
            text = env_file.read_text()
            self.assertIn("VPN_PORT_FORWARDING_ENABLED=y", text)
            self.assertIn("PORT_FORWARDING_PROVIDER=gluetun", text)

    def test_skips_region_city_when_country_blank_by_default(self):
        console = Console(record=True)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompt_values = [
                "/data/media",
                "2000",
                "2000",
                "10.0.0.0/24",
                "UTC",
                "admin",
                "changeme",
                "true",
                "mullvad",
                "wireguard",
                "privkey",
                "10.0.0.2/32",
                "n",
                "y",  # enable filters
                "",  # no country
                "n",  # do not add region/city without country
                "n",  # hostnames
                "n",  # port forwarding
                "8081",
                "9700",
                "8990",
                "7880",
                "6770",
                "8200",
                "2500",
                "3100",
            ]
            with patch("servarr_bootstrap.env_setup.typer.prompt", side_effect=prompt_values), patch(
                "servarr_bootstrap.env_setup.detect_timezone", return_value="UTC"
            ):
                interactive_env_setup(root, console)

            env_file = root / ".env"
            text = env_file.read_text()
            self.assertIn("VPN_FILTERS_ENABLED=y", text)
            self.assertIn("SERVER_COUNTRIES=", text)
            self.assertNotIn("SERVER_REGIONS", text)
            self.assertNotIn("SERVER_CITIES", text)

    def test_allows_region_city_without_country_when_opted_in(self):
        console = Console(record=True)
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            prompt_values = [
                "/data/media",
                "2000",
                "2000",
                "10.0.0.0/24",
                "UTC",
                "admin",
                "changeme",
                "true",
                "mullvad",
                "wireguard",
                "privkey",
                "10.0.0.2/32",
                "n",
                "y",  # enable filters
                "",  # no country
                "y",  # allow region/city without country
                "EMEA",
                "Stockholm",
                "n",  # hostnames
                "n",  # port forwarding
                "8081",
                "9700",
                "8990",
                "7880",
                "6770",
                "8200",
                "2500",
                "3100",
            ]
            with patch("servarr_bootstrap.env_setup.typer.prompt", side_effect=prompt_values), patch(
                "servarr_bootstrap.env_setup.detect_timezone", return_value="UTC"
            ):
                interactive_env_setup(root, console)

            env_file = root / ".env"
            text = env_file.read_text()
            self.assertIn("SERVER_REGIONS=EMEA", text)
            self.assertIn("SERVER_CITIES=Stockholm", text)
