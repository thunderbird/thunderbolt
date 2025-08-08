"""Tests for proxy functionality."""

import gzip
import json
from unittest.mock import AsyncMock, MagicMock, patch

import brotli
import httpx
import pytest
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from proxy import ProxyConfig, ProxyService


@pytest.mark.asyncio
async def test_proxy_handles_httpx_auto_decompression() -> None:
    """Test that proxy correctly handles when httpx automatically decompresses brotli content."""
    # Create a proxy service
    proxy_service = ProxyService()
    proxy_service.register_proxy(
        "/test/api",
        ProxyConfig(
            target_url="https://api.example.com",
            api_key="test-key",
            require_auth=False,
        ),
    )

    # Mock the httpx response
    mock_response = MagicMock(spec=httpx.Response)

    # Simulate httpx returning decompressed JSON content but with br encoding header still present
    json_content = {"test": "data", "value": 123}
    json_bytes = json.dumps(json_content).encode("utf-8")

    # Headers indicate brotli compression, but content is already decompressed
    mock_response.headers = {
        "content-type": "application/json",
        "content-encoding": "br",
    }
    mock_response.status_code = 200
    mock_response.read.return_value = json_bytes  # Already decompressed content
    mock_response.content = json_bytes

    # Mock the request
    mock_request = MagicMock()
    mock_request.method = "GET"
    mock_request.headers = {"accept": "application/json"}
    mock_request.url.query = None
    mock_request.body = AsyncMock(return_value=b"")

    # Mock the httpx client request
    with patch.object(
        proxy_service.client, "request", return_value=mock_response
    ) as mock_client_request:
        mock_client_request.return_value = mock_response

        # Call proxy_request
        response = await proxy_service.proxy_request(
            mock_request, "test", proxy_service.configs["/test/api"]
        )

        # Verify the response
        assert response.status_code == 200

        # Content should be the JSON data (not compressed)
        response_data = json.loads(response.body)
        assert response_data == json_content

        # Content-encoding header should be removed
        assert "content-encoding" not in response.headers


@pytest.mark.asyncio
async def test_proxy_handles_actual_brotli_compression() -> None:
    """Test that proxy correctly decompresses actual brotli-compressed content."""
    # Create a proxy service
    proxy_service = ProxyService()
    proxy_service.register_proxy(
        "/test/api",
        ProxyConfig(
            target_url="https://api.example.com",
            api_key="test-key",
            require_auth=False,
        ),
    )

    # Mock the httpx response with actual brotli-compressed content
    mock_response = MagicMock(spec=httpx.Response)

    # Create actual brotli-compressed content
    json_content = {"test": "compressed data", "value": 456}
    json_bytes = json.dumps(json_content).encode("utf-8")
    compressed_content = brotli.compress(json_bytes)

    # Headers indicate brotli compression
    mock_response.headers = {
        "content-type": "application/json",
        "content-encoding": "br",
    }
    mock_response.status_code = 200
    mock_response.read.return_value = compressed_content  # Actually compressed
    mock_response.content = compressed_content

    # Mock the request
    mock_request = MagicMock()
    mock_request.method = "GET"
    mock_request.headers = {"accept": "application/json"}
    mock_request.url.query = None
    mock_request.body = AsyncMock(return_value=b"")

    # Mock the httpx client request
    with patch.object(
        proxy_service.client, "request", return_value=mock_response
    ) as mock_client_request:
        mock_client_request.return_value = mock_response

        # Call proxy_request
        response = await proxy_service.proxy_request(
            mock_request, "test", proxy_service.configs["/test/api"]
        )

        # Verify the response
        assert response.status_code == 200

        # Content should be decompressed JSON
        response_data = json.loads(response.body)
        assert response_data == json_content

        # Content-encoding header should be removed
        assert "content-encoding" not in response.headers


@pytest.mark.asyncio
async def test_proxy_handles_gzip_compression() -> None:
    """Test that proxy correctly handles gzip compression."""
    # Create a proxy service
    proxy_service = ProxyService()
    proxy_service.register_proxy(
        "/test/api",
        ProxyConfig(
            target_url="https://api.example.com",
            api_key="test-key",
            require_auth=False,
        ),
    )

    # Mock the httpx response with gzip-compressed content
    mock_response = MagicMock(spec=httpx.Response)

    # Create gzip-compressed content
    json_content = {"test": "gzip data", "value": 789}
    json_bytes = json.dumps(json_content).encode("utf-8")
    compressed_content = gzip.compress(json_bytes)

    # Headers indicate gzip compression
    mock_response.headers = {
        "content-type": "application/json",
        "content-encoding": "gzip",
    }
    mock_response.status_code = 200
    mock_response.read.return_value = compressed_content
    mock_response.content = compressed_content

    # Mock the request
    mock_request = MagicMock()
    mock_request.method = "GET"
    mock_request.headers = {"accept": "application/json"}
    mock_request.url.query = None
    mock_request.body = AsyncMock(return_value=b"")

    # Mock the httpx client request
    with patch.object(
        proxy_service.client, "request", return_value=mock_response
    ) as mock_client_request:
        mock_client_request.return_value = mock_response

        # Call proxy_request
        response = await proxy_service.proxy_request(
            mock_request, "test", proxy_service.configs["/test/api"]
        )

        # Verify the response
        assert response.status_code == 200

        # Content should be decompressed JSON
        response_data = json.loads(response.body)
        assert response_data == json_content

        # Content-encoding header should be removed
        assert "content-encoding" not in response.headers


def test_proxy_auth_required(client: TestClient) -> None:
    """Test that proxy requires authentication when configured."""
    # When weather proxy is not configured, we should get 404
    response = client.get("/proxy/weather/current.json?q=London")
    # If weather proxy is not configured (no WEATHER_API_KEY in test env), expect 404
    # If it is configured, expect 401 due to missing auth
    assert response.status_code in [401, 404]
    if response.status_code == 401:
        assert response.json()["detail"] == "Unauthorized"
    else:
        assert response.json()["detail"] == "Proxy path not configured"


def test_proxy_with_auth(client: TestClient) -> None:
    """Test proxy with proper authentication."""
    # This would need proper mocking of the weather API response
    # For now, just test that auth header is accepted
    headers = {"Authorization": "Bearer test-token"}
    with patch("proxy.ProxyService.proxy_request") as mock_proxy:
        mock_proxy.return_value = MagicMock(
            status_code=200,
            body=b'{"test": "data"}',
            headers={},
        )
        response = client.get("/proxy/weather/current.json?q=London", headers=headers)
        # Should not return 401 if auth is provided
        assert response.status_code != 401


@pytest.mark.asyncio
async def test_proxy_passthrough_basic() -> None:
    """Test basic proxy_passthrough functionality."""
    proxy_service = ProxyService()
    config = ProxyConfig(
        target_url="https://api.example.com",
        api_key="test-key",
        require_auth=False,
    )

    # Mock the request
    mock_request = MagicMock()
    mock_request.method = "POST"
    mock_request.headers = {"content-type": "application/json"}
    mock_request.url.query = "param=value"
    mock_request.body = AsyncMock(return_value=b'{"test": "data"}')

    # Mock the upstream response
    mock_upstream = MagicMock()
    mock_upstream.status_code = 200
    mock_upstream.headers = {
        "content-type": "application/json",
        "x-custom-header": "value",
        "transfer-encoding": "chunked",  # Should be removed
        "connection": "keep-alive",  # Should be removed
    }

    async def mock_aiter_raw():
        yield b'{"result": '
        yield b'"success"}'

    mock_upstream.aiter_raw = mock_aiter_raw
    mock_upstream.aclose = AsyncMock()

    # Mock the client build_request and send
    mock_req = MagicMock()
    with (
        patch.object(proxy_service.client, "build_request", return_value=mock_req),
        patch.object(proxy_service.client, "send", return_value=mock_upstream),
    ):
        response = await proxy_service.proxy_passthrough(
            mock_request, "test/path", config
        )

        # Verify response type
        assert isinstance(response, StreamingResponse)
        assert response.status_code == 200
        assert response.media_type == "application/json"

        # Verify hop-by-hop headers are removed
        assert "transfer-encoding" not in response.headers
        assert "connection" not in response.headers

        # Verify custom headers are preserved
        assert response.headers.get("x-custom-header") == "value"

        # Verify content-length is removed for streaming
        assert "content-length" not in response.headers

        # Consume the response to ensure cleanup happens
        content = b""
        async for chunk in response.body_iterator:
            content += chunk

        # Verify content was streamed correctly
        assert content == b'{"result": "success"}'

        # Verify upstream is closed after consumption
        mock_upstream.aclose.assert_called_once()


@pytest.mark.asyncio
async def test_proxy_passthrough_with_query_params() -> None:
    """Test proxy_passthrough preserves query parameters."""
    proxy_service = ProxyService()
    config = ProxyConfig(
        target_url="https://api.example.com",
        api_key="test-key",
        require_auth=False,
    )

    # Mock the request with query params
    mock_request = MagicMock()
    mock_request.method = "GET"
    mock_request.headers = {}
    mock_request.url.query = "search=test&limit=10"
    mock_request.body = AsyncMock(return_value=b"")

    # Mock upstream response
    mock_upstream = MagicMock()
    mock_upstream.status_code = 200
    mock_upstream.headers = {"content-type": "application/json"}
    mock_upstream.aiter_raw = AsyncMock(return_value=[b'{"data": "test"}'])
    mock_upstream.aclose = AsyncMock()

    mock_req = MagicMock()
    with (
        patch.object(
            proxy_service.client, "build_request", return_value=mock_req
        ) as mock_build,
        patch.object(proxy_service.client, "send", return_value=mock_upstream),
    ):
        await proxy_service.proxy_passthrough(mock_request, "search", config)

        # Verify the request was built with the correct URL including query params
        mock_build.assert_called_once()
        args, kwargs = mock_build.call_args
        assert kwargs["url"] == "https://api.example.com/search?search=test&limit=10"


@pytest.mark.asyncio
async def test_proxy_passthrough_removes_hop_by_hop_headers() -> None:
    """Test that proxy_passthrough removes all hop-by-hop headers."""
    proxy_service = ProxyService()
    config = ProxyConfig(target_url="https://api.example.com", api_key="")

    mock_request = MagicMock()
    mock_request.method = "GET"
    mock_request.headers = {}
    mock_request.url.query = None
    mock_request.body = AsyncMock(return_value=b"")

    # Include all hop-by-hop headers that should be removed
    hop_by_hop_headers = {
        "transfer-encoding": "chunked",
        "connection": "keep-alive",
        "keep-alive": "timeout=5",
        "proxy-authenticate": "Basic",
        "proxy-authorization": "Bearer token",
        "te": "trailers",
        "trailers": "X-Custom",
        "upgrade": "websocket",
        "content-type": "application/json",  # Should be preserved
        "x-custom": "value",  # Should be preserved
    }

    mock_upstream = MagicMock()
    mock_upstream.status_code = 200
    mock_upstream.headers = hop_by_hop_headers
    mock_upstream.aiter_raw = AsyncMock(return_value=[b"{}"])
    mock_upstream.aclose = AsyncMock()

    mock_req = MagicMock()
    with (
        patch.object(proxy_service.client, "build_request", return_value=mock_req),
        patch.object(proxy_service.client, "send", return_value=mock_upstream),
    ):
        response = await proxy_service.proxy_passthrough(mock_request, "test", config)

        # Verify hop-by-hop headers are removed
        assert "transfer-encoding" not in response.headers
        assert "connection" not in response.headers
        assert "keep-alive" not in response.headers
        assert "proxy-authenticate" not in response.headers
        assert "proxy-authorization" not in response.headers
        assert "te" not in response.headers
        assert "trailers" not in response.headers
        assert "upgrade" not in response.headers

        # Verify other headers are preserved
        assert response.headers.get("content-type") == "application/json"
        assert response.headers.get("x-custom") == "value"


@pytest.mark.asyncio
async def test_proxy_passthrough_streaming_body() -> None:
    """Test that proxy_passthrough properly streams the response body."""
    proxy_service = ProxyService()
    config = ProxyConfig(target_url="https://api.example.com", api_key="")

    mock_request = MagicMock()
    mock_request.method = "POST"
    mock_request.headers = {}
    mock_request.url.query = None
    mock_request.body = AsyncMock(return_value=b'{"input": "test"}')

    # Mock streaming response chunks
    response_chunks = [
        b'data: {"chunk": 1}\n\n',
        b'data: {"chunk": 2}\n\n',
        b"data: [DONE]\n\n",
    ]

    async def mock_aiter_raw():
        for chunk in response_chunks:
            yield chunk

    mock_upstream = MagicMock()
    mock_upstream.status_code = 200
    mock_upstream.headers = {"content-type": "text/event-stream"}
    mock_upstream.aiter_raw = mock_aiter_raw
    mock_upstream.aclose = AsyncMock()

    mock_req = MagicMock()
    with (
        patch.object(proxy_service.client, "build_request", return_value=mock_req),
        patch.object(proxy_service.client, "send", return_value=mock_upstream),
    ):
        response = await proxy_service.proxy_passthrough(mock_request, "stream", config)

        # Collect streamed content
        collected_chunks = []
        async for chunk in response.body_iterator:
            collected_chunks.append(chunk)

        # Verify all chunks were streamed correctly
        assert collected_chunks == response_chunks
        assert response.media_type == "text/event-stream"


@pytest.mark.asyncio
async def test_proxy_passthrough_with_api_key_header() -> None:
    """Test that proxy_passthrough correctly adds API key headers."""
    proxy_service = ProxyService()
    config = ProxyConfig(
        target_url="https://api.example.com",
        api_key="test-api-key",
        api_key_header="X-API-Key",
    )

    mock_request = MagicMock()
    mock_request.method = "GET"
    mock_request.headers = {"user-agent": "test-client"}
    mock_request.url.query = None
    mock_request.body = AsyncMock(return_value=b"")

    mock_upstream = MagicMock()
    mock_upstream.status_code = 200
    mock_upstream.headers = {"content-type": "application/json"}
    mock_upstream.aiter_raw = AsyncMock(return_value=[b"{}"])
    mock_upstream.aclose = AsyncMock()

    mock_req = MagicMock()
    with (
        patch.object(
            proxy_service.client, "build_request", return_value=mock_req
        ) as mock_build,
        patch.object(proxy_service.client, "send", return_value=mock_upstream),
    ):
        await proxy_service.proxy_passthrough(mock_request, "test", config)

        # Verify headers include API key
        mock_build.assert_called_once()
        headers = mock_build.call_args[1]["headers"]
        assert headers["X-API-Key"] == "test-api-key"
        assert headers["user-agent"] == "test-client"


@pytest.mark.asyncio
async def test_ai_service_detection() -> None:
    """Test that AI services are correctly detected."""
    proxy_service = ProxyService()

    # Test AI service detection
    ai_configs = [
        ProxyConfig(target_url="https://api.openai.com", api_key=""),
        ProxyConfig(target_url="https://flower.ai", api_key=""),
        ProxyConfig(target_url="https://api.anthropic.com", api_key=""),
        ProxyConfig(target_url="https://fireworks.ai", api_key=""),
    ]

    for config in ai_configs:
        assert proxy_service._is_ai_service(config), (
            f"Should detect {config.target_url} as AI service"
        )

    # Test non-AI service detection
    non_ai_configs = [
        ProxyConfig(target_url="https://api.weather.com", api_key=""),
        ProxyConfig(target_url="https://jsonplaceholder.typicode.com", api_key=""),
        ProxyConfig(target_url="https://httpbin.org", api_key=""),
    ]

    for config in non_ai_configs:
        assert not proxy_service._is_ai_service(config), (
            f"Should not detect {config.target_url} as AI service"
        )


@pytest.mark.asyncio
async def test_ai_service_streaming_uses_passthrough() -> None:
    """Test that AI services with streaming automatically use passthrough."""
    proxy_service = ProxyService()

    # Mock an AI service config
    config = ProxyConfig(
        target_url="https://api.openai.com",
        api_key="test-key",
        supports_streaming=True,
    )

    # Mock a streaming request
    mock_request = MagicMock()
    mock_request.method = "POST"
    mock_request.headers = {"content-type": "application/json"}
    mock_request.url.query = None
    mock_request.body = AsyncMock(
        return_value=b'{"model": "gpt-4", "stream": true, "messages": []}'
    )

    # Mock the passthrough method to verify it's called
    with (
        patch.object(proxy_service, "proxy_passthrough") as mock_passthrough,
        patch.object(proxy_service, "proxy_streaming_request") as mock_streaming,
    ):
        mock_passthrough.return_value = MagicMock()

        await proxy_service.proxy_request(mock_request, "chat/completions", config)

        # Verify passthrough was called for AI service
        mock_passthrough.assert_called_once_with(
            mock_request, "chat/completions", config
        )
        # Verify the old streaming method was NOT called
        mock_streaming.assert_not_called()


@pytest.mark.asyncio
async def test_non_ai_service_streaming_uses_streaming_request() -> None:
    """Test that non-AI services with streaming use the original streaming method."""
    proxy_service = ProxyService()

    # Mock a non-AI service config
    config = ProxyConfig(
        target_url="https://api.weather.com",
        api_key="test-key",
        supports_streaming=True,
    )

    # Mock a streaming request
    mock_request = MagicMock()
    mock_request.method = "POST"
    mock_request.headers = {
        "content-type": "application/json",
        "accept": "text/event-stream",
    }
    mock_request.url.query = None
    mock_request.body = AsyncMock(return_value=b'{"query": "weather"}')

    # Mock the streaming methods
    with (
        patch.object(proxy_service, "proxy_passthrough") as mock_passthrough,
        patch.object(proxy_service, "proxy_streaming_request") as mock_streaming,
    ):
        mock_streaming.return_value = MagicMock()

        await proxy_service.proxy_request(mock_request, "events", config)

        # Verify the original streaming method was called for non-AI service
        mock_streaming.assert_called_once_with(
            mock_request, "events", config, b'{"query": "weather"}'
        )
        # Verify passthrough was NOT called
        mock_passthrough.assert_not_called()


@pytest.mark.asyncio
async def test_proxy_passthrough_applies_request_transformer() -> None:
    """Test that proxy_passthrough applies request transformers."""
    proxy_service = ProxyService()
    
    # Mock transformer that adds prefix to model name
    def mock_transformer(body: bytes) -> bytes:
        import json
        data = json.loads(body.decode("utf-8"))
        if "model" in data:
            data["model"] = f"accounts/test/models/{data['model']}"
        return json.dumps(data).encode("utf-8")
    
    config = ProxyConfig(
        target_url="https://api.test.com",
        api_key="test-key",
        request_transformer=mock_transformer,
    )

    mock_request = MagicMock()
    mock_request.method = "POST"
    mock_request.headers = {"content-type": "application/json"}
    mock_request.url.query = None
    mock_request.body = AsyncMock(return_value=b'{"model": "test-model", "messages": []}')

    mock_upstream = MagicMock()
    mock_upstream.status_code = 200
    mock_upstream.headers = {"content-type": "application/json"}
    mock_upstream.aiter_raw = AsyncMock(return_value=[b'{"result": "success"}'])
    mock_upstream.aclose = AsyncMock()

    mock_req = MagicMock()
    with patch.object(proxy_service.client, "build_request", return_value=mock_req) as mock_build, \
         patch.object(proxy_service.client, "send", return_value=mock_upstream):
        
        await proxy_service.proxy_passthrough(mock_request, "chat/completions", config)
        
        # Verify the request was built with transformed body
        mock_build.assert_called_once()
        sent_body = mock_build.call_args[1]["content"]
        
        # Parse the sent body to verify transformation
        import json
        sent_data = json.loads(sent_body.decode("utf-8"))
        assert sent_data["model"] == "accounts/test/models/test-model"
        assert sent_data["messages"] == []
