import json
from contextlib import AsyncExitStack, asynccontextmanager
from functools import lru_cache
from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import Settings
from mcp_tools.server import mcp
from proxy import ProxyConfig, ProxyService, get_proxy_service


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


# Global whitelist of Thunderbolt-provided model names (provider-agnostic)
THUNDERBOLT_MODEL_WHITELIST = {
    "llama-v3p1-70b-instruct",
    "llama-v3p1-405b-instruct",
    "qwen3-235b-a22b",
    "qwen2p5-72b-instruct",
    # "deepseek-r1-0528", # @todo suffering from a bug where it just stops after awhile during reasoning when tool calling.
}


def create_model_transformer(prefix: str, check_prefix: str | None = None):
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
            import logging

            logging.getLogger(__name__).warning(f"Failed to transform model: {e}")
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

    # Add more proxy configurations as needed
    # proxy_service.register_proxy("/proxy/another-api", ProxyConfig(...))

    yield

    # Shutdown
    await proxy_service.close()


# Create MCP app instance at module level so it can be reused
mcp_app = mcp.http_app(path="/")


@asynccontextmanager
async def combined_lifespan(app: FastAPI) -> Any:
    """Combined lifespan manager for both proxy service and MCP app."""
    exit_stack = AsyncExitStack()
    async with exit_stack:
        # Enter the proxy lifespan
        await exit_stack.enter_async_context(proxy_lifespan(app))

        # Enter the MCP app lifespan
        if hasattr(mcp_app, "lifespan") and mcp_app.lifespan:
            await exit_stack.enter_async_context(mcp_app.lifespan(app))

        yield


# Create FastAPI app instance
app = FastAPI(
    title="Thunderbolt Backend",
    description="A FastAPI backend with proxy capabilities",
    version="0.1.0",
    lifespan=combined_lifespan,
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["mcp-session-id"],  # Expose the mcp-session-id header to clients
)


app.mount("/mcp", mcp_app)


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
