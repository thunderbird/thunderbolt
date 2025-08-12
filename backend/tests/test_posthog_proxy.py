"""Test the PostHog analytics proxy endpoint."""

import pytest
from httpx import ASGITransport, AsyncClient

from main import app


@pytest.mark.asyncio
async def test_posthog_proxy_endpoint_exists():
    """Test that the PostHog proxy endpoint exists and handles OPTIONS."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.options("/posthog/test")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
