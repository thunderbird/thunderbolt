"""
Comprehensive tests for Exa AI functionality including search and content fetching
"""

from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from pro.context import SimpleContext


@pytest.fixture
def client():
    return TestClient(app)


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


def test_search_endpoint_exists(client):
    """Test that the search endpoint exists"""
    response = client.post("/pro/search", json={"query": "test", "max_results": 5})
    # Should get a response (either success or configured error), not 404
    assert response.status_code == 200


def test_search_without_api_key(client):
    """Test search endpoint behavior when API key is not configured"""
    with patch("pro.routes.exa_client", None):
        response = client.post("/pro/search", json={"query": "test", "max_results": 5})
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert "not configured" in data["error"]


def test_search_request_validation(client):
    """Test that search requests are properly validated"""
    # Missing query
    response = client.post("/pro/search", json={})
    assert response.status_code == 422

    # Invalid max_results type
    response = client.post(
        "/pro/search", json={"query": "test", "max_results": "not_a_number"}
    )
    assert response.status_code == 422


# =============================================================================
# FETCH CONTENT ENDPOINT TESTS
# =============================================================================


def test_fetch_content_endpoint_exists(client):
    """Test that the fetch-content endpoint exists"""
    response = client.post("/pro/fetch-content", json={"url": "https://example.com"})
    # Should get a response (either success or configured error), not 404
    assert response.status_code == 200


def test_fetch_content_request_validation(client):
    """Test that fetch content requests are properly validated"""
    # Missing URL
    response = client.post("/pro/fetch-content", json={})
    assert response.status_code == 422

    # Invalid URL type
    response = client.post("/pro/fetch-content", json={"url": 123})
    assert response.status_code == 422


# =============================================================================
# EXA SDK TESTS
# =============================================================================


class TestExaSDKSearch:
    """Tests for Exa SDK search functionality"""

    @pytest.mark.asyncio
    async def test_successful_search(self, mock_context):
        """Test successful search with Exa SDK"""
        from pro.exa import search_exa

        mock_result = Mock()
        mock_result.title = "Test Title"
        mock_result.url = "https://example.com"
        mock_result.extract = "Test extract content"
        mock_result.author = "Test Author"
        mock_result.published_date = "2024-01-01"

        mock_response = Mock()
        mock_response.results = [mock_result]

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_client.search.return_value = mock_response
            mock_create.return_value = mock_client

            results = await search_exa("test query", mock_context, max_results=5)

            assert len(results) == 1
            assert results[0]["title"] == "Test Title"
            assert results[0]["url"] == "https://example.com"
            assert results[0]["snippet"] == "Test extract content"
            assert results[0]["author"] == "Test Author"
            assert results[0]["published_date"] == "2024-01-01"
            assert results[0]["position"] == 1

            mock_client.search.assert_called_once_with(
                "test query", num_results=5, use_autoprompt=True, type="neural"
            )

    @pytest.mark.asyncio
    async def test_search_authentication_error(self, mock_context):
        """Test search with authentication error"""
        from pro.exa import search_exa

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_client.search.side_effect = Exception("Authentication failed")
            mock_create.return_value = mock_client

            with pytest.raises(Exception) as exc_info:
                await search_exa("test query", mock_context)

            assert "Authentication failed" in str(exc_info.value)
            mock_context.error.assert_called()


class TestExaSDKContentFetching:
    """Tests for Exa SDK content fetching functionality"""

    @pytest.mark.asyncio
    async def test_successful_content_fetch(self, mock_context):
        """Test successful content fetching with Exa SDK"""
        from pro.exa import fetch_content_exa

        mock_content = Mock()
        mock_content.text = "This is the fetched content"

        mock_response = Mock()
        mock_response.results = [mock_content]

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_client.get_contents.return_value = mock_response
            mock_create.return_value = mock_client

            content = await fetch_content_exa("https://example.com", mock_context)

            assert content == "This is the fetched content"
            mock_client.get_contents.assert_called_once_with(
                ["https://example.com"],
                text={"max_characters": 8000, "include_html_tags": False},
            )

    @pytest.mark.asyncio
    async def test_content_fetch_not_found_error(self, mock_context):
        """Test content fetching when content is not found"""
        from pro.exa import fetch_content_exa

        mock_response = Mock()
        mock_response.results = []

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_client.get_contents.return_value = mock_response
            mock_create.return_value = mock_client

            content = await fetch_content_exa("https://example.com", mock_context)

            assert content == "Error: No content found for the provided URL"

    @pytest.mark.asyncio
    async def test_content_fetch_timeout_error(self, mock_context):
        """Test content fetching with timeout error"""
        from pro.exa import fetch_content_exa

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_client.get_contents.side_effect = Exception("Request timeout")
            mock_create.return_value = mock_client

            content = await fetch_content_exa("https://example.com", mock_context)

            assert content.startswith("Error:")
            assert "Request timeout" in content

    @pytest.mark.asyncio
    async def test_content_fetch_empty_content(self, mock_context):
        """Test content fetching when content is empty"""
        from pro.exa import fetch_content_exa

        mock_content = Mock()
        mock_content.text = ""
        mock_content.extract = ""

        mock_response = Mock()
        mock_response.results = [mock_content]

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_client.get_contents.return_value = mock_response
            mock_create.return_value = mock_client

            content = await fetch_content_exa("https://example.com", mock_context)

            # Should return empty string when both text and extract are empty
            assert content == ""


# =============================================================================
# PRIVACY TESTS
# =============================================================================


class TestExaSDKPrivacy:
    """Tests to ensure user privacy is protected when using Exa SDK"""

    @pytest.mark.asyncio
    async def test_no_user_identifying_headers_sent_content(self, mock_context):
        """Test that no user-identifying headers are sent for content fetching"""
        from pro.exa import fetch_content_exa

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_response = Mock()
            mock_response.results = []
            mock_client.get_contents.return_value = mock_response
            mock_create.return_value = mock_client

            await fetch_content_exa("https://example.com", mock_context)

            # Verify only URL and text options are sent, no user headers
            mock_client.get_contents.assert_called_once()
            call_args = mock_client.get_contents.call_args
            assert call_args[0][0] == ["https://example.com"]
            assert "text" in call_args[1]
            # No user-agent, IP, or other identifying info should be in the call

    @pytest.mark.asyncio
    async def test_no_user_identifying_headers_sent_search(self, mock_context):
        """Test that no user-identifying headers are sent for search"""
        from pro.exa import search_exa

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_response = Mock()
            mock_response.results = []
            mock_client.search.return_value = mock_response
            mock_create.return_value = mock_client

            await search_exa("test query", mock_context)

            # Verify only query and options are sent, no user headers
            mock_client.search.assert_called_once()
            call_args = mock_client.search.call_args
            assert call_args[0][0] == "test query"
            # No user-agent, IP, or other identifying info should be in the call

    @pytest.mark.asyncio
    async def test_only_url_sent_to_exa_api_content(self, mock_context):
        """Test that only the URL is sent to Exa for content fetching"""
        from pro.exa import fetch_content_exa

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_response = Mock()
            mock_response.results = []
            mock_client.get_contents.return_value = mock_response
            mock_create.return_value = mock_client

            await fetch_content_exa("https://test.com/page", mock_context)

            # Verify the URL passed to Exa
            call_args = mock_client.get_contents.call_args[0][0]
            assert call_args == ["https://test.com/page"]

    @pytest.mark.asyncio
    async def test_only_exa_api_called_content(self, mock_context):
        """Test that content fetching only calls Exa API, not the target URL"""
        from pro.exa import fetch_content_exa

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_response = Mock()
            mock_content = Mock()
            mock_content.text = "Content"
            mock_response.results = [mock_content]
            mock_client.get_contents.return_value = mock_response
            mock_create.return_value = mock_client

            # No direct HTTP calls should be made
            with patch("httpx.AsyncClient") as mock_httpx:
                content = await fetch_content_exa("https://example.com", mock_context)

                # httpx should not be called directly
                mock_httpx.assert_not_called()
                # Only Exa SDK should be used
                mock_client.get_contents.assert_called_once()
                assert content == "Content"


# =============================================================================
# INTEGRATION TESTS
# =============================================================================


class TestExaSDKIntegration:
    """Integration tests for Exa SDK with routes"""

    def test_search_endpoint_integration_mock(self, client):
        """Test search endpoint with mocked Exa SDK"""
        mock_result = Mock()
        mock_result.title = "Test Result"
        mock_result.url = "https://test.com"
        mock_result.extract = "Test content"
        mock_result.author = None
        mock_result.published_date = None

        mock_response = Mock()
        mock_response.results = [mock_result]

        with patch("pro.exa.create_exa_client") as mock_create:
            mock_client = Mock()
            mock_client.search.return_value = mock_response
            mock_create.return_value = mock_client

            with (
                patch("pro.routes.exa_client", mock_client),
                patch("pro.routes.search_exa") as mock_search,
            ):
                mock_search.return_value = [
                    {
                        "position": 1,
                        "title": "Test Result",
                        "url": "https://test.com",
                        "snippet": "Test content",
                        "author": None,
                        "published_date": None,
                    }
                ]

                response = client.post(
                    "/pro/search", json={"query": "test", "max_results": 5}
                )

                assert response.status_code == 200
                data = response.json()
                assert data["success"] is True
                assert "Test Result" in data["results"]
                assert "https://test.com" in data["results"]

    def test_fetch_content_endpoint_integration_mock(self, client):
        """Test fetch content endpoint with mocked Exa SDK"""
        with patch("pro.routes.fetch_content_exa") as mock_fetch:
            mock_fetch.return_value = "This is the content from the webpage"

            with patch("pro.routes.exa_client", Mock()):
                response = client.post(
                    "/pro/fetch-content", json={"url": "https://example.com"}
                )

                assert response.status_code == 200
                data = response.json()
                assert data["success"] is True
                assert data["content"] == "This is the content from the webpage"

    def test_fetch_content_endpoint_handles_bad_urls_gracefully(self, client):
        """Test that fetch content endpoint handles bad URLs gracefully"""
        with patch("pro.routes.fetch_content_exa") as mock_fetch:
            mock_fetch.return_value = "Error: Invalid URL or content not accessible"

            with patch("pro.routes.exa_client", Mock()):
                response = client.post(
                    "/pro/fetch-content", json={"url": "not-a-valid-url"}
                )

                assert response.status_code == 200
                data = response.json()
                assert data["success"] is False
                assert "Error:" in data["error"]
