import unittest
from pathlib import Path

from rich.console import Console

from servarr_bootstrap.services.arr import ArrClient


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class ArrClientTests(unittest.TestCase):
    def setUp(self):
        self.console = Console(record=True)
        self.client = ArrClient("Sonarr", "http://localhost:8989", "apikey", self.console, dry_run=True)

    def test_ensure_root_folder_dry_run(self):
        self.client.ensure_root_folder(Path("/mnt/media/tv"))
        # dry run should simply print without hitting API

    def test_ensure_root_folder_adds_folder(self):
        client = ArrClient("Sonarr", "http://localhost:8989", "apikey", self.console, dry_run=False)
        calls = []

        def fake_request(method, path, **kwargs):
            calls.append((method, path, kwargs))
            if method == "GET" and path == "/api/v3/rootfolder":
                return FakeResponse([{"path": "/other"}])
            if method == "POST" and path == "/api/v3/rootfolder":
                self.assertEqual(kwargs.get("json"), {"path": "/mnt/media/tv"})
                return FakeResponse({"path": "/mnt/media/tv"})
            raise AssertionError("Unexpected call", method, path)

        client._request = fake_request  # type: ignore[assignment]
        client.ensure_root_folder("/mnt/media/tv")
        self.assertEqual(len(calls), 2)

    def test_ensure_root_folder_skips_existing(self):
        client = ArrClient("Sonarr", "http://localhost:8989", "apikey", self.console, dry_run=False)

        def fake_request(method, path, **kwargs):
            if method == "GET":
                return FakeResponse([{"path": "/mnt/media/tv"}])
            raise AssertionError("POST should not be called")

        client._request = fake_request  # type: ignore[assignment]
        client.ensure_root_folder("/mnt/media/tv")


if __name__ == "__main__":
    unittest.main()
