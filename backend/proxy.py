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
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=5.0),
            follow_redirects=True,
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
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
                if param in query_params:
                    logger.debug(
                        f"Stripping query parameter '{param}' from client request"
                    )
                query_params.pop(param, None)

        # Add API key as query parameter if configured
        if config.api_key and config.api_key_as_query_param:
            query_params[config.api_key_query_param_name] = config.api_key

        return query_params

    async def proxy_streaming_request(
        self,
        request: Request,
        path: str,
        config: ProxyConfig,
        body: bytes | None = None,
    ) -> StreamingResponse:
        """Proxy a streaming request to the target URL"""

        # If body wasn't passed in, read it from the request
        if body is None:
            body = await request.body()

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

        # Apply request transformer if configured
        if config.request_transformer is not None and body:
            transformer = cast(Callable[[bytes], bytes], config.request_transformer)
            try:
                body = transformer(body)
            except Exception as e:
                logger.error(f"Request transformation failed: {e}")
                raise HTTPException(
                    status_code=400, detail="Invalid request format"
                ) from e

        try:
            # Make the proxied request with streaming
            logger.info(f"Proxying streaming request to: {target_url}")

            async with self.client.stream(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
                follow_redirects=False,
            ) as proxied_response:
                # If the upstream returned an error status, forward the full body and status code
                if proxied_response.status_code >= 400:
                    error_body = await proxied_response.aread()
                    # Pass through original headers where it makes sense (content-type etc.)
                    headers_to_forward = {
                        k: v
                        for k, v in proxied_response.headers.items()
                        if k.lower() in {"content-type", "cache-control"}
                    }
                    return Response(
                        content=error_body,
                        status_code=proxied_response.status_code,
                        headers=headers_to_forward,
                    )

                # Otherwise stream the successful response downstream
                async def stream_response() -> Any:
                    async for chunk in proxied_response.aiter_bytes():
                        yield chunk

                return StreamingResponse(
                    stream_response(),
                    media_type="text/event-stream",
                    headers={
                        k: v
                        for k, v in proxied_response.headers.items()
                        if k.lower()
                        in {"content-type", "cache-control", "x-accel-buffering"}
                    },
                )

        except httpx.TimeoutException as e:
            raise HTTPException(status_code=504, detail="Gateway timeout") from e
        except httpx.RequestError as e:
            logger.error(f"Proxy streaming request failed: {e}")
            raise HTTPException(status_code=502, detail="Bad gateway") from e

    async def proxy_request(
        self, request: Request, path: str, config: ProxyConfig
    ) -> Response:
        """Proxy a request to the target URL"""

        # Read the request body once at the beginning
        body = await request.body()
        logger.info(f"[ProxyService] Proxying {request.method} request to path: {path}")
        logger.info(f"[ProxyService] Target URL base: {config.target_url}")
        logger.info(f"[ProxyService] Has API key: {'Yes' if config.api_key else 'No'}")

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

        # Use streaming proxy if needed
        if is_streaming:
            return await self.proxy_streaming_request(request, path, config, body)

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

        # Apply request transformer if configured
        if config.request_transformer is not None and body:
            transformer = cast(Callable[[bytes], bytes], config.request_transformer)
            try:
                body = transformer(body)
            except Exception as e:
                logger.error(f"Request transformation failed: {e}")
                raise HTTPException(
                    status_code=400, detail="Invalid request format"
                ) from e

        try:
            # Make the proxied request
            logger.info(f"[ProxyService] Full target URL: {target_url}")
            logger.info(f"[ProxyService] Request headers: {headers}")
            logger.info(f"[ProxyService] Body length: {len(body) if body else 0}")
            # Log request body for debugging
            if body:
                try:
                    body_str = body.decode("utf-8")
                    logger.info(f"[ProxyService] Request body: {body_str}")
                except Exception:
                    logger.info(
                        f"[ProxyService] Binary body (first 100 bytes): {body[:100]!r}"
                    )
            response = await self.client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=body,
                follow_redirects=False,
            )
            logger.info(f"[ProxyService] Response status: {response.status_code}")
            logger.info(f"[ProxyService] Response headers: {dict(response.headers)}")

            # Create response headers
            response_headers = dict(response.headers)

            # Debug logging for compression analysis
            logger.info(f"Original response headers: {response_headers}")
            content_encoding = response_headers.get("content-encoding", "").lower()
            logger.info(f"Response encoding: {content_encoding}")

            # Get response content
            content = response.read()

            # Check if decompression is needed based on content-encoding header
            # httpx may automatically decompress but not remove the content-encoding header
            if content_encoding:
                try:
                    if content_encoding in ["br", "brotli"]:
                        if HAS_BROTLI:
                            # Try to decompress - if it fails, content was already decompressed
                            try:
                                content = brotli.decompress(content)
                                logger.debug("Successfully decompressed brotli content")
                            except brotli.error:
                                # Content was already decompressed by httpx
                                logger.debug("Content already decompressed by httpx")
                        else:
                            raise HTTPException(
                                status_code=500,
                                detail="Server configuration error: brotli support not available",
                            )
                    elif content_encoding == "gzip":
                        try:
                            content = gzip.decompress(content)
                            logger.debug("Successfully decompressed gzip content")
                        except gzip.BadGzipFile:
                            # Content was already decompressed by httpx
                            logger.debug("Content already decompressed by httpx")
                    elif content_encoding == "deflate":
                        try:
                            content = zlib.decompress(content)
                            logger.debug("Successfully decompressed deflate content")
                        except zlib.error:
                            # Content was already decompressed by httpx
                            logger.debug("Content already decompressed by httpx")
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

            # Log for debugging
            logger.info(f"Response headers before cleanup: {response_headers}")
            logger.info(f"Response status: {response.status_code}")
            logger.info(
                f"Content type: {response_headers.get('content-type', 'unknown')}"
            )
            logger.info(f"Content length: {len(content)}")

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

                    # Log success
                    logger.info(
                        f"Successfully processed JSON response: {content[:100]!r}"
                    )
                except Exception as e:
                    # Log the error but continue with original content
                    logger.error(f"Error processing JSON content: {e}")

            # Set the correct content length
            response_headers["content-length"] = str(len(content))

            # For debugging: log first 200 chars if it's text content
            if "text/" in content_type or "application/json" in content_type:
                try:
                    content_preview = content.decode("utf-8")[:200]
                    logger.info(f"Content preview: {content_preview}")
                except Exception:
                    logger.info("Content is not valid UTF-8")

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
