import contextlib
import gzip
import logging
import zlib
from collections.abc import Callable
from typing import Any, cast
from urllib.parse import parse_qs, urlencode

import httpx
from fastapi import HTTPException, Request, Response
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

# Try to import brotli for decompression support
try:
    import brotli

    HAS_BROTLI = True
except ImportError:
    HAS_BROTLI = False
    logger.warning(
        "Brotli module not available - brotli decompression will not be supported"
    )


class ProxyConfig:
    """Configuration for a specific proxy endpoint"""

    def __init__(
        self,
        target_url: str,
        api_key: str,
        api_key_header: str = "Authorization",
        api_key_as_query_param: bool = False,
        api_key_query_param_name: str = "key",
        strip_headers: set[str] | None = None,
        strip_query_params: set[str] | None = None,
        require_auth: bool = True,
        supports_streaming: bool = False,
        request_transformer: Callable[[bytes], bytes] | None = None,
    ):
        self.target_url = target_url.rstrip("/")
        self.api_key = api_key
        self.api_key_header = api_key_header
        self.api_key_as_query_param = api_key_as_query_param
        self.api_key_query_param_name = api_key_query_param_name
        self.strip_headers = strip_headers or set()
        self.strip_query_params = strip_query_params or set()
        self.require_auth = require_auth
        self.supports_streaming = supports_streaming
        self.request_transformer = request_transformer


class ProxyService:
    """Service to handle proxying requests to external APIs"""

    def __init__(self) -> None:
        # Try to enable HTTP/2 if available
        http2_available = False
        try:
            import h2  # noqa: F401

            http2_available = True
        except ImportError:
            logger.debug(
                "HTTP/2 not available (install httpx[http2] for HTTP/2 support)"
            )

        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=5.0),
            follow_redirects=True,
            limits=httpx.Limits(
                max_keepalive_connections=20,  # Increased for better connection reuse
                max_connections=100,  # Support more concurrent requests
            ),
            http2=http2_available,  # Enable HTTP/2 if available
        )
        self.configs: dict[str, ProxyConfig] = {}

    def register_proxy(self, path_prefix: str, config: ProxyConfig) -> None:
        """Register a new proxy configuration for a path prefix"""
        self.configs[path_prefix] = config

    def get_config(self, path: str) -> ProxyConfig | None:
        """Get the proxy configuration for a given path"""
        for prefix, config in self.configs.items():
            if path.startswith(prefix):
                return config
        return None

    async def verify_auth(self, request: Request) -> bool:
        """Verify the request has proper authentication"""
        # Implement your auth logic here
        # For now, just check if Authorization header exists
        return "authorization" in request.headers

    def _is_ai_service(self, config: ProxyConfig) -> bool:
        """Check if the target URL is an AI service that benefits from passthrough."""
        ai_service_indicators = [
            "flower",
            "openai",
            "anthropic",
            "cohere",
            "huggingface",
            "replicate",
            "fireworks",
        ]
        target_url_lower = config.target_url.lower()
        return any(indicator in target_url_lower for indicator in ai_service_indicators)

    def prepare_headers(self, request: Request, config: ProxyConfig) -> dict[str, str]:
        """Prepare headers for the proxied request"""
        headers = {}

        # Copy headers except the ones we want to strip
        for key, value in request.headers.items():
            if key.lower() not in config.strip_headers:
                headers[key] = value

        # Add API key as header if configured and not using query param mode
        # Only override if api_key is not empty
        if config.api_key and not config.api_key_as_query_param:
            # Special handling for Authorization header - add Bearer prefix if needed
            if (
                config.api_key_header.lower() == "authorization"
                and not config.api_key.startswith("Bearer ")
            ):
                headers[config.api_key_header] = f"Bearer {config.api_key}"
            else:
                headers[config.api_key_header] = config.api_key

        # Add SDK headers for Flower AI
        if "flower" in str(config.target_url).lower():
            # Add Flower SDK specific headers
            headers["X-Flower-SDK-Version"] = "0.1.8"
            headers["X-Flower-SDK-Language"] = "TS"
            headers["User-Agent"] = "Flower-Intelligence-SDK/0.1.8 (TS)"

        # Remove host header as it will be set by httpx
        headers.pop("host", None)

        # Remove content-length header as it will be recalculated by httpx
        # This is crucial when request transformer modifies the body
        headers.pop("content-length", None)

        return headers

    def _process_query_params(
        self, request: Request, config: ProxyConfig
    ) -> dict[str, Any]:
        """Process and clean query parameters"""
        query_params: dict[str, Any] = {}
        if request.url.query:
            parsed_params = parse_qs(str(request.url.query), keep_blank_values=True)
            # Convert lists to single values for simplicity
            for k, v in parsed_params.items():
                if isinstance(v, list) and len(v) == 1:
                    query_params[k] = v[0]
                else:
                    query_params[k] = v

            # Remove any query parameters that should be stripped
            for param in config.strip_query_params:
                query_params.pop(param, None)

        # Add API key as query parameter if configured
        if config.api_key and config.api_key_as_query_param:
            query_params[config.api_key_query_param_name] = config.api_key

        return query_params

    async def proxy_request(
        self, request: Request, path: str, config: ProxyConfig
    ) -> Response | StreamingResponse:
        """Unified proxy that handles both streaming and buffered requests."""

        # Check if we need transformation first (to decide if we need to buffer)
        needs_transformation = config.request_transformer is not None

        # Read body only if we need to transform or inspect it
        body = await request.body()

        # Apply request transformer if configured (for Fireworks model prefixes, etc.)
        if needs_transformation and body:
            transformer = cast(Callable[[bytes], bytes], config.request_transformer)
            try:
                body = transformer(body)
            except Exception as e:
                logger.error(f"Request transformation failed: {e}")
                raise HTTPException(
                    status_code=400, detail="Invalid request format"
                ) from e

        # Check if this is a streaming request
        is_streaming = False
        if config.supports_streaming:
            # Check for streaming indicators
            content_type = request.headers.get("content-type", "")
            accept = request.headers.get("accept", "")

            # Parse request body to check for stream parameter
            if request.method == "POST" and "application/json" in content_type and body:
                try:
                    import json

                    body_json = json.loads(body)
                    is_streaming = body_json.get("stream", False)
                except Exception:
                    pass

            # Also check accept header
            if "text/event-stream" in accept:
                is_streaming = True

        # Use streaming approach if needed
        if is_streaming:
            return await self._proxy_streaming(request, path, config, body)

        # Otherwise use buffered approach for full response processing
        return await self._proxy_buffered(request, path, config, body)

    async def _proxy_streaming(
        self, request: Request, path: str, config: ProxyConfig, body: bytes
    ) -> StreamingResponse:
        """Handle streaming proxy requests without buffering the response."""
        # Build target URL
        target_url = f"{config.target_url}/{path}"

        # Handle query parameters
        if request.url.query:
            query_string = str(request.url.query)
            if query_string:
                target_url = f"{target_url}?{query_string}"

        # Prepare headers
        headers = self.prepare_headers(request, config)

        # Build and send the request
        req = self.client.build_request(
            method=request.method,
            url=target_url,
            headers=headers,
            content=body,
        )
        upstream = await self.client.send(req, stream=True, follow_redirects=False)

        # Clean response headers - remove hop-by-hop headers and problematic CORS headers
        hop_by_hop = {
            "transfer-encoding",
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailers",
            "upgrade",
            "content-length",
            "cross-origin-resource-policy",  # Remove problematic CORS header
            "cross-origin-embedder-policy",  # Remove problematic CORS header
            "cross-origin-opener-policy",  # Also remove COOP header
        }
        upstream_headers = {
            k: v for k, v in upstream.headers.items() if k.lower() not in hop_by_hop
        }

        media_type = upstream_headers.get("content-type")

        async def body_iter():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(
            body_iter(),
            status_code=upstream.status_code,
            media_type=media_type,
            headers=upstream_headers,
        )

    async def _proxy_buffered(
        self, request: Request, path: str, config: ProxyConfig, body: bytes
    ) -> Response:
        """Handle buffered proxy requests with full response processing."""
        # Build target URL
        target_url = f"{config.target_url}/{path}"

        # Handle query parameters
        if request.url.query or (config.api_key and config.api_key_as_query_param):
            query_params = self._process_query_params(request, config)
            # Build query string
            query_string = urlencode(query_params, doseq=True)
            if query_string:
                target_url = f"{target_url}?{query_string}"

        # Prepare headers
        headers = self.prepare_headers(request, config)

        try:
            # Make the proxied request
            response = await self.client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
                follow_redirects=False,
            )

            # Create response headers and remove problematic CORS headers immediately
            response_headers = dict(response.headers)

            # Remove problematic CORS headers (case-insensitive)
            problematic_headers = [
                "cross-origin-resource-policy",
                "cross-origin-embedder-policy",
                "cross-origin-opener-policy",
            ]
            headers_to_remove = []
            for key in response_headers:
                if key.lower() in problematic_headers:
                    headers_to_remove.append(key)

            for key in headers_to_remove:
                del response_headers[key]

            # Check for compression
            content_encoding = response_headers.get("content-encoding", "").lower()

            # Get response content
            content = response.read()

            # Check if decompression is needed based on content-encoding header
            # httpx may automatically decompress but not remove the content-encoding header
            if isinstance(content, bytes | bytearray) and content_encoding:
                try:
                    if content_encoding in ["br", "brotli"]:
                        if HAS_BROTLI:
                            # Try to decompress - if it fails, content was already decompressed
                            with contextlib.suppress(brotli.error):
                                content = brotli.decompress(content)
                        else:
                            raise HTTPException(
                                status_code=500,
                                detail="Server configuration error: brotli support not available",
                            )
                    elif content_encoding == "gzip":
                        with contextlib.suppress(gzip.BadGzipFile):
                            content = gzip.decompress(content)
                    elif content_encoding == "deflate":
                        with contextlib.suppress(zlib.error):
                            content = zlib.decompress(content)
                except HTTPException:
                    # Re-raise HTTP exceptions (like missing brotli support)
                    raise
                except Exception as e:
                    # For any other unexpected errors, log and raise
                    logger.error(f"Unexpected error during decompression: {e}")
                    raise HTTPException(
                        status_code=500,
                        detail=f"Error processing response: {str(e)}",
                    ) from e

            # Remove compression-related headers since content is now uncompressed
            response_headers.pop("content-encoding", None)
            response_headers.pop("transfer-encoding", None)
            response_headers.pop("vary", None)

            # Detect and handle content type
            content_type = response_headers.get(
                "content-type", "application/octet-stream"
            )

            # Special handling for JSON responses
            if "application/json" in content_type.lower():
                try:
                    # For JSON responses, make sure it's properly formatted
                    import json

                    # Try to decode as UTF-8 first (most common)
                    try:
                        json_str = content.decode("utf-8")
                    except UnicodeDecodeError:
                        # If that fails, try other common encodings
                        for encoding in ["latin1", "iso-8859-1", "windows-1252"]:
                            try:
                                json_str = content.decode(encoding)
                                break
                            except UnicodeDecodeError:
                                continue
                        else:
                            # If all decoding attempts fail, use latin1 as a fallback
                            json_str = content.decode("latin1", errors="replace")

                    # Try to parse the JSON and re-encode it properly
                    parsed_json = json.loads(json_str)
                    content = json.dumps(parsed_json).encode("utf-8")

                    # Set proper content type with charset
                    content_type = "application/json; charset=utf-8"
                    response_headers["content-type"] = content_type

                except Exception as e:
                    # Log the error but continue with original content
                    logger.error(f"Error processing JSON content: {e}")

            # Set the correct content length
            response_headers["content-length"] = str(len(content))

            # For 500 errors from Fireworks, return a user-friendly error
            if response.status_code == 500 and "fireworks" in target_url:
                try:
                    error_json = json.loads(content.decode("utf-8"))
                    if (
                        error_json.get("error", {}).get("code")
                        == "INTERNAL_SERVER_ERROR"
                    ):
                        # Return a 503 Service Unavailable instead
                        error_response = {
                            "error": {
                                "code": "SERVICE_UNAVAILABLE",
                                "message": "AI service is temporarily offline. Please try again later.",
                                "type": "service_error",
                            }
                        }
                        content = json.dumps(error_response).encode("utf-8")
                        response_headers["content-length"] = str(len(content))
                        response.status_code = 503
                except Exception:
                    pass

            return Response(
                content=content,
                status_code=response.status_code,
                headers=response_headers,
            )

        except httpx.TimeoutException as e:
            raise HTTPException(status_code=504, detail="Gateway timeout") from e
        except httpx.RequestError as e:
            logger.error(f"Proxy request failed: {e}")
            raise HTTPException(status_code=502, detail="Bad gateway") from e

    async def close(self) -> None:
        """Close the HTTP client"""
        await self.client.aclose()


# Global proxy service instance
proxy_service = ProxyService()


async def get_proxy_service() -> ProxyService:
    """Dependency to get the proxy service"""
    return proxy_service
