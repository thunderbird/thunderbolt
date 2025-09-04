"""
Tests for ExaContentFetcher to verify privacy protection and functionality
"""

from unittest.mock import AsyncMock, Mock, patch

import pytest
from httpx import Response

from backend.pro.context import SimpleContext
from backend.pro.exa_content_fetcher import ExaContentFetcher


@pytest.fixture
def exa_fetcher():
    """Create an ExaContentFetcher instance with mock API key"""
    with patch("backend.pro.exa_content_fetcher.Settings") as mock_settings:
        mock_settings.return_value.exa_api_key = "test_api_key"
        return ExaContentFetcher()


@pytest.fixture
def mock_context():
    """Create a mock SimpleContext for testing"""
    ctx = Mock(spec=SimpleContext)
    ctx.info = AsyncMock()
    ctx.error = AsyncMock()
    return ctx


class TestExaContentFetcherPrivacy:
    """Tests specifically focused on privacy protection"""

    @patch("backend.pro.exa_content_fetcher.httpx.AsyncClient")
    async def test_no_user_identifying_headers_sent(self, mock_client_class, exa_fetcher, mock_context):
        """Verify that no user-identifying headers are sent to Exa API"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{"text": "Sample content"}],
            "statuses": [{"status": "success"}]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        await exa_fetcher.fetch_and_parse("https://example.com", mock_context)

        # Verify the request was made with only safe headers
        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args

        # Check that headers only contain API key and content type
        headers = call_args[1]["headers"]
        assert headers == {"x-api-key": "test_api_key", "Content-Type": "application/json"}

        # Verify no User-Agent, Accept, or other identifying headers
        forbidden_headers = ["user-agent", "accept", "accept-language", "accept-encoding", "host", "origin", "referer"]
        for header in forbidden_headers:
            assert header.lower() not in {k.lower() for k in headers}

    @patch("backend.pro.exa_content_fetcher.httpx.AsyncClient")
    async def test_only_url_sent_to_exa_api(self, mock_client_class, exa_fetcher, mock_context):
        """Verify that only the URL is sent to Exa API, no other user data"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{"text": "Sample content"}],
            "statuses": [{"status": "success"}]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        test_url = "https://example.com"
        await exa_fetcher.fetch_and_parse(test_url, mock_context)

        # Verify the request payload contains only the URL and safe parameters
        call_args = mock_client.post.call_args
        payload = call_args[1]["json"]

        # Check that payload only contains expected fields
        expected_payload = {
            "urls": [test_url],
            "text": {
                "maxCharacters": 8000,
                "includeHtmlTags": False
            }
        }
        assert payload == expected_payload

    @patch("backend.pro.exa_content_fetcher.httpx.AsyncClient")
    async def test_no_ip_address_forwarding(self, mock_client_class, exa_fetcher, mock_context):
        """Verify that no IP address information is forwarded"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{"text": "Sample content"}],
            "statuses": [{"status": "success"}]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        await exa_fetcher.fetch_and_parse("https://example.com", mock_context)

        # Verify the request goes only to Exa API, not to the target URL
        call_args = mock_client.post.call_args
        assert call_args[0][0] == "https://api.exa.ai/contents"

        # Verify no additional connection parameters that could leak IP
        assert "proxies" not in call_args[1]
        assert "headers" in call_args[1]
        headers = call_args[1]["headers"]

        # Ensure no X-Forwarded-For or similar headers
        proxy_headers = ["x-forwarded-for", "x-real-ip", "x-client-ip", "forwarded"]
        for header in proxy_headers:
            assert header.lower() not in {k.lower() for k in headers}


class TestExaContentFetcherFunctionality:
    """Tests for core functionality and error handling"""

    @patch("backend.pro.exa_content_fetcher.httpx.AsyncClient")
    async def test_successful_content_fetch(self, mock_client_class, exa_fetcher, mock_context):
        """Test successful content fetching and parsing"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful Exa response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{
                "text": "This is sample content from the webpage",
                "title": "Sample Page",
                "url": "https://example.com"
            }],
            "statuses": [{"status": "success"}]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = await exa_fetcher.fetch_and_parse("https://example.com", mock_context)

        assert result == "Content from https://example.com:\n\nThis is sample content from the webpage"
        mock_context.info.assert_any_call("Fetching content from: https://example.com")
        mock_context.info.assert_any_call("Successfully fetched and parsed content (39 characters)")

    @patch("backend.pro.exa_content_fetcher.httpx.AsyncClient")
    async def test_exa_error_handling_not_found(self, mock_client_class, exa_fetcher, mock_context):
        """Test handling of Exa CRAWL_NOT_FOUND error"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock Exa error response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [],
            "statuses": [{
                "status": "error",
                "error": {
                    "tag": "CRAWL_NOT_FOUND",
                    "httpStatusCode": 404
                }
            }]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = await exa_fetcher.fetch_and_parse("https://nonexistent.com", mock_context)

        assert result == "Error: The webpage could not be found or accessed."
        mock_context.error.assert_called_with("Content fetch failed for https://nonexistent.com: CRAWL_NOT_FOUND (HTTP 404)")

    @patch("backend.pro.exa_content_fetcher.httpx.AsyncClient")
    async def test_exa_error_handling_timeout(self, mock_client_class, exa_fetcher, mock_context):
        """Test handling of Exa CRAWL_TIMEOUT error"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock Exa timeout response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [],
            "statuses": [{
                "status": "error",
                "error": {
                    "tag": "CRAWL_TIMEOUT",
                    "httpStatusCode": 408
                }
            }]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = await exa_fetcher.fetch_and_parse("https://slow-site.com", mock_context)

        assert result == "Error: The request timed out while trying to fetch the webpage."
        mock_context.error.assert_called_with("Content fetch failed for https://slow-site.com: CRAWL_TIMEOUT (HTTP 408)")

    @patch("backend.pro.exa_content_fetcher.httpx.AsyncClient")
    async def test_api_key_authentication_error(self, mock_client_class, exa_fetcher, mock_context):
        """Test handling of API key authentication errors"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock 401 response
        from httpx import HTTPStatusError, Request

        mock_request = Mock(spec=Request)
        mock_response = Mock(spec=Response)
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"

        mock_client.post.side_effect = HTTPStatusError("401 Unauthorized", request=mock_request, response=mock_response)

        result = await exa_fetcher.fetch_and_parse("https://example.com", mock_context)

        assert result == "Error: Authentication failed with content fetch service."
        mock_context.error.assert_called_with("Invalid Exa API key")

    @patch("backend.pro.exa_content_fetcher.httpx.AsyncClient")
    async def test_empty_content_handling(self, mock_client_class, exa_fetcher, mock_context):
        """Test handling when Exa returns empty content"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock response with empty text
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{"text": "", "title": "Empty Page"}],
            "statuses": [{"status": "success"}]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = await exa_fetcher.fetch_and_parse("https://empty.com", mock_context)

        assert result == "Error: The webpage returned empty content."
        mock_context.error.assert_called_with("Empty content returned for URL: https://empty.com")


class TestExaContentFetcherNetworkIsolation:
    """Tests to verify network calls only go to Exa API"""

    @patch("backend.pro.exa_content_fetcher.httpx.AsyncClient")
    async def test_only_exa_api_called(self, mock_client_class, exa_fetcher, mock_context):
        """Verify that only Exa API is called, never the target URL directly"""
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__.return_value = mock_client

        # Mock successful response
        mock_response = Mock(spec=Response)
        mock_response.json.return_value = {
            "results": [{"text": "Content"}],
            "statuses": [{"status": "success"}]
        }
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        test_url = "https://target-site.com"
        await exa_fetcher.fetch_and_parse(test_url, mock_context)

        # Verify only one HTTP call was made and it was to Exa API
        assert mock_client.post.call_count == 1
        call_args = mock_client.post.call_args

        # Verify the call went to Exa API, not the target URL
        assert call_args[0][0] == "https://api.exa.ai/contents"
        assert test_url not in str(call_args[0])  # Target URL should not be in the endpoint

        # Verify the target URL is only in the payload, not the request URL
        payload = call_args[1]["json"]
        assert test_url in payload["urls"]

    async def test_no_direct_url_access_without_api_key(self):
        """Verify that without Exa API key, no direct URL access fallback occurs"""
        with patch("backend.pro.exa_content_fetcher.Settings") as mock_settings:
            mock_settings.return_value.exa_api_key = None

            with pytest.raises(ValueError, match="EXA_API_KEY must be set"):
                ExaContentFetcher()


class TestPrivacyComplianceIntegration:
    """Integration tests for the updated fetch-content endpoint"""

    @patch("backend.pro.routes.exa_content_fetcher")
    async def test_fetch_content_endpoint_uses_exa_proxy(self, mock_exa_fetcher):
        """Test that the fetch-content endpoint uses Exa proxy instead of direct fetching"""
        from fastapi.testclient import TestClient

        from backend.pro.routes import create_pro_tools_app

        # Mock the Exa content fetcher
        mock_exa_fetcher.fetch_and_parse = AsyncMock(return_value="Proxied content")

        app = create_pro_tools_app()
        client = TestClient(app)

        response = client.post("/fetch-content", json={"url": "https://example.com"})

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["content"] == "Proxied content"

        # Verify Exa content fetcher was called
        mock_exa_fetcher.fetch_and_parse.assert_called_once()

    @patch("backend.pro.routes.fetcher")
    async def test_fetch_content_endpoint_fallback_when_exa_unavailable(
        self, mock_web_fetcher
    ):
        """Test that endpoint falls back to WebContentFetcher when Exa API key is not configured"""
        with patch("backend.pro.routes.exa_content_fetcher", None):
            from fastapi.testclient import TestClient

            from backend.pro.routes import create_pro_tools_app

            # Mock the WebContentFetcher fallback
            mock_web_fetcher.fetch_and_parse = AsyncMock(
                return_value="Fallback content"
            )

            app = create_pro_tools_app()
            client = TestClient(app)

            response = client.post("/fetch-content", json={"url": "https://example.com"})

            assert response.status_code == 200
            data = response.json()
            assert data["success"] is True
            assert data["content"] == "Fallback content"

            # Verify fallback fetcher was called
            mock_web_fetcher.fetch_and_parse.assert_called_once()

    @patch("backend.pro.routes.fetcher")
    @patch("backend.pro.routes.exa_content_fetcher")
    async def test_fetch_content_endpoint_fallback_when_exa_fails(
        self, mock_exa_fetcher, mock_web_fetcher
    ):
        """Test that endpoint falls back to WebContentFetcher when Exa fails"""
        from fastapi.testclient import TestClient

        from backend.pro.routes import create_pro_tools_app

        # Mock Exa to fail, WebContentFetcher to succeed
        mock_exa_fetcher.fetch_and_parse = AsyncMock(
            side_effect=Exception("Exa service error")
        )
        mock_web_fetcher.fetch_and_parse = AsyncMock(
            return_value="Fallback after error"
        )

        app = create_pro_tools_app()
        client = TestClient(app)

        response = client.post("/fetch-content", json={"url": "https://example.com"})

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["content"] == "Fallback after error"

        # Verify both were called in order
        mock_exa_fetcher.fetch_and_parse.assert_called_once()
        mock_web_fetcher.fetch_and_parse.assert_called_once()
