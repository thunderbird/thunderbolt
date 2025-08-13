import json
import logging
import time
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from config import Settings
from flower_auth import get_flower_api_key


def get_settings() -> Settings:
    """Get settings instance."""
    return Settings()


def utc_now() -> str:
    """Return current UTC time as RFC3339 with a trailing Z."""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


# Health check configurations for different models
HEALTH_CHECK_CONFIGS = {
    "qwen/qwen3-235b": {
        "prompt": 'Hello, this is a healthcheck, please respond with the exact string "Healthcheck confirmed."',
        "expected_response": "Healthcheck confirmed.",
        "timeout": 15.0,
    },
    # Add more models here as needed
}

# Default health check configuration for any model not specifically configured
DEFAULT_HEALTH_CHECK_CONFIG = {
    "prompt": 'Hello, this is a healthcheck, please respond with the exact string "Healthcheck confirmed."',
    "expected_response": "Healthcheck confirmed.",
    "timeout": 15.0,
}

router = APIRouter(prefix="/healthcheck", tags=["healthcheck"])


async def validate_monitoring_token(token: str = Query(..., alias="token")) -> None:
    """Validate the monitoring token from query parameters.

    Args:
        token: The monitoring token provided as a query parameter

    Raises:
        HTTPException: If token is invalid or health checks not configured
    """
    settings = get_settings()
    if not settings.monitoring_token:
        raise HTTPException(status_code=503, detail="Health check not configured")

    if token != settings.monitoring_token:
        raise HTTPException(status_code=401, detail="Invalid monitoring token")


@router.get("/flower/{model:path}")
async def health_check_flower_model(
    model: str,
    request: Request,
    _: None = Depends(validate_monitoring_token),
) -> JSONResponse:
    """Health check endpoint for Flower AI models with streaming validation.

    Makes a streaming request to the Flower AI service and validates that the response
    matches exactly what we expect. This enables monitoring services like Betterstack
    to track latency, uptime, and service health.

    Args:
        model: The model name to test (e.g., "qwen3")
        request: FastAPI request object
        _: Validated monitoring token dependency

    Returns:
        JSONResponse with health check results including latency and validation status
    """
    logger = logging.getLogger(__name__)
    start_time = time.time()
    timestamp = utc_now()
    settings = get_settings()

    # Get model configuration (use default if not specifically configured)
    config = HEALTH_CHECK_CONFIGS.get(model, DEFAULT_HEALTH_CHECK_CONFIG)

    # Early return if Flower AI not configured
    if not settings.flower_mgmt_key or not settings.flower_proj_id:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "model": model,
                "service": "flower",
                "timestamp": timestamp,
                "error": "Flower AI not configured",
                "latency_ms": round((time.time() - start_time) * 1000, 2),
                "response": None,
            },
        )

    try:
        # Get Flower API key using existing auth system
        user_agent = request.headers.get("user-agent", "healthcheck")
        client_ip = "healthcheck"
        if request.client is not None:
            client_ip = getattr(request.client, "host", "healthcheck")
        user_id_hash = f"{user_agent}:{client_ip}"

        api_key = get_flower_api_key(user_id_hash, settings=settings)

        # Build the request payload
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": config["prompt"],
                }
            ],
            "stream": True,
            "max_tokens": 50,
            "temperature": 0.0,  # Deterministic responses for reliable testing
        }

        # Make streaming request to Flower AI
        target_url = "https://api.flower.ai/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "Thunderbolt-HealthCheck/1.0",
        }

        async with httpx.AsyncClient(timeout=config["timeout"]) as client:
            response = await client.post(
                target_url,
                headers=headers,
                json=payload,
                timeout=config["timeout"],
            )
            response.raise_for_status()

            # Collect streaming response content
            collected_content = ""

            async for line in response.aiter_lines():
                if not line:
                    continue

                # Handle different streaming formats
                if line.startswith("data: "):
                    data_str = line[6:]  # Remove "data: " prefix
                elif line.startswith("data:"):
                    data_str = line[5:]  # Remove "data:" prefix
                else:
                    # Some services might not prefix with "data:"
                    data_str = line

                data_str = data_str.strip()
                if data_str == "[DONE]":
                    break

                if not data_str:
                    continue

                try:
                    data = json.loads(data_str)

                    if "choices" in data and len(data["choices"]) > 0:
                        choice = data["choices"][0]
                        delta = choice.get("delta", {})
                        content = delta.get("content", "")

                        # Also check for non-delta format
                        if not content and "text" in choice:
                            content = choice["text"]

                        # Also check for message content format
                        if not content and "message" in choice:
                            message = choice["message"]
                            content = message.get("content", "")

                        if content:
                            collected_content += content
                except json.JSONDecodeError:
                    continue

            # Calculate final latency
            latency_ms = round((time.time() - start_time) * 1000, 2)

            # Validate response matches exactly what we expect
            expected = config["expected_response"]
            actual = collected_content.strip()

            if actual == expected:
                return JSONResponse(
                    status_code=200,
                    content={
                        "ok": True,
                        "model": model,
                        "service": "flower",
                        "latency_ms": latency_ms,
                        "timestamp": timestamp,
                        "response": actual,
                        "error": None,
                    },
                )
            else:
                return JSONResponse(
                    status_code=503,
                    content={
                        "ok": False,
                        "model": model,
                        "service": "flower",
                        "latency_ms": latency_ms,
                        "timestamp": timestamp,
                        "response": actual,
                        "error": f"Response mismatch: expected '{expected}' but got '{actual}'",
                    },
                )

    except httpx.TimeoutException:
        latency_ms = round((time.time() - start_time) * 1000, 2)
        logger.error(f"Health check timeout for {model}")
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "model": model,
                "service": "flower",
                "latency_ms": latency_ms,
                "timestamp": timestamp,
                "error": f"Request timeout after {config['timeout']}s",
                "response": None,
            },
        )
    except httpx.HTTPStatusError as e:
        latency_ms = round((time.time() - start_time) * 1000, 2)
        logger.error(f"Health check HTTP error for {model}: {e.response.status_code}")

        # Handle model not allowed errors specifically
        error_message = f"HTTP {e.response.status_code}: {e.response.text}"
        try:
            error_data = e.response.json()
            if "detail" in error_data:
                detail = error_data["detail"]
                if isinstance(detail, dict) and detail.get("code") == "40001":
                    error_message = f"Model '{model}' is not available in your Flower AI project. Please check your project configuration or use a different model name."
                elif isinstance(detail, str):
                    error_message = detail
        except Exception:
            pass

        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "model": model,
                "service": "flower",
                "latency_ms": latency_ms,
                "timestamp": timestamp,
                "error": error_message,
                "response": None,
            },
        )
    except Exception as e:
        latency_ms = round((time.time() - start_time) * 1000, 2)
        logger.error(f"Health check failed for {model}: {str(e)}", exc_info=True)
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "model": model,
                "service": "flower",
                "latency_ms": latency_ms,
                "timestamp": timestamp,
                "error": str(e),
                "response": None,
            },
        )


@router.get("/status")
async def health_check_status(
    _: None = Depends(validate_monitoring_token),
) -> JSONResponse:
    """Get the status of available health check endpoints.

    Returns information about which models and services are configured
    for health checking.

    Args:
        _: Validated monitoring token dependency

    Returns:
        JSONResponse with available health check configurations
    """
    settings = get_settings()

    # Check service availability
    services = {
        "flower": {
            "available": bool(settings.flower_mgmt_key and settings.flower_proj_id),
            "models": list(HEALTH_CHECK_CONFIGS.keys())
            if settings.flower_mgmt_key and settings.flower_proj_id
            else [],
        }
    }

    return JSONResponse(
        status_code=200,
        content={
            "timestamp": utc_now(),
            "services": services,
            "total_endpoints": sum(
                len(service["models"]) for service in services.values()
            ),
        },
    )
