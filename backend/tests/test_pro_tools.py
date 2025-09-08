"""Test pro tools functionality."""

from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture
def client() -> TestClient:
    """Create a test client for the FastAPI app."""
    return TestClient(app)


class TestProToolsEndpoints:
    """Test class for pro tools endpoints."""

    def test_search_endpoint_exists(self, client: TestClient) -> None:
        """Test that the search endpoint exists and returns proper error for invalid request."""
        response = client.post("/pro/search", json={})
        # Should get validation error for missing query field
        assert response.status_code == 422

    @patch("pro.routes.search_exa")
    @patch("pro.routes.exa_client")
    def test_search_endpoint_success(
        self, mock_exa_client: Mock, mock_search: AsyncMock, client: TestClient
    ) -> None:
        """Test successful search endpoint response."""
        # Mock the Exa client to exist
        mock_exa_client.return_value = Mock()
        # Mock the search_exa function
        mock_search.return_value = [
            {
                "title": "Test Result",
                "url": "https://example.com",
                "snippet": "Test snippet",
                "position": 1,
            }
        ]

        response = client.post(
            "/pro/search", json={"query": "test query", "max_results": 5}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "results" in data
        assert "Test Result" in data["results"]

    def test_fetch_content_endpoint_exists(self, client: TestClient) -> None:
        """Test that the fetch-content endpoint exists and returns proper error for invalid request."""
        response = client.post("/pro/fetch-content", json={})
        # Should get validation error for missing url field
        assert response.status_code == 422

    def test_weather_current_endpoint_exists(self, client: TestClient) -> None:
        """Test that the current weather endpoint exists and returns proper error for invalid request."""
        response = client.post("/pro/weather/current", json={})
        # Should get validation error for missing location field
        assert response.status_code == 422

    def test_weather_forecast_endpoint_exists(self, client: TestClient) -> None:
        """Test that the weather forecast endpoint exists and returns proper error for invalid request."""
        response = client.post("/pro/weather/forecast", json={})
        # Should get validation error for missing location field
        assert response.status_code == 422

    def test_locations_search_endpoint_exists(self, client: TestClient) -> None:
        """Test that the locations search endpoint exists and returns proper error for invalid request."""
        response = client.post("/pro/locations/search", json={})
        # Should get validation error for missing query field
        assert response.status_code == 422

    @patch("pro.routes.fetch_content_exa")
    @patch("pro.routes.exa_client")
    def test_fetch_content_endpoint_success(
        self, mock_exa_client: Mock, mock_fetch: AsyncMock, client: TestClient
    ) -> None:
        """Test successful fetch-content endpoint response using Exa proxy."""
        # Mock the Exa client to exist
        mock_exa_client.return_value = Mock()
        # Mock the fetch_content_exa function
        mock_fetch.return_value = "Fetched content"

        response = client.post(
            "/pro/fetch-content", json={"url": "https://example.com"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "content" in data
        assert data["content"] == "Fetched content"

    @patch("pro.openmeteo.OpenMeteoWeather.get_current_weather")
    def test_weather_current_endpoint_success(
        self, mock_weather: AsyncMock, client: TestClient
    ) -> None:
        """Test successful current weather endpoint response."""
        mock_weather.return_value = "Current weather data"

        response = client.post("/pro/weather/current", json={"location": "London"})

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "weather_data" in data

    @patch("pro.openmeteo.OpenMeteoWeather.search_locations")
    def test_locations_search_endpoint_success(
        self, mock_search: AsyncMock, client: TestClient
    ) -> None:
        """Test successful locations search endpoint response."""
        mock_search.return_value = [
            {
                "name": "London",
                "admin1": "England",
                "country": "United Kingdom",
                "latitude": 51.5074,
                "longitude": -0.1278,
                "elevation": 25,
            }
        ]

        response = client.post("/pro/locations/search", json={"query": "London"})

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "locations" in data
        assert "London" in data["locations"]
