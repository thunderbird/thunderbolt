import json
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import config
from auth import google_router, microsoft_router
from flower_auth import get_flower_api_key
from healthcheck import router as healthcheck_router
from pro.routes import create_pro_tools_app
from proxy import ProxyConfig, ProxyService, get_proxy_service
from request_utils import build_user_id_hash

# Global whitelist of Thunderbolt-provided model names (provider-agnostic)
THUNDERBOLT_MODEL_WHITELIST = {
    "qwen3-235b-a22b-instruct-2507",
    "qwen3-235b-a22b-thinking-2507",
    "kimi-k2-instruct",
    "deepseek-r1-0528",
    "qwen3-235b-a22b",
    "llama-v3p1-405b-instruct",
}


def create_model_transformer(
    prefix: str, check_prefix: str | None = None
) -> Callable[[bytes], bytes]:
    """Create a model transformer function for a specific provider.

    Args:
        prefix: The prefix to prepend to whitelisted model names
        check_prefix: Optional prefix to check if model already has full path

    Returns:
        A transformer function that processes request bodies
    """

    def transformer(body: bytes) -> bytes:
        """Transform model names in API requests.

        Only transforms whitelisted Thunderbolt models. Other models pass through unchanged.
        """
        logger = logging.getLogger(__name__)
        try:
            # Parse the JSON body
            data = json.loads(body.decode("utf-8"))

            # Check if there's a model field
            if "model" in data and isinstance(data["model"], str):
                model_name = data["model"]

                # Check if model needs transformation
                should_transform = model_name in THUNDERBOLT_MODEL_WHITELIST

                # If check_prefix is provided, also check that model doesn't already have it
                if check_prefix and model_name.startswith(check_prefix):
                    should_transform = False

                if should_transform:
                    # Prepend the prefix for whitelisted models
                    data["model"] = f"{prefix}{model_name}"

            # Return the modified JSON as bytes
            return json.dumps(data).encode("utf-8")

        except Exception as e:
            # If transformation fails, return original body
            logger.warning(f"Model transformation failed: {e}")
            return body

    return transformer


@asynccontextmanager
async def proxy_lifespan(app: FastAPI) -> Any:
    """Proxy service lifespan manager."""
    # Startup
    settings = get_settings()
    proxy_service = await get_proxy_service()

    # Register proxy configurations

    # Fireworks OpenAI-compatible proxy
    if settings.fireworks_api_key:
        proxy_service.register_proxy(
            "/openai",
            ProxyConfig(
                target_url="https://api.fireworks.ai/inference/v1",
                api_key=settings.fireworks_api_key,
                api_key_header="Authorization",
                api_key_as_query_param=False,
                require_auth=False,  # Frontend doesn't need to authenticate
                supports_streaming=True,  # Enable streaming support
                request_transformer=create_model_transformer(
                    prefix="accounts/fireworks/models/", check_prefix="accounts/"
                ),  # Transform model names
            ),
        )

    # Flower AI proxy
    if settings.flower_mgmt_key and settings.flower_proj_id:
        proxy_service.register_proxy(
            "/flower",
            ProxyConfig(
                target_url="https://api.flower.ai",
                api_key="",  # Will be set dynamically per request
                api_key_header="Authorization",
                api_key_as_query_param=False,
                require_auth=False,  # Allow preflight requests
                supports_streaming=True,  # Enable streaming support
            ),
        )

    # PostHog Analytics proxy
    proxy_service.register_proxy(
        "/posthog",
        ProxyConfig(
            target_url=settings.posthog_host,
            api_key="",  # No API key needed for PostHog client-side tracking
            api_key_header="Authorization",
            api_key_as_query_param=False,
            require_auth=False,  # Allow public access for analytics
            supports_streaming=False,  # PostHog doesn't use streaming
        ),
    )

    # Add more proxy configurations as needed
    # proxy_service.register_proxy("/proxy/another-api", ProxyConfig(...))

    yield

    # Shutdown
    await proxy_service.close()


pro_tools_app = create_pro_tools_app()

# Expose get_settings for tests and internal use
get_settings = config.get_settings

logging.basicConfig(
    level=getattr(logging, get_settings().log_level),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

app = FastAPI(
    title="Thunderbolt Backend",
    description="A FastAPI backend with proxy capabilities",
    version="0.1.0",
    lifespan=proxy_lifespan,
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=settings.cors_origin_regex
    if settings.cors_origin_regex
    else None,
    allow_origins=settings.cors_origins_list if not settings.cors_origin_regex else [],
    allow_credentials=settings.cors_allow_credentials,
    allow_methods=settings.cors_methods_list,
    allow_headers=["*"]
    if settings.cors_allow_headers == "*"
    else [settings.cors_allow_headers],
    expose_headers=[settings.cors_expose_headers]
    if settings.cors_expose_headers
    else [],
)

app.mount("/pro", pro_tools_app)


@app.get("/health", response_model=dict[str, str])
async def health() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/locations")
async def search_locations(query: str) -> Any:
    """Search for locations using Open-Meteo geocoding API."""
    if not query:
        raise HTTPException(status_code=400, detail="Query parameter is required")

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": query, "count": 10, "language": "en", "format": "json"},
            )
            response.raise_for_status()
            data = response.json()

            # Transform to match the frontend's expected format
            results = []
            for location in data.get("results", []):
                results.append(
                    {
                        "name": location.get("name", ""),
                        "region": location.get("admin1", ""),  # State/Province
                        "country": location.get("country", ""),
                        "lat": location.get("latitude", 0),
                        "lon": location.get(
                            "longitude", 0
                        ),  # Frontend expects 'lon' not 'lng'
                    }
                )

            return results

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 400:
                raise HTTPException(
                    status_code=400, detail="Invalid search query"
                ) from e
            else:
                raise HTTPException(
                    status_code=503, detail="Geocoding service unavailable"
                ) from e
        except httpx.RequestError as e:
            raise HTTPException(
                status_code=503, detail="Geocoding service unavailable"
            ) from e


@app.post("/flower/api-key")
async def get_flower_api_key_endpoint(request: Request) -> dict[str, str]:
    """Get a Flower API key for the authenticated user."""
    settings = get_settings()

    if not settings.flower_mgmt_key or not settings.flower_proj_id:
        raise HTTPException(status_code=503, detail="Flower AI not configured")

    # Derive a stable, non-PII user identifier for per-user API keys
    user_id_hash = build_user_id_hash(request, fallback="unknown")

    try:
        api_key = get_flower_api_key(user_id_hash, settings=settings)
        return {"api_key": api_key}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get Flower API key: {str(e)}"
        ) from e


# Flower AI proxy endpoints
@app.api_route(
    "/flower/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    include_in_schema=False,  # Hide from OpenAPI schema as it's a proxy
)
async def flower_proxy_endpoint(
    path: str,
    request: Request,
    proxy_service: ProxyService = Depends(get_proxy_service),
) -> Any:
    """Flower AI proxy endpoint."""
    logger = logging.getLogger(__name__)

    # Handle OPTIONS preflight requests
    if request.method == "OPTIONS":
        return JSONResponse({"status": "ok"})

    # Get the configuration for this path
    config = proxy_service.get_config("/flower")
    if not config:
        logger.error("Flower AI proxy not configured")
        raise HTTPException(status_code=404, detail="Flower AI proxy not configured")

    # Handle body consumption for POST requests
    if request.method == "POST":
        body = await request.body()
        # Store the body so it can be read again by the proxy
        # Note: This is a workaround for FastAPI's request body consumption
        request._body = body  # type: ignore[attr-defined]

    # Don't override the API key in config - the proxy will pass through existing headers
    config.api_key = ""

    # Use the unified proxy method
    try:
        return await proxy_service.proxy_request(request, path, config)
    except Exception as e:
        logger.error(f"Flower proxy request failed: {str(e)}", exc_info=True)
        raise


# OpenAI-compatible endpoints
@app.api_route(
    "/openai/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    include_in_schema=False,  # Hide from OpenAPI schema as it's a proxy
)
async def openai_proxy_endpoint(
    path: str,
    request: Request,
    proxy_service: ProxyService = Depends(get_proxy_service),
) -> Any:
    """OpenAI-compatible proxy endpoint."""
    # Handle OPTIONS preflight requests
    if request.method == "OPTIONS":
        return JSONResponse({"status": "ok"})

    # Get the configuration for this path
    config = proxy_service.get_config("/openai")
    if not config:
        raise HTTPException(status_code=404, detail="OpenAI proxy not configured")

    # No auth required for this endpoint - it's handled by the proxy
    # Proxy the request
    return await proxy_service.proxy_request(request, path, config)


# PostHog Analytics proxy endpoint
@app.api_route(
    "/posthog/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    include_in_schema=False,  # Hide from OpenAPI schema as it's a proxy
)
async def posthog_proxy_endpoint(
    path: str,
    request: Request,
    proxy_service: ProxyService = Depends(get_proxy_service),
) -> Any:
    """PostHog Analytics proxy endpoint."""
    # Handle OPTIONS preflight requests
    if request.method == "OPTIONS":
        return JSONResponse({"status": "ok"})

    # Get the configuration for this path
    config = proxy_service.get_config("/posthog")
    if not config:
        raise HTTPException(status_code=404, detail="PostHog proxy not configured")

    # No auth required for this endpoint - it's handled by the proxy
    # Proxy the request
    response = await proxy_service.proxy_request(request, path, config)

    # Fix CORS headers for browser compatibility
    if hasattr(response, "headers"):
        # Remove any problematic headers
        headers_to_remove = []
        for key in response.headers:
            key_lower = key.lower()
            if key_lower in [
                "cross-origin-resource-policy",
                "cross-origin-embedder-policy",
                "cross-origin-opener-policy",
            ]:
                headers_to_remove.append(key)

        for key in headers_to_remove:
            del response.headers[key]

        # Add browser-friendly CORS headers
        response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "unsafe-none"
        response.headers["Cross-Origin-Opener-Policy"] = "unsafe-none"

    return response


@app.api_route(
    "/proxy/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    include_in_schema=False,  # Hide from OpenAPI schema as it's a proxy
)
async def proxy_endpoint(
    path: str,
    request: Request,
    proxy_service: ProxyService = Depends(get_proxy_service),
) -> Any:
    """Generic proxy endpoint that routes based on path."""
    # Handle OPTIONS preflight requests
    if request.method == "OPTIONS":
        return JSONResponse({"status": "ok"})

    # Get the configuration for this path
    config = proxy_service.get_config(f"/proxy/{path}")
    if not config:
        raise HTTPException(status_code=404, detail="Proxy path not configured")

    # Verify authentication if required
    if config.require_auth and not await proxy_service.verify_auth(request):
        raise HTTPException(status_code=401, detail="Unauthorized")

    # Remove the proxy prefix from the path
    # Extract the actual path after the service name
    service_prefix = None
    for prefix in proxy_service.configs:
        if f"/proxy/{path}".startswith(prefix):
            service_prefix = prefix
            break

    if service_prefix:
        actual_path = path[len(service_prefix.replace("/proxy/", "")) :]
        actual_path = actual_path.lstrip("/")
    else:
        actual_path = path

    # Proxy the request
    return await proxy_service.proxy_request(request, actual_path, config)


# ---------------------------------------------------------------------------
# Authentication routers (/auth/google/*, /auth/microsoft/*)
# ---------------------------------------------------------------------------


app.include_router(google_router)
app.include_router(microsoft_router)
app.include_router(healthcheck_router)


# ---------------------------------------------------------------------------
# Analytics configuration endpoint
# ---------------------------------------------------------------------------
analytics_router = APIRouter(prefix="/analytics", tags=["analytics"])


@analytics_router.get("/config")
async def analytics_config() -> dict[str, str]:
    """Return public analytics configuration for the frontend.

    Exposes only non-sensitive values required for client initialization.
    """
    settings = get_settings()
    return {
        "posthog_api_key": settings.posthog_api_key,
    }


app.include_router(analytics_router)

# Re-export for tests that import from main
get_settings = config.get_settings
