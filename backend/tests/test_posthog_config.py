"""Test PostHog configuration with POSTHOG_HOST environment variable."""

from unittest.mock import patch

from config import Settings


def test_posthog_host_default():
    """Test that PostHog host defaults to US instance."""
    settings = Settings()
    assert settings.posthog_host == "https://us.i.posthog.com"


def test_posthog_host_from_env():
    """Test that POSTHOG_HOST environment variable is used."""
    with patch.dict("os.environ", {"POSTHOG_HOST": "https://custom.posthog.com"}):
        settings = Settings()
        assert settings.posthog_host == "https://custom.posthog.com"


def test_posthog_proxy_config_custom():
    """Test that proxy config uses custom host when POSTHOG_HOST is set."""
    with patch.dict("os.environ", {"POSTHOG_HOST": "https://eu.posthog.com"}):
        settings = Settings()
        assert settings.posthog_host == "https://eu.posthog.com"
