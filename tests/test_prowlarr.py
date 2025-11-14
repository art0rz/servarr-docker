import unittest

from rich.console import Console

from servarr_bootstrap.services.prowlarr import ProwlarrClient


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class ProwlarrClientTests(unittest.TestCase):
    def setUp(self):
        self.console = Console(record=True)

    def test_ensure_flaresolverr_proxy_creates_entry(self):
        client = ProwlarrClient("http://localhost:9696", "key", self.console, dry_run=False)
        calls = []

        def fake_request(method, path, **kwargs):
            calls.append((method, path, kwargs))
            if path == "/api/v1/indexerProxy" and method == "GET":
                return FakeResponse([])
            if path == "/api/v1/indexerProxy/schema" and method == "GET":
                return FakeResponse([
                    {
                        "implementation": "FlareSolverr",
                        "fields": [{"name": "host", "value": "http://localhost:8191/"}],
                    }
                ])
            if path == "/api/v1/indexerProxy" and method == "POST":
                payload = kwargs.get("json")
                self.assertEqual(payload["name"], "FlareSolverr")
                self.assertEqual(payload["fields"][0]["value"], "http://flaresolverr:8191/")
                return FakeResponse({})
            raise AssertionError((method, path))

        client._request = fake_request  # type: ignore[assignment]
        client.ensure_flaresolverr_proxy("http://flaresolverr:8191")
        self.assertTrue(any(call[0] == "POST" and call[1] == "/api/v1/indexerProxy" for call in calls))

    def test_ensure_ui_credentials_disables_local_auth(self):
        client = ProwlarrClient("http://localhost:9696", "key", self.console, dry_run=False)

        def fake_request(method, path, **kwargs):
            if method == "GET" and path == "/api/v1/config/host":
                return FakeResponse({"authenticationMethod": "forms"})
            if method == "PUT" and path == "/api/v1/config/host":
                payload = kwargs.get("json", {})
                assert payload["authenticationRequired"] == "disabledForLocalAddresses"
                assert payload["username"] == "user"
                assert payload["password"] == "pass"
                return FakeResponse(payload)
            raise AssertionError((method, path))

        client._request = fake_request  # type: ignore[assignment]
        client.ensure_ui_credentials("user", "pass")


if __name__ == "__main__":
    unittest.main()
