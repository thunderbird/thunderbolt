"""Tests for the analytics configuration endpoint (/analytics/config)."""

from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from main import app, get_settings


@pytest.mark.asyncio
async def test_analytics_config_default() -> None:
    """Returns an empty API key by default and only exposes the expected field.

    Force POSTHOG_API_KEY to empty to avoid interference from local env or .env files.
    """
    with patch.dict("os.environ", {"POSTHOG_API_KEY": ""}):
        # Ensure fresh settings (clear LRU cache)
        get_settings.cache_clear()  # type: ignore[attr-defined]

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/analytics/config")
            assert resp.status_code == 200
            data = resp.json()
            # Only exposes the public key field
            assert set(data.keys()) == {"posthog_api_key"}
            # Defaults to empty string if not configured
            assert data["posthog_api_key"] == ""


@pytest.mark.asyncio
async def test_analytics_config_env_override() -> None:
    """Uses POSTHOG_API_KEY from environment when provided."""
    with patch.dict("os.environ", {"POSTHOG_API_KEY": "phc_test_123"}):
        # Clear cached settings so the env var is picked up
        get_settings.cache_clear()  # type: ignore[attr-defined]

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/analytics/config")
            assert resp.status_code == 200
            data = resp.json()
            assert set(data.keys()) == {"posthog_api_key"}
            assert data["posthog_api_key"] == "phc_test_123"
