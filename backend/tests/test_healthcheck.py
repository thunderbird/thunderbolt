from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient, TimeoutException


class TestHealthCheckEndpoints:
    """Test suite for health check endpoints."""

    def test_health_check_missing_token(self, client: TestClient) -> None:
        """Test health check endpoint without monitoring token."""
        response = client.get("/healthcheck/flower/qwen/qwen3-235b")
        assert response.status_code == 422  # Validation error for missing token

    def test_health_check_invalid_token(self, client: TestClient) -> None:
        """Test health check endpoint with invalid monitoring token."""
        with patch("config.get_settings") as mock_settings:
            mock_settings.return_value.monitoring_token = "valid_token"
            response = client.get(
                "/healthcheck/flower/qwen/qwen3-235b?token=invalid_token"
            )
            assert response.status_code == 401
            assert "Invalid monitoring token" in response.json()["detail"]

    def test_health_check_no_monitoring_configured(self, client: TestClient) -> None:
        """Test health check when monitoring token is not configured."""
        with patch("config.get_settings") as mock_settings:
            mock_settings.return_value.monitoring_token = ""
            response = client.get("/healthcheck/flower/qwen/qwen3-235b?token=any_token")
            assert response.status_code == 503
            assert "Health check not configured" in response.json()["detail"]

    def test_health_check_any_model_uses_default_config(
        self, client: TestClient
    ) -> None:
        """Test health check works with any model name using default configuration."""
        with patch("config.get_settings") as mock_settings:
            mock_settings.return_value.monitoring_token = "valid_token"
            mock_settings.return_value.flower_mgmt_key = "test_key"
            mock_settings.return_value.flower_proj_id = "test_proj"

            # Any model name should work with default config (though may fail due to model availability)
            # This just tests that we don't reject models as "not configured" anymore
            response = client.get(
                "/healthcheck/flower/any-model-name?token=valid_token"
            )
            data = response.json()
            assert data["model"] == "any-model-name"
            assert data["service"] == "flower"
            # Should not contain "not configured for health checks" error
            if not data["ok"]:
                assert "not configured for health checks" not in data.get("error", "")

    def test_health_check_flower_not_configured(self, client: TestClient) -> None:
        """Test health check when Flower AI is not configured."""
        with patch("config.get_settings") as mock_settings:
            mock_settings.return_value.monitoring_token = "valid_token"
            mock_settings.return_value.flower_mgmt_key = ""
            mock_settings.return_value.flower_proj_id = ""

            response = client.get(
                "/healthcheck/flower/qwen/qwen3-235b?token=valid_token"
            )
            assert response.status_code == 503
            data = response.json()
            assert data["ok"] is False
            assert data["error"] == "Flower AI not configured"

    @patch("healthcheck.httpx.AsyncClient")
    @patch("healthcheck.get_flower_api_key")
    def test_health_check_success(
        self,
        mock_get_api_key: AsyncMock,
        mock_client_class: AsyncMock,
        client: TestClient,
    ) -> None:
        """Test successful health check with correct response."""
        # Mock settings
        with patch("config.get_settings") as mock_settings:
            mock_settings.return_value.monitoring_token = "valid_token"
            mock_settings.return_value.flower_mgmt_key = "test_key"
            mock_settings.return_value.flower_proj_id = "test_proj"

            # Mock API key generation
            mock_get_api_key.return_value = "test_api_key"

            # Mock HTTP client and response
            mock_client = AsyncMock()
            mock_client_class.return_value.__aenter__.return_value = mock_client

            mock_response = MagicMock()
            mock_response.raise_for_status = MagicMock()

            # Mock streaming response with expected content
            streaming_lines = [
                'data: {"choices": [{"delta": {"content": "Healthcheck"}}]}',
                'data: {"choices": [{"delta": {"content": " confirmed."}}]}',
                "data: [DONE]",
            ]

            async def async_lines():
                for line in streaming_lines:
                    yield line

            mock_response.aiter_lines.return_value = async_lines()
            mock_client.post.return_value = mock_response

            response = client.get(
                "/healthcheck/flower/qwen/qwen3-235b?token=valid_token"
            )
            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True
            assert data["model"] == "qwen/qwen3-235b"
            assert data["service"] == "flower"
            assert data["response"] == "Healthcheck confirmed."
            assert data["error"] is None
            assert "latency_ms" in data
            assert "timestamp" in data

    @patch("healthcheck.httpx.AsyncClient")
    @patch("healthcheck.get_flower_api_key")
    def test_health_check_response_mismatch(
        self,
        mock_get_api_key: AsyncMock,
        mock_client_class: AsyncMock,
        client: TestClient,
    ) -> None:
        """Test health check with incorrect response."""
        with patch("healthcheck.get_settings") as mock_settings:
            mock_settings.return_value.monitoring_token = "valid_token"
            mock_settings.return_value.flower_mgmt_key = "test_key"
            mock_settings.return_value.flower_proj_id = "test_proj"

            mock_get_api_key.return_value = "test_api_key"

            mock_client = AsyncMock()
            mock_client_class.return_value.__aenter__.return_value = mock_client

            mock_response = MagicMock()
            mock_response.raise_for_status = MagicMock()

            # Mock streaming response with wrong content
            streaming_lines = [
                'data: {"choices": [{"delta": {"content": "Wrong response"}}]}',
                "data: [DONE]",
            ]

            async def async_lines():
                for line in streaming_lines:
                    yield line

            mock_response.aiter_lines.return_value = async_lines()
            mock_client.post.return_value = mock_response

            response = client.get(
                "/healthcheck/flower/qwen/qwen3-235b?token=valid_token"
            )
            assert response.status_code == 503
            data = response.json()
            assert data["ok"] is False
            assert data["response"] == "Wrong response"
            assert "Response mismatch" in data["error"]

    @patch("healthcheck.httpx.AsyncClient")
    @patch("healthcheck.get_flower_api_key")
    def test_health_check_timeout(
        self,
        mock_get_api_key: AsyncMock,
        mock_client_class: AsyncMock,
        client: TestClient,
    ) -> None:
        """Test health check timeout handling."""
        with patch("healthcheck.get_settings") as mock_settings:
            mock_settings.return_value.monitoring_token = "valid_token"
            mock_settings.return_value.flower_mgmt_key = "test_key"
            mock_settings.return_value.flower_proj_id = "test_proj"

            mock_get_api_key.return_value = "test_api_key"

            mock_client = AsyncMock()
            mock_client_class.return_value.__aenter__.return_value = mock_client

            # Mock timeout error

            mock_client.post.side_effect = TimeoutException("Request timeout")

            response = client.get(
                "/healthcheck/flower/qwen/qwen3-235b?token=valid_token"
            )
            assert response.status_code == 503
            data = response.json()
            assert data["ok"] is False
            assert "Request timeout" in data["error"]

    def test_health_check_status_no_token(self, client: TestClient) -> None:
        """Test status endpoint without monitoring token."""
        response = client.get("/healthcheck/status")
        assert response.status_code == 422  # Validation error for missing token

    def test_health_check_status_success(self, client: TestClient) -> None:
        """Test status endpoint with valid token."""
        with patch("healthcheck.get_settings") as mock_settings:
            mock_settings.return_value.monitoring_token = "valid_token"
            mock_settings.return_value.flower_mgmt_key = "test_key"
            mock_settings.return_value.flower_proj_id = "test_proj"

            response = client.get("/healthcheck/status?token=valid_token")
            assert response.status_code == 200
            data = response.json()
            assert "services" in data
            assert "flower" in data["services"]
            assert data["services"]["flower"]["available"] is True
            assert "qwen/qwen3-235b" in data["services"]["flower"]["models"]
            assert "timestamp" in data
            assert "total_endpoints" in data

    def test_health_check_status_flower_unavailable(self, client: TestClient) -> None:
        """Test status endpoint when Flower AI is not configured."""
        with patch("healthcheck.get_settings") as mock_settings:
            mock_settings.return_value.monitoring_token = "valid_token"
            mock_settings.return_value.flower_mgmt_key = ""
            mock_settings.return_value.flower_proj_id = ""

            response = client.get("/healthcheck/status?token=valid_token")
            assert response.status_code == 200
            data = response.json()
            assert data["services"]["flower"]["available"] is False
            assert data["services"]["flower"]["models"] == []


@pytest.mark.asyncio
class TestHealthCheckEndpointsAsync:
    """Async test suite for health check endpoints."""

    async def test_health_check_success_async(self, async_client: AsyncClient) -> None:
        """Test successful health check with async client."""
        with (
            patch("config.get_settings") as mock_settings,
            patch("healthcheck.httpx.AsyncClient") as mock_client_class,
            patch("healthcheck.get_flower_api_key") as mock_get_api_key,
        ):
            mock_settings.return_value.monitoring_token = "valid_token"
            mock_settings.return_value.flower_mgmt_key = "test_key"
            mock_settings.return_value.flower_proj_id = "test_proj"

            mock_get_api_key.return_value = "test_api_key"

            mock_client = AsyncMock()
            mock_client_class.return_value.__aenter__.return_value = mock_client

            mock_response = MagicMock()
            mock_response.raise_for_status = MagicMock()

            streaming_lines = [
                'data: {"choices": [{"delta": {"content": "Healthcheck confirmed."}}]}',
                "data: [DONE]",
            ]

            async def async_lines():
                for line in streaming_lines:
                    yield line

            mock_response.aiter_lines.return_value = async_lines()
            mock_client.post.return_value = mock_response

            response = await async_client.get(
                "/healthcheck/flower/qwen/qwen3-235b?token=valid_token"
            )
            assert response.status_code == 200
            data = response.json()
            assert data["ok"] is True
            assert data["model"] == "qwen/qwen3-235b"
