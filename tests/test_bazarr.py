import json
import unittest

from rich.console import Console

from servarr_bootstrap.services.bazarr import BazarrClient, LANGUAGE_PROFILE_TAG, ANY_CUTOFF


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = ""

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError("HTTP error")


class _FakeSession:
    def __init__(self, get_payloads):
        self._get_payloads = get_payloads
        self.headers = {}
        self.post_calls = []

    def get(self, url, timeout=0):
        handler = self._get_payloads.get(url)
        if handler is None:
            raise AssertionError(f"Unexpected GET {url}")
        return _FakeResponse(handler())

    def post(self, url, data=None, timeout=0):
        if isinstance(data, dict):
            payload = list(data.items())
        else:
            payload = list(data or [])
        self.post_calls.append({"url": url, "data": payload})
        return _FakeResponse({}, status_code=204)


class BazarrClientLanguageTests(unittest.TestCase):
    def _build_client(self, session):
        client = BazarrClient("http://bazarr", "key", Console(record=True), dry_run=False)
        client.session = session
        return client

    def test_ensure_language_preferences_updates_existing_profile(self):
        base_url = "http://bazarr"
        profiles_url = f"{base_url}/api/system/languages/profiles"
        languages_url = f"{base_url}/api/system/languages"
        settings_url = f"{base_url}/api/system/settings"

        existing_profiles = [
            {
                "profileId": 3,
                "name": "Custom",
                "cutoff": None,
                "items": [
                    {
                        "id": 10,
                        "language": "fr",
                        "audio_exclude": "False",
                        "audio_only_include": "False",
                        "hi": "False",
                        "forced": "False",
                    }
                ],
                "mustContain": [],
                "mustNotContain": [],
                "originalFormat": False,
                "tag": LANGUAGE_PROFILE_TAG,
            },
            {
                "profileId": 8,
                "name": "Other",
                "cutoff": None,
                "items": [
                    {
                        "id": 1,
                        "language": "es",
                        "audio_exclude": "False",
                        "audio_only_include": "False",
                        "hi": "False",
                        "forced": "False",
                    }
                ],
                "mustContain": [],
                "mustNotContain": [],
                "originalFormat": False,
                "tag": "another-tag",
            },
        ]

        session = _FakeSession(
            {
                profiles_url: lambda: existing_profiles,
                languages_url: lambda: [{"code2": "es", "enabled": True, "name": "Spanish"}],
            }
        )
        client = self._build_client(session)

        client.ensure_language_preferences()

        self.assertEqual(len(session.post_calls), 1)
        post_call = session.post_calls[0]
        self.assertEqual(post_call["url"], settings_url)

        payload = post_call["data"]
        enabled_values = [value for key, value in payload if key == "languages-enabled"]
        self.assertCountEqual(enabled_values, ["en", "es"])

        profiles_payload = next(value for key, value in payload if key == "languages-profiles")
        updated_profiles = json.loads(profiles_payload)
        self.assertEqual(len(updated_profiles), len(existing_profiles))

        target_profile = next(profile for profile in updated_profiles if profile["tag"] == LANGUAGE_PROFILE_TAG)
        self.assertEqual(target_profile["profileId"], 3)
        self.assertEqual(len(target_profile["items"]), 2)
        self.assertEqual(target_profile["cutoff"], ANY_CUTOFF)

        serie_default = next(value for key, value in payload if key == "settings-general-serie_default_profile")
        movie_default = next(value for key, value in payload if key == "settings-general-movie_default_profile")
        self.assertEqual(serie_default, "3")
        self.assertEqual(movie_default, "3")

    def test_creates_new_profile_when_none_exist(self):
        base_url = "http://bazarr"
        profiles_url = f"{base_url}/api/system/languages/profiles"
        languages_url = f"{base_url}/api/system/languages"

        session = _FakeSession(
            {
                profiles_url: lambda: [],
                languages_url: lambda: [],
            }
        )
        client = self._build_client(session)

        client.ensure_language_preferences()

        post_call = session.post_calls[0]
        payload = post_call["data"]

        enabled_values = [value for key, value in payload if key == "languages-enabled"]
        self.assertEqual(enabled_values, ["en"])

        profiles_payload = next(value for key, value in payload if key == "languages-profiles")
        updated_profiles = json.loads(profiles_payload)
        target_profile = updated_profiles[0]
        self.assertEqual(target_profile["profileId"], 1)
        self.assertEqual(target_profile["tag"], LANGUAGE_PROFILE_TAG)

        serie_default = next(value for key, value in payload if key == "settings-general-serie_default_profile")
        self.assertEqual(serie_default, "1")


if __name__ == "__main__":
    unittest.main()
