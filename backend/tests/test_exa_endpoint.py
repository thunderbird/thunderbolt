"""
Comprehensive tests for Exa AI client functionality including search and content fetching
"""

import os
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi.testclient import TestClient
from httpx import HTTPStatusError, Request, Response

from backend.pro.context import SimpleContext
from backend.pro.exa import ExaClient
from main import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def exa_client():
    """Create an ExaClient instance with mock API key"""
    with patch("backend.pro.exa.Settings") as mock_settings:
        mock_settings.return_value.exa_api_key = "test_api_key"
        return ExaClient()


@pytest.fixture
def mock_context():
    """Create a mock SimpleContext for testing"""
    ctx = Mock(spec=SimpleContext)
    ctx.info = AsyncMock()
    ctx.error = AsyncMock()
    return ctx


# =============================================================================
# SEARCH ENDPOINT TESTS
# =============================================================================


def test_search_exa_endpoint_exists(client):
    """Test that the search-exa endpoint exists"""
    response = client.post("/pro/search-exa", json={"query": "test", "max_results": 5})
    # Should get a response (either success or configured error), not 404
    assert response.status_code == 200


def test_search_exa_without_api_key(client):
    """Test that search-exa returns proper error when API key is not configured"""
    response = client.post(
        "/pro/search-exa", json={"query": "test search", "max_results": 5}
    )
    assert response.status_code == 200

    data = response.json()
    # Should indicate failure due to missing configuration
    if not data["success"]:
        assert "not configured" in data["error"] or "EXA_API_KEY" in data["error"]


def test_search_exa_request_validation(client):
    """Test that search-exa validates request parameters"""
    # Missing required field
    response = client.post("/pro/search-exa", json={"max_results": 5})
    assert response.status_code == 422  # Validation error

    # Invalid data type
    response = client.post("/pro/search-exa", json={"query": 123, "max_results": 5})
    assert response.status_code == 422  # Validation error


@pytest.mark.skipif(
    not bool(os.getenv("EXA_API_KEY")),
    reason="EXA_API_KEY not set - skipping real API test",
)
def test_search_exa_with_real_api(client):
    """Test search-exa with real API key when available"""
    response = client.post(
        "/pro/search-exa",
        json={"query": "python programming language", "max_results": 3},
    )
    assert response.status_code == 200

    data = response.json()
    if data["success"]:
        assert "python" in data["results"].lower()
        assert len(data["results"]) > 0


# =============================================================================
# FETCH CONTENT ENDPOINT TESTS
# =============================================================================


def test_fetch_content_endpoint_exists(client):
    """Test that the fetch-content endpoint exists"""
    response = client.post("/pro/fetch-content", json={"url": "https://example.com"})
    # Should get a response (either success or error), not 404
    assert response.status_code == 200


def test_fetch_content_request_validation(client):
    """Test that fetch-content validates request parameters"""
    # Missing required field
    response = client.post("/pro/fetch-content", json={})
    assert response.status_code == 422  # Validation error

    # Invalid URL format
    response = client.post("/pro/fetch-content", json={"url": "not-a-url"})
    assert response.status_code == 200  # Should handle gracefully, not validation error


@pytest.mark.skipif(
    not bool(os.getenv("EXA_API_KEY")),
    reason="EXA_API_KEY not set - skipping real API test",
)
def test_fetch_content_with_real_api(client):
    """Test fetch-content with real API key when available"""
    response = client.post("/pro/fetch-content", json={"url": "https://example.com"})
    assert response.status_code == 200

    data = response.json()
    # Should either succeed with Exa or fallback to direct fetch
    assert "content" in data
    if data["success"]:
        assert len(data["content"]) > 0


# =============================================================================
# EXA CLIENT SEARCH TESTS
# =============================================================================


class TestExaClientSearch:
    """Tests for ExaClient search functionality"""

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_successful_search(self, mock_client_class, exa_client, mock_context):
        """Test successful search execution"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful Exa response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [
                {
                    "title": "Test Page",
                    "url": "https://example.com",
                    "text": "This is test content for the search result",
                    "author": "Test Author",
                    "published_date": "2025-01-01",
                }
            ]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        results = await exa_client.search("test query", mock_context, 5)

        assert len(results) == 1
        assert results[0]["title"] == "Test Page"
        assert results[0]["url"] == "https://example.com"
        assert results[0]["position"] == 1
        assert "test content" in results[0]["snippet"]

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_search_authentication_error(
        self, mock_client_class, exa_client, mock_context
    ):
        """Test handling of search authentication errors"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock 401 response
        mock_request = Mock(spec=Request)
        mock_response = Mock(spec=Response)
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"

        mock_client.post.side_effect = HTTPStatusError(
            "401 Unauthorized", request=mock_request, response=mock_response
        )

        results = await exa_client.search("test", mock_context)

        assert results == []
        mock_context.error.assert_called_with("Invalid Exa API key")

    def test_format_search_results_for_llm_empty(self, exa_client):
        """Test formatting when no search results"""
        result = exa_client.format_search_results_for_llm([])
        assert "No results were found" in result

    def test_format_search_results_for_llm_with_results(self, exa_client):
        """Test formatting with actual search results"""
        results = [
            {
                "title": "Test Page",
                "url": "https://example.com",
                "snippet": "Test content",
                "position": 1,
                "author": "Test Author",
                "published_date": "2025-01-01",
            }
        ]

        formatted = exa_client.format_search_results_for_llm(results)

        assert "1 search results" in formatted
        assert "Test Page" in formatted
        assert "https://example.com" in formatted
        assert "Test content" in formatted
        assert "Test Author" in formatted


# =============================================================================
# EXA CLIENT CONTENT FETCHING TESTS
# =============================================================================


class TestExaClientContentFetching:
    """Tests for ExaClient content fetching functionality"""

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_successful_content_fetch(
        self, mock_client_class, exa_client, mock_context
    ):
        """Test successful content fetching and parsing"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful Exa response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [
                {
                    "text": "This is sample content from the webpage",
                    "title": "Sample Page",
                    "url": "https://example.com",
                }
            ],
            "statuses": [{"status": "success"}],
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = await exa_client.fetch_content("https://example.com", mock_context)

        assert (
            result
            == "Content from https://example.com:\n\nThis is sample content from the webpage"
        )
        mock_context.info.assert_any_call("Fetching content from: https://example.com")

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_content_fetch_not_found_error(
        self, mock_client_class, exa_client, mock_context
    ):
        """Test handling of Exa CRAWL_NOT_FOUND error"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock Exa error response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [],
            "statuses": [
                {
                    "status": "error",
                    "error": {"tag": "CRAWL_NOT_FOUND", "httpStatusCode": 404},
                }
            ],
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = await exa_client.fetch_content("https://nonexistent.com", mock_context)

        assert result == "Error: The webpage could not be found or accessed."
        mock_context.error.assert_called_with(
            "Content fetch failed for https://nonexistent.com: CRAWL_NOT_FOUND (HTTP 404)"
        )

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_content_fetch_timeout_error(
        self, mock_client_class, exa_client, mock_context
    ):
        """Test handling of Exa CRAWL_TIMEOUT error"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock Exa timeout response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [],
            "statuses": [
                {
                    "status": "error",
                    "error": {"tag": "CRAWL_TIMEOUT", "httpStatusCode": 408},
                }
            ],
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = await exa_client.fetch_content("https://slow-site.com", mock_context)

        assert (
            result == "Error: The request timed out while trying to fetch the webpage."
        )

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_content_fetch_empty_content(
        self, mock_client_class, exa_client, mock_context
    ):
        """Test handling when Exa returns empty content"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock response with empty text
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{"text": "", "title": "Empty Page"}],
            "statuses": [{"status": "success"}],
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = await exa_client.fetch_content("https://empty.com", mock_context)

        assert result == "Error: The webpage returned empty content."
        mock_context.error.assert_called_with(
            "Empty content returned for URL: https://empty.com"
        )


# =============================================================================
# PRIVACY PROTECTION TESTS
# =============================================================================


class TestExaClientPrivacy:
    """Tests specifically focused on privacy protection"""

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_no_user_identifying_headers_sent_content(
        self, mock_client_class, exa_client, mock_context
    ):
        """Verify that no user-identifying headers are sent to Exa API for content fetching"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{"text": "Sample content"}],
            "statuses": [{"status": "success"}],
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        await exa_client.fetch_content("https://example.com", mock_context)

        # Verify the request was made with only safe headers
        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args

        # Check that headers only contain API key and content type
        headers = call_args[1]["headers"]
        assert headers == {
            "x-api-key": "test_api_key",
            "Content-Type": "application/json",
        }

        # Verify no User-Agent, Accept, or other identifying headers
        forbidden_headers = [
            "user-agent",
            "accept",
            "accept-language",
            "accept-encoding",
            "host",
            "origin",
            "referer",
        ]
        for header in forbidden_headers:
            assert header.lower() not in {k.lower() for k in headers}

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_no_user_identifying_headers_sent_search(
        self, mock_client_class, exa_client, mock_context
    ):
        """Verify that no user-identifying headers are sent to Exa API for search"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [
                {"title": "Test", "url": "https://example.com", "text": "content"}
            ]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        await exa_client.search("test query", mock_context)

        # Verify the request was made with only safe headers
        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args

        # Check that headers only contain API key and content type
        headers = call_args[1]["headers"]
        assert headers == {
            "x-api-key": "test_api_key",
            "Content-Type": "application/json",
        }

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_only_url_sent_to_exa_api_content(
        self, mock_client_class, exa_client, mock_context
    ):
        """Verify that only the URL is sent to Exa API for content fetching, no other user data"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{"text": "Sample content"}],
            "statuses": [{"status": "success"}],
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        test_url = "https://example.com"
        await exa_client.fetch_content(test_url, mock_context)

        # Verify the request payload contains only the URL and safe parameters
        call_args = mock_client.post.call_args
        payload = call_args[1]["json"]

        # Check that payload only contains expected fields
        expected_payload = {
            "urls": [test_url],
            "text": {"maxCharacters": 8000, "includeHtmlTags": False},
        }
        assert payload == expected_payload

    @patch("backend.pro.exa.httpx.AsyncClient")
    async def test_only_exa_api_called_content(
        self, mock_client_class, exa_client, mock_context
    ):
        """Verify that only Exa API is called for content fetching, never the target URL directly"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{"text": "Content"}],
            "statuses": [{"status": "success"}],
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        test_url = "https://target-site.com"
        await exa_client.fetch_content(test_url, mock_context)

        # Verify only one HTTP call was made and it was to Exa API
        assert mock_client.post.call_count == 1
        call_args = mock_client.post.call_args

        # Verify the call went to Exa API, not the target URL
        assert call_args[0][0] == "https://api.exa.ai/contents"
        assert test_url not in str(
            call_args[0]
        )  # Target URL should not be in the endpoint

        # Verify the target URL is only in the payload, not the request URL
        payload = call_args[1]["json"]
        assert test_url in payload["urls"]


# =============================================================================
# INTEGRATION TESTS
# =============================================================================


class TestExaClientIntegration:
    """Integration tests for ExaClient with routes"""

    @pytest.mark.skipif(
        bool(os.getenv("EXA_API_KEY")),
        reason="EXA_API_KEY is set - skipping mock test to avoid interference with real API",
    )
    def test_search_endpoint_integration_mock(self, client):
        """Test that search endpoint integrates properly (mocked when no API key)"""
        response = client.post(
            "/pro/search-exa", json={"query": "test", "max_results": 5}
        )
        assert response.status_code == 200
        data = response.json()

        # When no API key, should get configuration error
        if not data["success"]:
            assert "not configured" in data["error"] or "EXA_API_KEY" in data["error"]

    @pytest.mark.skipif(
        bool(os.getenv("EXA_API_KEY")),
        reason="EXA_API_KEY is set - skipping mock test to avoid interference with real API",
    )
    def test_fetch_content_endpoint_integration_mock(self, client):
        """Test that fetch-content endpoint integrates properly (mocked when no API key)"""
        response = client.post(
            "/pro/fetch-content", json={"url": "https://example.com"}
        )
        assert response.status_code == 200
        data = response.json()

        # Should either succeed with fallback or return content
        assert "content" in data
        assert data["success"] is True  # Should succeed via WebContentFetcher fallback

    def test_fetch_content_endpoint_handles_bad_urls_gracefully(self, client):
        """Test that fetch-content endpoint handles invalid URLs gracefully"""
        response = client.post("/pro/fetch-content", json={"url": "not-a-url"})
        assert response.status_code == 200
        data = response.json()

        # Should handle gracefully - either succeed with fallback or return error message
        assert "content" in data or "error" in data
